"""Propose, then commit.

This is the mechanism behind "the assistant writes nothing until the user approves the
exact values", and it is enforced here, not left to the model.

A proposal is a row in ``agent_actions`` holding the payload that would be written. The
model can create one and can ask for one to be committed, but **a commit carries no
values**: it names a proposal and nothing else. So what is written is what was staged
on screen and read back, whatever the model says in between. Changing anything means a
new proposal, which supersedes the old one and needs its own approval.

The commit is one transaction:

1. **Claim.** ``UPDATE … SET status='committed' WHERE status='proposed'``. If no row
   changed, somebody else resolved it first. This is what makes a click on Approve and
   a spoken "yes" arriving together produce one meeting and one round of invites.
2. **Lock the target and compare its fingerprint** with the one taken when the proposal
   was made. A mismatch means the record changed underneath it; nothing is written.
3. **Run the action**, through ``services/actions``, which runs every permission and
   state check again for real.

If any step fails the transaction rolls back, the claim included, and the proposal is
then marked ``failed`` with the reason. The email an action owes goes out only after
the commit.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import ValidationError
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import get_settings
from app.errors import AppError
from app.logging import get_logger
from app.models.agent import AgentAction, AgentConversation
from app.models.enums import AgentActionStatus, AgentApprovalPolicy, AgentApprovedVia
from app.models.meeting import Meeting
from app.models.profile import Profile
from app.schemas.meeting import MeetingCreate
from app.services import actions, meeting_service
from app.services.actions import FollowUp
from app.services.rules import agent_rules
from app.services.rules.agent_rules import Invitee

log = get_logger(__name__)

MEETING_CREATE = "meeting.create"

SessionFactory = async_sessionmaker[AsyncSession]


class ProposalRefused(Exception):
    """A proposal could not be made. The message is for the model to give the user."""


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


# ── Fingerprints ──────────────────────────────────────────────────────────────


def fingerprint_meeting(meeting: Meeting) -> str:
    """A hash of everything about a meeting that a proposal to change it depends on.

    Its fields **and who is on it**. ``updated_at`` would be the obvious thing to
    compare and is the wrong one: changing only a meeting's attendees writes
    ``meeting_attendees`` and never touches the meeting's own row. Checking it could
    let a commit re-add, and re-email, someone a colleague had just taken off.
    """
    people = sorted(
        (str(attendee.user_id) if attendee.user_id else "", attendee.email.lower())
        for attendee in meeting.attendees
    )
    content = {
        "title": meeting.title,
        "description": meeting.description,
        "location": meeting.location,
        "start_time": _as_utc(meeting.start_time).isoformat(),
        "end_time": _as_utc(meeting.end_time).isoformat(),
        "color": meeting.color,
        "project_id": str(meeting.project_id) if meeting.project_id else None,
        "attendees": people,
    }
    encoded = json.dumps(content, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


# ── Proposing ─────────────────────────────────────────────────────────────────


def _local_instant(day: str, clock: str, zone: str) -> datetime:
    """``2026-10-14`` and ``14:30`` in the user's zone, as an aware datetime."""
    try:
        tz = ZoneInfo(zone)
    except (ZoneInfoNotFoundError, ValueError):
        tz = ZoneInfo("UTC")
    try:
        naive = datetime.strptime(f"{day} {clock}", "%Y-%m-%d %H:%M")
    except ValueError as exc:
        raise ProposalRefused(
            "I could not read that date or time. I need the date as year-month-day and "
            "the time on a 24-hour clock."
        ) from exc
    return naive.replace(tzinfo=tz)


