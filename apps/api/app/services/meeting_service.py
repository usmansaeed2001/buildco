"""Meetings: scheduling, Google Meet conferences, attendees, and calendar invites."""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.errors import Forbidden, NotFound, ValidationFailed
from app.logging import get_logger
from app.models.enums import ELEVATED_ROLES, MeetingScope, Role
from app.models.meeting import Meeting, MeetingAttendee
from app.models.profile import Profile
from app.services.integrations import calendar
from app.services.integrations.calendar import IcsAttendee
from app.services.rules import meeting_rules

log = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class InviteBundle:
    """Everything the router needs to send invites, computed once.

    Built while the session is still open so the router's background task does not
    have to touch the database again.
    """

    recipients: list[str]
    ics: str
    ics_filename: str
    context: dict[str, Any]


async def _resolve_attendees(session: AsyncSession, attendee_ids: list[uuid.UUID]) -> list[Profile]:
    if not attendee_ids:
        return []
    rows = await session.scalars(select(Profile).where(Profile.id.in_(attendee_ids)))
    return list(rows)


def _normalise_emails(emails: Iterable[str]) -> list[str]:
    """Lower-cased, trimmed and de-duplicated, keeping the order they were given in."""
    seen: dict[str, None] = {}
    for raw in emails:
        email = raw.strip().lower()
        if email:
            seen.setdefault(email, None)
    return list(seen)


async def _resolve_invitees(
    session: AsyncSession, attendee_ids: list[uuid.UUID], attendee_emails: Iterable[str]
) -> tuple[list[Profile], list[str]]:
    """Split a requested attendee list into team members and outside guests.

    An address that belongs to someone on the team is promoted to a member attendee
    rather than kept as a guest. Typing a colleague's email instead of ticking their name
    should not produce a second-class invite: as a guest row they would get the email
    but the meeting would be invisible to them in the app, since visibility is decided
    by ``user_id``. It also keeps one person from being invited twice.
    """
    members = {p.id: p for p in await _resolve_attendees(session, attendee_ids)}
    guests: list[str] = []

    emails = _normalise_emails(attendee_emails)
    if emails:
        known = await session.scalars(select(Profile).where(func.lower(Profile.email).in_(emails)))
        by_email = {p.email.lower(): p for p in known}
        for email in emails:
            profile = by_email.get(email)
            if profile is None:
                guests.append(email)
            else:
                members.setdefault(profile.id, profile)

    return list(members.values()), guests


def _attendee_rows(members: list[Profile], guests: list[str]) -> list[MeetingAttendee]:
    """Build the rows for a meeting's attendee list.

    ``profile`` is set on every row, ``None`` included: selectin loaders run on a query
    and these objects have not been queried, so serialising one would otherwise
    lazy-load from async context.
    """
    rows = [
        MeetingAttendee(user_id=p.id, email=p.email, name=p.display_name, profile=p)
        for p in members
    ]
    rows.extend(
        MeetingAttendee(user_id=None, email=email, name="", profile=None) for email in guests
    )
    return rows


def _as_utc(value: datetime) -> datetime:
    """Make a datetime comparable regardless of where it came from.

    Columns are ``DateTime(timezone=True)``, so Postgres hands back an aware value —
    but SQLite, which the test suite runs on by default, has no timezone type and
    returns a naive one. Comparing the two raises ``TypeError: can't compare
    offset-naive and offset-aware datetimes``, so a check written against Postgres
    behaviour crashes under SQLite and vice versa.

    Everything is stored as UTC (``datetime.now(UTC)`` throughout), so attaching UTC to
    a naive value recovers the instant rather than guessing at one.
    """
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def _ics_uid(meeting_id: uuid.UUID) -> str:
    """Stable across a meeting's whole life, so updates replace rather than duplicate."""
    return f"{meeting_id}@buildco"


