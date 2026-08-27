"""Meetings: scheduling, Google Meet conferences, attendees, and calendar invites."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.errors import NotFound, ValidationFailed
from app.logging import get_logger
from app.models.meeting import Meeting, MeetingAttendee
from app.models.profile import Profile
from app.services.integrations import calendar
from app.services.integrations.calendar import IcsAttendee

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
    attendees: list[Profile],
    organiser: Profile,
    *,
    cancelled: bool = False,
    updated: bool = False,
    sequence: int = 0,
) -> InviteBundle:
    settings = get_settings()
    ics = calendar.build_ics(
        event_uid=_ics_uid(meeting.id),
        title=meeting.title,
        description=meeting.description,
        location=meeting.location,
        start_time=meeting.start_time,
        end_time=meeting.end_time,
        organiser_email=settings.notify_from_email,
        attendees=[IcsAttendee(email=a.email, name=a.display_name) for a in attendees],
        meet_link=meeting.meet_link,
        cancelled=cancelled,
        sequence=sequence,
    )
    safe_title = (
        "".join(c if c.isalnum() or c in "-_" else "-" for c in meeting.title).strip("-")
        or "meeting"
    )

    return InviteBundle(
        recipients=[a.email for a in attendees if a.email],
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
    *,
    start_after: datetime | None = None,
    start_before: datetime | None = None,
    project_id: uuid.UUID | None = None,
    limit: int = 200,
    offset: int = 0,
) -> list[Meeting]:
    """Meetings in ascending time order, optionally windowed for a calendar view.

    Not filtered by role: the team calendar is shared, and a member needs to see the
    meetings around their own to make sense of the week.
    """
    conditions = []
    if start_after is not None:
        conditions.append(Meeting.start_time >= start_after)
    if start_before is not None:
        conditions.append(Meeting.start_time <= start_before)
    if project_id is not None:
        conditions.append(Meeting.project_id == project_id)

    rows = await session.scalars(
        select(Meeting).where(*conditions).order_by(Meeting.start_time).limit(limit).offset(offset)
    )
    return list(rows)


async def get_meeting(session: AsyncSession, meeting_id: uuid.UUID) -> Meeting:
    meeting = await session.get(Meeting, meeting_id)
    if meeting is None:
        raise NotFound("Meeting not found.")
    return meeting


# ── Writes ────────────────────────────────────────────────────────────────────


async def create_meeting(
    session: AsyncSession,
    actor: Profile,
    *,
    data: dict[str, Any],
    attendee_ids: list[uuid.UUID],
    google_access_token: str | None,
) -> tuple[Meeting, InviteBundle]:
    """Create a meeting, attach a Meet conference if possible, and prepare invites.

    A failure to create the Meet link does not fail the meeting — ``create_meet_event``
    returns empty fields and the invite simply goes out without a video link.
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

    attendees = await _resolve_attendees(session, attendee_ids)
    for profile in attendees:
        meeting.attendees.append(
            MeetingAttendee(
                user_id=profile.id,
                email=profile.email,
                name=profile.display_name,
                profile=profile,
            )
        )
    await session.flush()

    log.info(
        "meeting_created",
        meeting_id=str(meeting.id),
        attendees=len(attendees),
        has_meet_link=bool(event.meet_link),
    )
    return meeting, _build_bundle(meeting, attendees, actor)


async def update_meeting(
    session: AsyncSession,
    actor: Profile,
    meeting: Meeting,
    *,
    changes: dict[str, Any],
    attendee_ids: list[uuid.UUID] | None,
) -> tuple[Meeting, InviteBundle | None]:
    """Update a meeting, re-inviting attendees when something they care about moved.

    Invites are re-sent only when the time, location, or attendee list changed.
    Renaming a meeting or recolouring it does not email everybody — the legacy code
    re-sent on every update that touched attendees at all, which trained people to
    ignore the invites.
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
    if attendee_ids is not None:
        existing = list(
            await session.scalars(
                select(MeetingAttendee).where(MeetingAttendee.meeting_id == meeting.id)
            )
        )
        existing_ids = {a.user_id for a in existing if a.user_id}
        if existing_ids != set(attendee_ids):
            attendees_changed = True
            for row in existing:
                await session.delete(row)
            await session.flush()
            for profile in await _resolve_attendees(session, attendee_ids):
                meeting.attendees.append(
                    MeetingAttendee(
                        user_id=profile.id,
                        email=profile.email,
                        name=profile.display_name,
                        profile=profile,
                    )
                )

    await session.flush()
    await session.refresh(meeting)

    if not (changed_fields & invite_worthy or attendees_changed):
        return meeting, None

    attendees = [a.profile for a in meeting.attendees if a.profile is not None]
    # SEQUENCE must increase for calendar clients to accept the revision. Seconds
    # since the meeting row was created gives a monotonic value without another column.
    sequence = max(1, int((meeting.updated_at - meeting.created_at).total_seconds()))

    log.info("meeting_updated", meeting_id=str(meeting.id), reinvited=len(attendees))
    return meeting, _build_bundle(meeting, attendees, actor, updated=True, sequence=sequence)


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
    attendees = [a.profile for a in meeting.attendees if a.profile is not None]
    sequence = max(1, int((meeting.updated_at - meeting.created_at).total_seconds()) + 1)
    bundle = _build_bundle(meeting, attendees, actor, cancelled=True, sequence=sequence)

    await calendar.delete_event(google_access_token, meeting.google_event_id)

    meeting_id = meeting.id
    await session.delete(meeting)
    await session.flush()

    log.info("meeting_deleted", meeting_id=str(meeting_id))
    return bundle