async def propose_meeting_create(
    session: AsyncSession,
    actor: Profile,
    conversation: AgentConversation,
    *,
    title: str,
    date: str,
    start_time: str,
    duration_minutes: int,
    attendee_ids: Sequence[str] = (),
    guest_emails: Sequence[str] = (),
    location: str = "",
    description: str = "",
) -> AgentAction:
    """Stage a new meeting. Writes the proposal and nothing else.

    Runs everything the real write will run, as a dry run: the request schema, the
    resolution of who would be on the meeting, and the refusal of anyone who has been
    removed from the team. A refusal comes back as ``ProposalRefused`` and nothing is
    staged. An id that is not a team member's is refused here, not quietly dropped as
    the HTTP API does: the model was given the roster and has no business inventing one.
    """
    if duration_minutes <= 0:
        raise ProposalRefused("A meeting needs a length. How long should it be?")

    start = _local_instant(date, start_time, conversation.client_timezone)
    end = start + timedelta(minutes=duration_minutes)

    try:
        member_ids = [uuid.UUID(value) for value in attendee_ids]
    except ValueError as exc:
        raise ProposalRefused(
            "One of those attendees is not a team member's id. Use list_team_members "
            "and pass the ids it returns."
        ) from exc

    try:
        body = MeetingCreate(
            title=title.strip(),
            description=description,
            location=location,
            start_time=start.astimezone(UTC),
            end_time=end.astimezone(UTC),
            attendee_ids=member_ids,
            attendee_emails=list(guest_emails),
        )
    except ValidationError as exc:
        problems = "; ".join(
            f"{'.'.join(str(part) for part in error['loc'])}: {error['msg']}"
            for error in exc.errors()
        )
        raise ProposalRefused(f"That meeting cannot be created as described ({problems}).") from exc

    try:
        invitees = await meeting_service.preview_invitees(
            session, body.attendee_ids, [str(email) for email in body.attendee_emails]
        )
    except AppError as exc:
        raise ProposalRefused(exc.message) from exc

    found = {person.id for person in invitees.members}
    if any(member_id not in found for member_id in member_ids):
        raise ProposalRefused(
            "One of those people is not on the team. Use list_team_members to find the "
            "right person, or ask the user who they meant."
        )

    people = [Invitee(label=person.display_name) for person in invitees.members] + [
        Invitee(label=email, outside_email=email) for email in invitees.guests
    ]
    summary = agent_rules.meeting_summary(
        title=body.title, start=start, end=end, location=body.location, invitees=people
    )
    policy = agent_rules.meeting_approval_policy(emails_anyone=bool(people))

    # At most one open proposal per conversation: a correction replaces what it corrects.
    now = datetime.now(UTC)
    await session.execute(
        update(AgentAction)
        .where(
            AgentAction.conversation_id == conversation.id,
            AgentAction.status == AgentActionStatus.PROPOSED.value,
        )
        .values(status=AgentActionStatus.SUPERSEDED.value, resolved_at=now)
    )

    action = AgentAction(
        conversation_id=conversation.id,
        user_id=actor.id,
        kind=MEETING_CREATE,
        status=AgentActionStatus.PROPOSED.value,
        payload=body.model_dump(mode="json", exclude={"google_access_token"}),
        labels={
            "when": agent_rules.describe_when(start, end),
            "attendees": [
                {
                    "label": person.label,
                    **({"note": "outside guest"} if person.outside_email else {}),
                }
                for person in people
            ],
        },
        summary=summary,
        approval_policy=policy.value,
        expires_at=now + timedelta(seconds=get_settings().agent_proposal_ttl_seconds),
    )
    session.add(action)
    await session.flush()
    log.info(
        "agent_proposal_created",
        action_id=str(action.id),
        kind=action.kind,
        approval_policy=action.approval_policy,
    )
    return action


# ── Resolving without committing ──────────────────────────────────────────────


async def resolve(session: AsyncSession, action_id: uuid.UUID, status: AgentActionStatus) -> bool:
    """Close an open proposal as cancelled, handed over, expired or superseded.

    Returns whether it was still open. The same guarded update as a commit's claim, so
    a rejection racing an approval cannot both win.
    """
    done = await session.execute(
        update(AgentAction)
        .where(AgentAction.id == action_id, AgentAction.status == AgentActionStatus.PROPOSED.value)
        .values(status=status.value, resolved_at=datetime.now(UTC))
    )
    changed = bool(done.rowcount)  # type: ignore[attr-defined]
    if changed:
        log.info(f"agent_proposal_{status.value}", action_id=str(action_id))
    return changed


async def open_proposal(session: AsyncSession, conversation_id: uuid.UUID) -> AgentAction | None:
    waiting: AgentAction | None = await session.scalar(
        select(AgentAction).where(
            AgentAction.conversation_id == conversation_id,
            AgentAction.status == AgentActionStatus.PROPOSED.value,
        )
    )
    return waiting


# ── Committing ────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class CommitOutcome:
    #: ``committed``, ``failed``, or ``already_resolved`` when something else got there
    #: first, in which case ``resolved_as`` says what it became.
    status: str
    kind: str = ""
    resolved_as: str | None = None
    result: dict[str, Any] = field(default_factory=dict)
    error: str | None = None

    @property
    def committed(self) -> bool:
        return self.status == "committed"


class _CommitFailed(Exception):
    """Raised inside the commit transaction to abort it with a reason for the user."""


async def _apply(
    session: AsyncSession, actor: Profile, action: AgentAction
) -> tuple[dict[str, Any], list[FollowUp]]:
    """Perform the proposed action. Dispatches on its kind."""
    if action.kind == MEETING_CREATE:
        written = await actions.create_meeting(
            session, actor, MeetingCreate.model_validate(action.payload)
        )
        return {"type": "meeting", "id": str(written.meeting.id)}, written.follow_ups
    raise _CommitFailed(f"Nothing knows how to commit a {action.kind!r} proposal.")