def _format_window(start: datetime, end: datetime) -> str:
    # An en dash reads better than a hyphen in a date range, so it is spelled by
    # codepoint to keep the linter's ambiguous-character check quiet.
    en_dash = chr(0x2013)  # en dash
    return f"{start.strftime('%A, %d %B %Y at %H:%M')} {en_dash} {end.strftime('%H:%M')} UTC"


def _build_bundle(
    meeting: Meeting,
    organiser: Profile,
    *,
    cancelled: bool = False,
    updated: bool = False,
    sequence: int = 0,
) -> InviteBundle:
    """Prepare the invite for everyone on the meeting — team members and guests alike.

    Addressed from the attendee rows' own ``email`` and ``name`` rather than from
    ``profiles``: a guest has no profile at all, and going through the profile is how
    updates and cancellations would skip anyone who was not a team member.
    """
    settings = get_settings()
    attendees = [a for a in meeting.attendees if a.email]
    ics = calendar.build_ics(
        event_uid=_ics_uid(meeting.id),
        title=meeting.title,
        description=meeting.description,
        location=meeting.location,
        start_time=meeting.start_time,
        end_time=meeting.end_time,
        organiser_email=settings.notify_from_email,
        attendees=[IcsAttendee(email=a.email, name=a.name) for a in attendees],
        meet_link=meeting.meet_link,
        cancelled=cancelled,
        sequence=sequence,
    )
    safe_title = (
        "".join(c if c.isalnum() or c in "-_" else "-" for c in meeting.title).strip("-")
        or "meeting"
    )

    return InviteBundle(
        recipients=[a.email for a in attendees],
        ics=ics,
        ics_filename=f"{safe_title}{'-cancelled' if cancelled else ''}.ics",
        context={
            "title": meeting.title,
            "description": meeting.description,
            "location": meeting.location,
            "when": _format_window(meeting.start_time, meeting.end_time),
            "organiser": organiser.display_name,
            "meet_link": meeting.meet_link,
            "color": meeting.color,
            "updated": updated,
        },
    )


# ── Reads ─────────────────────────────────────────────────────────────────────


async def list_meetings(
    session: AsyncSession,
    actor: Profile,
    *,
    scope: MeetingScope = MeetingScope.ALL,
    start_after: datetime | None = None,
    start_before: datetime | None = None,
    project_id: uuid.UUID | None = None,
    limit: int = 200,
    offset: int = 0,
) -> list[Meeting]:
    """Meetings in ascending time order, windowed and scoped for a calendar view.

    **This used to return the whole team's calendar to everyone, deliberately.** It no
    longer does: a meeting now reaches a non-elevated user only if they created it or
    were invited to it. If you are here because the docstring you remember said the
    opposite, that was true until the visibility filter was added — do not "fix" it back.

    ``scope=all`` is honoured for owners and admins. For anyone else it is *clamped* to
    the union of mine-and-invited rather than refused, which is what
    ``project_service.list_projects`` already does for a member asking for every project.
    A stale client bundle then narrows safely instead of turning the calendar into an
    error page.

    ``ALL`` is the default for the same reason: an elevated caller that sends no scope
    gets exactly the old behaviour, and a non-elevated one that sends none is clamped
    anyway — so omitting the parameter can never leak. Defaulting to ``MINE`` would be
    worse, not safer: a member cannot create meetings they are not also invited to in
    every normal flow, so the unset case would render an empty calendar and look broken.
    """
    conditions = []
    if start_after is not None:
        conditions.append(Meeting.start_time >= start_after)
    if start_before is not None:
        conditions.append(Meeting.start_time <= start_before)
    if project_id is not None:
        conditions.append(Meeting.project_id == project_id)

    mine = Meeting.created_by == actor.id
    invited = Meeting.id.in_(
        select(MeetingAttendee.meeting_id).where(MeetingAttendee.user_id == actor.id)
    )
    if scope is MeetingScope.MINE:
        conditions.append(mine)
    elif scope is MeetingScope.INVITED:
        conditions.append(invited)
    elif Role(actor.role) not in ELEVATED_ROLES:
        conditions.append(or_(mine, invited))

    rows = await session.scalars(
        select(Meeting).where(*conditions).order_by(Meeting.start_time).limit(limit).offset(offset)
    )
    return list(rows)


def _snapshot(meeting: Meeting) -> meeting_rules.MeetingSnapshot:
    return meeting_rules.MeetingSnapshot(
        created_by=meeting.created_by,
        attendee_ids=frozenset(a.user_id for a in meeting.attendees if a.user_id is not None),
    )


def _actor(profile: Profile) -> meeting_rules.ActorSnapshot:
    return meeting_rules.ActorSnapshot(id=profile.id, role=Role(profile.role))


async def get_meeting(session: AsyncSession, actor: Profile, meeting_id: uuid.UUID) -> Meeting:
    """Load a meeting the actor is allowed to see.

    A meeting they may not see is a **404, not a 403**: its existence is itself
    privileged, and 403 would confirm that a meeting with that id exists. Same rule, and
    the same reasoning, as ``deps.require_project_access``.

    ``attendees`` is ``lazy="selectin"``, so the membership check costs no extra query.
    """
    meeting = await session.get(Meeting, meeting_id)
    if meeting is None:
        raise NotFound("Meeting not found.")
    if not meeting_rules.can_view(_actor(actor), _snapshot(meeting)):
        raise NotFound("Meeting not found.")
    return meeting


def require_manageable(actor: Profile, meeting: Meeting) -> None:
    """Guard editing and cancelling.

    403 here, not 404, and the difference is deliberate: the caller has already passed
    ``get_meeting``, so they can legitimately see this meeting — they were invited to
    it. They simply may not move it. Hiding it at this point would be a lie about
    something they are looking at.
    """
    if not meeting_rules.can_manage(_actor(actor), _snapshot(meeting)):
        raise Forbidden("You can only change meetings you created.")


# ── Writes ────────────────────────────────────────────────────────────────────


async def create_meeting(
    session: AsyncSession,
    actor: Profile,
    *,
    data: dict[str, Any],
    attendee_ids: list[uuid.UUID],
    attendee_emails: list[str] | None = None,
    google_access_token: str | None,
) -> tuple[Meeting, InviteBundle]:
    """Create a meeting, attach a Meet conference if possible, and prepare invites.

    A failure to create the Meet link does not fail the meeting — ``create_meet_event``
    returns empty fields and the invite simply goes out without a video link.

    ``attendee_emails`` invites people outside the team. They are recorded as attendee
    rows with no ``user_id`` and are emailed exactly as members are.
    """
    event = await calendar.create_meet_event(
        access_token=google_access_token,
        title=data["title"],
        description=data.get("description", ""),
        location=data.get("location", ""),
        start_time=data["start_time"],
        end_time=data["end_time"],
    )

    meeting = Meeting(
        created_by=actor.id,
        # Eager: selectin loaders run on a query, and this object has not been
        # queried. Serialising it would otherwise lazy-load from async context.
        creator=actor,
        attendees=[],
        meet_link=event.meet_link,
        google_event_id=event.google_event_id,
        **data,
    )
    session.add(meeting)
    await session.flush()

    members, guests = await _resolve_invitees(session, attendee_ids, attendee_emails or [])
    meeting.attendees.extend(_attendee_rows(members, guests))
    await session.flush()

    log.info(
        "meeting_created",
        meeting_id=str(meeting.id),
        attendees=len(members),
        guests=len(guests),
        has_meet_link=bool(event.meet_link),
    )
    return meeting, _build_bundle(meeting, actor)