async def _check_target_unchanged(
    session: AsyncSession, actor: Profile, action: AgentAction
) -> None:
    """Lock what the proposal would change and confirm it is as it was when proposed.

    The lock is the same one the action function takes, on the same row, so an edit made
    by hand over HTTP at the same moment waits for this commit and this commit waits for
    it. A lock only the assistant took would protect nothing.
    """
    if action.target_id is None:
        return
    if action.target_type == "meeting":
        meeting = await meeting_service.get_meeting(
            session, actor, action.target_id, for_update=True
        )
        current = fingerprint_meeting(meeting)
    else:
        raise _CommitFailed(f"Nothing knows how to check a {action.target_type!r} target.")
    if current != action.target_fingerprint:
        raise _CommitFailed(
            "That record was changed by someone else after it was proposed, so nothing "
            "was saved. Look at it again and propose the change afresh."
        )


async def commit(
    factory: SessionFactory,
    action_id: uuid.UUID,
    *,
    actor_id: uuid.UUID,
    via: AgentApprovedVia,
    utterance: str | None = None,
) -> CommitOutcome:
    """Commit one proposal, exactly once, and run what it owes afterwards.

    The actor is loaded again here, from the database, on every commit. A click on
    Approve is not a tool call and passes no other check, so without this a person
    removed from the team mid-conversation could still approve what was already on
    their screen.
    """
    follow_ups: list[FollowUp] = []
    result: dict[str, Any] = {}
    kind = ""
    async with factory() as session:
        try:
            now = datetime.now(UTC)
            claimed = await session.execute(
                update(AgentAction)
                .where(
                    AgentAction.id == action_id,
                    AgentAction.status == AgentActionStatus.PROPOSED.value,
                )
                .values(
                    status=AgentActionStatus.COMMITTED.value,
                    approved_via=via.value,
                    approval_utterance=utterance,
                    resolved_at=now,
                )
            )
            action = await session.get(AgentAction, action_id, populate_existing=True)
            if action is None:
                return CommitOutcome(status="already_resolved", resolved_as="unknown")
            # Read before any rollback: a rollback expires the row, and touching an
            # expired attribute from here would be a lazy load outside a greenlet.
            kind, became = action.kind, action.status
            if not claimed.rowcount:  # type: ignore[attr-defined]
                await session.rollback()
                return CommitOutcome(status="already_resolved", kind=kind, resolved_as=became)

            if _as_utc(action.expires_at) < now:
                raise _CommitFailed("That proposal had expired, so nothing was saved.")

            actor = await session.get(Profile, actor_id)
            if actor is None or actor.is_banned or actor.id != action.user_id:
                raise _CommitFailed("Your account can no longer do this. Nothing was saved.")

            await _check_target_unchanged(session, actor, action)
            result, follow_ups = await _apply(session, actor, action)
            action.result = result
            await session.commit()
        except Exception as exc:
            await session.rollback()
            reason = (
                str(exc)
                if isinstance(exc, _CommitFailed)
                else exc.message
                if isinstance(exc, AppError)
                else "Something went wrong while saving, so nothing was saved."
            )
            if not isinstance(exc, (_CommitFailed, AppError)):
                log.exception("agent_commit_crashed", action_id=str(action_id))
            await _mark_failed(factory, action_id, reason)
            return CommitOutcome(status="failed", kind=kind, error=reason)

    log.info("agent_proposal_committed", action_id=str(action_id), kind=kind, via=via.value)
    for follow_up in follow_ups:
        try:
            await follow_up.run()
        except Exception:
            # The record is saved. A failed email must not turn that into a failure,
            # and the notifications module already logs what it could not send.
            log.exception("agent_follow_up_failed", action_id=str(action_id))
    return CommitOutcome(status="committed", kind=kind, result=result)


async def _mark_failed(factory: SessionFactory, action_id: uuid.UUID, reason: str) -> None:
    """Record why a commit failed. Its own transaction: the commit's has rolled back."""
    async with factory() as session:
        await session.execute(
            update(AgentAction)
            .where(
                AgentAction.id == action_id,
                AgentAction.status == AgentActionStatus.PROPOSED.value,
            )
            .values(
                status=AgentActionStatus.FAILED.value,
                error=reason,
                resolved_at=datetime.now(UTC),
            )
        )
        await session.commit()
    log.info("agent_proposal_failed", action_id=str(action_id))


def policy_of(action: AgentAction) -> AgentApprovalPolicy:
    return AgentApprovalPolicy(action.approval_policy)