async def update_meeting(
    session: AsyncSession,
    actor: Profile,
    meeting: Meeting,
    *,
    changes: dict[str, Any],
    attendee_ids: list[uuid.UUID] | None,
    attendee_emails: list[str] | None = None,
) -> tuple[Meeting, InviteBundle | None]:
    """Update a meeting, re-inviting attendees when something they care about moved.

    Invites are re-sent only when the time, location, or attendee list changed.
    Renaming a meeting or recolouring it does not email everybody — the legacy code
    re-sent on every update that touched attendees at all, which trained people to
    ignore the invites.

    ``attendee_ids`` (team members) and ``attendee_emails`` (outside guests) are
    independent partials: ``None`` leaves that half of the list as it is. The list only
    counts as changed when the people on it differ, so re-sending the same addresses in
    a different order or case emails nobody.
    """
    invite_worthy = {"start_time", "end_time", "location", "title"}
    changed_fields = {field for field, value in changes.items() if getattr(meeting, field) != value}

    # ``MeetingCreate`` validates this in the schema, but ``MeetingUpdate`` cannot: it is
    # a partial, so a request carrying only ``end_time`` has nothing to compare against
    # until the stored ``start_time`` is in hand. Without this, patching one end alone
    # stores a meeting that finishes before it begins — which then renders as a negative
    # duration and produces an ICS that Outlook rejects outright.
    start = _as_utc(changes.get("start_time", meeting.start_time))
    end = _as_utc(changes.get("end_time", meeting.end_time))
    if end <= start:
        raise ValidationFailed("end_time must be after start_time")

    for field, value in changes.items():
        setattr(meeting, field, value)

    attendees_changed = False
    if attendee_ids is not None or attendee_emails is not None:
        existing = list(
            await session.scalars(
                select(MeetingAttendee).where(MeetingAttendee.meeting_id == meeting.id)
            )
        )
        existing_ids = [a.user_id for a in existing if a.user_id is not None]
        existing_guests = [a.email for a in existing if a.user_id is None]
        members, guests = await _resolve_invitees(
            session,
            attendee_ids if attendee_ids is not None else existing_ids,
            attendee_emails if attendee_emails is not None else existing_guests,
        )
        same_members = {p.id for p in members} == set(existing_ids)
        same_guests = set(guests) == set(_normalise_emails(existing_guests))
        if not (same_members and same_guests):
            attendees_changed = True
            # Deleted and flushed before the replacements go in: a member who stays on
            # the list would otherwise collide with their own outgoing row on
            # ``uq_meeting_attendee``, since a flush writes inserts ahead of deletes.
            for row in existing:
                await session.delete(row)
            await session.flush()
            meeting.attendees.extend(_attendee_rows(members, guests))

    await session.flush()
    await session.refresh(meeting)

    if not (changed_fields & invite_worthy or attendees_changed):
        return meeting, None

    # SEQUENCE must increase for calendar clients to accept the revision. Seconds
    # since the meeting row was created gives a monotonic value without another column.
    sequence = max(1, int((meeting.updated_at - meeting.created_at).total_seconds()))

    log.info("meeting_updated", meeting_id=str(meeting.id), reinvited=len(meeting.attendees))
    return meeting, _build_bundle(meeting, actor, updated=True, sequence=sequence)


async def delete_meeting(
    session: AsyncSession,
    actor: Profile,
    meeting: Meeting,
    *,
    google_access_token: str | None = None,
) -> InviteBundle:
    """Cancel a meeting.

    The cancellation bundle is built *before* the row is deleted, since it needs the
    attendee list and the event details that are about to disappear.
    """
    sequence = max(1, int((meeting.updated_at - meeting.created_at).total_seconds()) + 1)
    bundle = _build_bundle(meeting, actor, cancelled=True, sequence=sequence)

    await calendar.delete_event(google_access_token, meeting.google_event_id)

    meeting_id = meeting.id
    await session.delete(meeting)
    await session.flush()

    log.info("meeting_deleted", meeting_id=str(meeting_id))
    return bundle
