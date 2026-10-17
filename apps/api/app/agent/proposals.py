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
from app.models.agent import AgentAction, AgentConversation, AgentMemory
from app.models.enums import (
    AgentActionStatus,
    AgentApprovalPolicy,
    AgentApprovedVia,
    EstimateStatus,
    ItemCategory,
    ItemUnit,
)
from app.models.estimate import Estimate
from app.models.meeting import Meeting
from app.models.profile import Profile
from app.schemas.estimate import EstimateCreate, EstimateUpdate
from app.schemas.meeting import MeetingCreate, MeetingUpdate
from app.services import (
    actions,
    agent_memory_service,
    attachment_service,
    estimate_service,
    meeting_service,
    settings_service,
)
from app.services.actions import FollowUp
from app.services.rules import agent_readback, agent_rules, estimate_rules, line_additions
from app.services.rules.agent_rules import (
    MEETING_CREATE,
    MEETING_UPDATE,
    MEMORY_CHANGE,
    SUPPLEMENT_ADD_LINES,
    SUPPLEMENT_CREATE,
    SUPPLEMENT_SUBMIT,
    SUPPLEMENT_TRANSITION,
    SUPPLEMENT_UPDATE,
    FieldChange,
    Invitee,
    Term,
)

log = get_logger(__name__)

SessionFactory = async_sessionmaker[AsyncSession]

#: Which of the browser's cached lists a committed proposal makes stale.
REFRESH: dict[str, list[str]] = {
    MEETING_CREATE: ["meetings"],
    MEETING_UPDATE: ["meetings"],
    SUPPLEMENT_CREATE: ["estimates"],
    SUPPLEMENT_UPDATE: ["estimates"],
    SUPPLEMENT_TRANSITION: ["estimates"],
    SUPPLEMENT_SUBMIT: ["estimates"],
    SUPPLEMENT_ADD_LINES: ["estimates"],
    MEMORY_CHANGE: ["agent"],
}


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


def fingerprint_estimate(estimate: Estimate) -> str:
    """A hash of what a proposal about a supplement depends on.

    Its header, its status, whether it is in the trash, and its rooms. A proposal to
    archive a supplement was read back with a total; if a line was added since, that
    total is no longer what the user approved.
    """
    content = {
        "project_name": estimate.project_name,
        "client_name": estimate.client_name,
        "identifier": estimate.identifier,
        "pm_name": estimate.pm_name,
        "insurance_carrier": estimate.insurance_carrier,
        "notes": estimate.notes,
        "status": estimate.status,
        "trashed": estimate.is_trashed,
        "rooms": estimate.rooms,
    }
    encoded = json.dumps(content, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def fingerprint_memory(memory: AgentMemory) -> str:
    return hashlib.sha256(f"{memory.category}\n{memory.content}".encode()).hexdigest()


# ── Proposing ─────────────────────────────────────────────────────────────────


def _zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def _problems(exc: ValidationError) -> str:
    return "; ".join(
        f"{'.'.join(str(part) for part in error['loc'])}: {error['msg']}" for error in exc.errors()
    )


def _uuid(value: str, what: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except ValueError as exc:
        raise ProposalRefused(
            f"That is not the id of {what}. Look it up first and pass the id you are given."
        ) from exc


@dataclass(slots=True)
class Draft:
    """A proposal worked out and not yet stored."""

    kind: str
    payload: dict[str, Any]
    summary: str
    policy: AgentApprovalPolicy
    #: What the staged screen shows that the payload alone does not say. ``route`` is
    #: where in the app it is staged.
    labels: dict[str, Any] = field(default_factory=dict)
    required_terms: list[Term] = field(default_factory=list)
    target_type: str | None = None
    target_id: uuid.UUID | None = None
    target_fingerprint: str | None = None
    #: What a user on a phone says back to approve it by voice. Absent for anything
    #: that only a click approves.
    confirm: agent_rules.Confirmation | None = None


async def _store(
    session: AsyncSession, actor: Profile, conversation: AgentConversation, draft: Draft
) -> AgentAction:
    """Record a proposal, replacing whichever one was open.

    At most one open proposal per conversation: a correction replaces what it corrects,
    and an approval never carries over to values the user has not seen.
    """
    now = datetime.now(UTC)
    replaced = await session.execute(
        update(AgentAction)
        .where(
            AgentAction.conversation_id == conversation.id,
            AgentAction.status == AgentActionStatus.PROPOSED.value,
        )
        .values(status=AgentActionStatus.SUPERSEDED.value, resolved_at=now)
    )
    if replaced.rowcount:  # type: ignore[attr-defined]
        log.info("agent_proposal_superseded", conversation_id=str(conversation.id))

    action = AgentAction(
        conversation_id=conversation.id,
        user_id=actor.id,
        kind=draft.kind,
        status=AgentActionStatus.PROPOSED.value,
        payload=draft.payload,
        labels=(
            {**draft.labels, "confirm": draft.confirm.as_label()}
            if draft.confirm is not None
            else draft.labels
        ),
        summary=draft.summary,
        approval_policy=draft.policy.value,
        target_type=draft.target_type,
        target_id=draft.target_id,
        target_fingerprint=draft.target_fingerprint,
        required_terms=draft.required_terms,
        expires_at=now + timedelta(seconds=get_settings().agent_proposal_ttl_seconds),
    )
    session.add(action)
    await session.flush()
    log.info(
        "agent_proposal_created",
        conversation_id=str(conversation.id),
        action_id=str(action.id),
        kind=action.kind,
        approval_policy=action.approval_policy,
    )
    return action


def describe(action: AgentAction) -> dict[str, Any]:
    """A proposal as the browser is shown it: the approval card and the staged screen."""
    return {
        "id": str(action.id),
        "kind": action.kind,
        "summary": action.summary,
        "payload": action.payload,
        "labels": action.labels,
        "warnings": list(action.labels.get("warnings", [])),
        "approval": action.approval_policy,
        "expires_at": _as_utc(action.expires_at).isoformat(),
    }


def done_summary(action: AgentAction) -> str:
    """A committed proposal's summary, reworded as something that has happened."""
    return "Saved: " + action.summary.replace("I am about to ", "", 1)


def _local_instant(day: str, clock: str, zone: str) -> datetime:
    """``2026-10-14`` and ``14:30`` in the user's zone, as an aware datetime."""
    tz = _zone(zone)
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
    remembered_fields: Sequence[str] | None = None,
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

    people = _people(invitees.members, invitees.guests)
    remembered = _remembered(remembered_fields)
    summary = agent_rules.meeting_summary(
        title=body.title, start=start, end=end, location=body.location, invitees=people
    )
    note = agent_rules.memory_note(remembered)
    return await _store(
        session,
        actor,
        conversation,
        Draft(
            kind=MEETING_CREATE,
            payload=body.model_dump(mode="json", exclude={"google_access_token"}),
            summary=f"{summary} {note}".strip(),
            policy=agent_rules.approval_policy(MEETING_CREATE, emails_anyone=bool(people)),
            labels={
                "route": f"/calendar?on={start.date().isoformat()}",
                "when": agent_rules.describe_when(start, end),
                "attendees": _attendee_labels(people),
                "warnings": [note] if note else [],
            },
            required_terms=agent_rules.meeting_terms(
                title=body.title, start=start, invitees=people, remembered=remembered
            ),
            confirm=agent_rules.confirm_meeting(title=body.title, start=start),
        ),
    )


def _people(members: Sequence[Profile], guests: Sequence[str]) -> list[Invitee]:
    return [Invitee(label=person.display_name) for person in members] + [
        Invitee(label=email, outside_email=email) for email in guests
    ]


def _attendee_labels(people: Sequence[Invitee]) -> list[dict[str, str]]:
    """A label for every attendee in the payload, so the staged form shows exactly them."""
    return [
        {"label": person.label, **({"note": "outside guest"} if person.outside_email else {})}
        for person in people
    ]


def _remembered(fields: Sequence[str] | None) -> list[str]:
    return [str(name).strip() for name in fields or [] if str(name).strip()]


async def propose_meeting_update(
    session: AsyncSession,
    actor: Profile,
    conversation: AgentConversation,
    *,
    meeting_id: str,
    title: str | None = None,
    date: str | None = None,
    start_time: str | None = None,
    duration_minutes: int | None = None,
    location: str | None = None,
    description: str | None = None,
    attendee_ids: Sequence[str] | None = None,
    guest_emails: Sequence[str] | None = None,
) -> AgentAction:
    """Stage a change to a meeting. ``None`` leaves that part of it as it is.

    The plan comes from ``meeting_service.plan_update``, which is what the write itself
    applies. So whether this proposal would email anyone, who would be on the meeting
    afterwards, and which removed people would come off it are the write's own answers
    and not a second opinion.
    """
    zone = _zone(conversation.client_timezone)
    try:
        meeting = await meeting_service.get_meeting(session, actor, _uuid(meeting_id, "a meeting"))
    except AppError as exc:
        raise ProposalRefused(exc.message) from exc

    was_start = _as_utc(meeting.start_time).astimezone(zone)
    was_end = _as_utc(meeting.end_time).astimezone(zone)
    start, end = was_start, was_end
    if date is not None or start_time is not None:
        start = _local_instant(
            date or was_start.strftime("%Y-%m-%d"),
            start_time or was_start.strftime("%H:%M"),
            conversation.client_timezone,
        )
        end = start + (was_end - was_start)
    if duration_minutes is not None:
        if duration_minutes <= 0:
            raise ProposalRefused("A meeting needs a length. How long should it be?")
        end = start + timedelta(minutes=duration_minutes)

    fields: dict[str, Any] = {}
    said: list[str] = []
    if title is not None and title.strip() != meeting.title:
        fields["title"] = title.strip()
        said.append(f"New title: {title.strip()}.")
    if start != was_start or end != was_end:
        fields["start_time"] = start.astimezone(UTC)
        fields["end_time"] = end.astimezone(UTC)
        said.append("The time changes.")
    if location is not None and location != meeting.location:
        fields["location"] = location
        said.append(f"Location: {location or 'none'}.")
    if description is not None and description != meeting.description:
        fields["description"] = description
        said.append("The description changes.")
    if attendee_ids is not None:
        fields["attendee_ids"] = [_uuid(value, "a team member") for value in attendee_ids]
    if guest_emails is not None:
        fields["attendee_emails"] = list(guest_emails)

    try:
        body = MeetingUpdate(**fields)
    except ValidationError as exc:
        raise ProposalRefused(
            f"That meeting cannot be changed as described ({_problems(exc)})."
        ) from exc

    changes = body.model_dump(exclude_unset=True, exclude={"attendee_ids", "attendee_emails"})
    try:
        plan = await meeting_service.plan_update(
            session,
            actor,
            meeting,
            changes=changes,
            attendee_ids=body.attendee_ids,
            attendee_emails=(
                None if body.attendee_emails is None else [str(e) for e in body.attendee_emails]
            ),
        )
    except AppError as exc:
        raise ProposalRefused(exc.message) from exc

    known = {person.id for person in [*plan.members, *plan.dropped]}
    if any(member_id not in known for member_id in body.attendee_ids or []):
        raise ProposalRefused(
            "One of those people is not on the team. Use list_team_members to find the "
            "right person, or ask the user who they meant."
        )
    if not (fields.keys() - {"attendee_ids", "attendee_emails"}) and not plan.attendees_changed:
        raise ProposalRefused(
            "That would change nothing about the meeting. Ask what should change."
        )
    if plan.attendees_changed:
        said.append("The list of people invited changes.")

    people = _people(plan.members, plan.guests)
    dropped = [person.display_name for person in plan.dropped]
    result_title = fields.get("title", meeting.title)
    summary = agent_rules.meeting_update_summary(
        title=result_title,
        start=start,
        end=end,
        changes=said,
        invitees=people,
        reinvites=plan.reinvites,
        dropped=dropped,
    )
    terms = agent_rules.meeting_terms(
        title=result_title, start=start, invitees=people if plan.reinvites else []
    )
    terms += [
        agent_readback.text_term("a removed person coming off the meeting", name)
        for name in dropped
    ]
    return await _store(
        session,
        actor,
        conversation,
        Draft(
            kind=MEETING_UPDATE,
            payload={
                "meeting_id": str(meeting.id),
                "changes": body.model_dump(mode="json", exclude_unset=True),
            },
            summary=summary,
            policy=agent_rules.approval_policy(MEETING_UPDATE, emails_anyone=plan.reinvites),
            labels={
                "route": f"/calendar?on={start.date().isoformat()}",
                "when": agent_rules.describe_when(start, end),
                # The whole form as it would be after the change, for the staged screen.
                "form": {
                    "title": result_title,
                    "description": fields.get("description", meeting.description),
                    "location": fields.get("location", meeting.location),
                    "start_time": start.astimezone(UTC).isoformat(),
                    "end_time": end.astimezone(UTC).isoformat(),
                },
                "attendees": _attendee_labels(people),
                "dropped": dropped,
                "warnings": [
                    f"{name} has been removed from the team and comes off this meeting."
                    for name in dropped
                ],
            },
            required_terms=terms,
            target_type="meeting",
            target_id=meeting.id,
            target_fingerprint=fingerprint_meeting(meeting),
            confirm=agent_rules.confirm_meeting(title=result_title, start=start),
        ),
    )


# ── Supplements ───────────────────────────────────────────────────────────────

#: The details of a supplement the assistant may change, and how each is named aloud.
DETAIL_FIELDS: dict[str, str] = {
    "project_name": "Project name",
    "client_name": "Client",
    "identifier": "Claim ID",
    "pm_name": "Project manager",
    "insurance_carrier": "Carrier",
    "notes": "Notes",
}


def _name_of(estimate: Estimate) -> str:
    return agent_rules.supplement_name(
        project_name=estimate.project_name,
        client_name=estimate.client_name,
        identifier=estimate.identifier,
    )


def _terms_of(estimate: Estimate, *, with_total: bool) -> list[Term]:
    return agent_rules.supplement_terms(
        project_name=estimate.project_name,
        client_name=estimate.client_name,
        identifier=estimate.identifier,
        total=estimate.total_amount if with_total else None,
    )


async def _supplement(session: AsyncSession, actor: Profile, supplement_id: str) -> Estimate:
    """A supplement the actor may see, that is not in the trash."""
    try:
        estimate = await estimate_service.get_estimate(
            session, actor, _uuid(supplement_id, "a supplement")
        )
    except AppError as exc:
        raise ProposalRefused(exc.message) from exc
    if estimate.is_trashed:
        raise ProposalRefused(
            "That supplement is in the trash. It has to be restored by hand before "
            "anything can be done with it."
        )
    return estimate


def _check_editable(actor: Profile, estimate: Estimate) -> None:
    if not estimate_rules.can_edit(
        estimate_service.actor_of(actor), estimate_service.snapshot_of(estimate)
    ):
        raise ProposalRefused(
            "This supplement is locked. Only the owner can edit it."
            if estimate.status == EstimateStatus.LOCKED.value
            else "You can only edit supplements you created."
        )


def _status_note(estimate: Estimate, terms: list[Term]) -> str:
    """The warning for changing a supplement that is already out, and its term."""
    if estimate.status not in (EstimateStatus.SUBMITTED.value, EstimateStatus.APPROVED.value):
        return ""
    said = agent_rules.said_status(estimate.status)
    terms.append(agent_readback.text_term("that the supplement is already out", said))
    return f"Note that this supplement is already {said}."


async def propose_supplement_create(
    session: AsyncSession,
    actor: Profile,
    conversation: AgentConversation,
    *,
    project_name: str,
    client_name: str = "",
    identifier: str = "",
    pm_name: str = "",
    insurance_carrier: str = "",
    notes: str = "",
    remembered_fields: Sequence[str] | None = None,
) -> AgentAction:
    """Stage a new supplement: its header only. Rooms and lines are added by hand."""
    if not project_name.strip() and not client_name.strip():
        raise ProposalRefused("A supplement needs a project or client name. Ask for one.")
    try:
        body = EstimateCreate(
            project_name=project_name.strip(),
            client_name=client_name.strip(),
            identifier=identifier or None,
            pm_name=pm_name.strip(),
            insurance_carrier=insurance_carrier.strip(),
            notes=notes,
        )
    except ValidationError as exc:
        raise ProposalRefused(
            f"That supplement cannot be created as described ({_problems(exc)})."
        ) from exc

    remembered = _remembered(remembered_fields)
    note = agent_rules.memory_note(remembered)
    terms = agent_rules.supplement_terms(
        project_name=body.project_name,
        client_name=body.client_name,
        identifier=body.identifier or "",
    )
    if remembered:
        terms.append(
            agent_readback.any_term("that a value came from memory", ["remember", "memory"])
        )
    return await _store(
        session,
        actor,
        conversation,
        Draft(
            kind=SUPPLEMENT_CREATE,
            payload=body.model_dump(mode="json"),
            summary=agent_rules.supplement_create_summary(
                project_name=body.project_name,
                client_name=body.client_name,
                identifier=body.identifier,
                pm_name=body.pm_name,
                insurance_carrier=body.insurance_carrier,
                remembered=remembered,
            ),
            policy=agent_rules.approval_policy(SUPPLEMENT_CREATE),
            labels={"route": "/estimates", "warnings": [note] if note else []},
            required_terms=terms,
            confirm=agent_rules.confirm_supplement(
                verb="Create",
                keywords=["create", "new", "make"],
                name=body.project_name or body.client_name,
                record=agent_rules.supplement_terms(
                    project_name=body.project_name,
                    client_name=body.client_name,
                    identifier=body.identifier or "",
                ),
            ),
        ),
    )


async def propose_supplement_update(
    session: AsyncSession,
    actor: Profile,
    conversation: AgentConversation,
    *,
    supplement_id: str,
    project_name: str | None = None,
    client_name: str | None = None,
    identifier: str | None = None,
    pm_name: str | None = None,
    insurance_carrier: str | None = None,
    notes: str | None = None,
) -> AgentAction:
    """Stage a change to a supplement's details. ``None`` leaves a field as it is."""
    estimate = await _supplement(session, actor, supplement_id)
    _check_editable(actor, estimate)

    asked = {
        "project_name": project_name,
        "client_name": client_name,
        "identifier": identifier,
        "pm_name": pm_name,
        "insurance_carrier": insurance_carrier,
        "notes": notes,
    }
    wanted = {
        name: value.strip() if name != "notes" else value
        for name, value in asked.items()
        if value is not None
    }
    different = {name: value for name, value in wanted.items() if value != getattr(estimate, name)}
    if not different:
        raise ProposalRefused(
            "That would change nothing about the supplement. Ask what should change."
        )
    try:
        body = EstimateUpdate(**different)
    except ValidationError as exc:
        raise ProposalRefused(
            f"Those details cannot be saved as described ({_problems(exc)})."
        ) from exc

    changes = [
        FieldChange(label=DETAIL_FIELDS[name], old=str(getattr(estimate, name) or ""), new=value)
        for name, value in different.items()
    ]
    terms = _terms_of(estimate, with_total=False)
    status_note = _status_note(estimate, terms)

    return await _store(
        session,
        actor,
        conversation,
        Draft(
            kind=SUPPLEMENT_UPDATE,
            payload={
                "supplement_id": str(estimate.id),
                "changes": body.model_dump(mode="json", exclude_unset=True),
            },
            summary=agent_rules.supplement_update_summary(
                name=_name_of(estimate), changes=changes, status_note=status_note
            ),
            policy=agent_rules.approval_policy(SUPPLEMENT_UPDATE),
            labels={
                "route": f"/estimates/{estimate.id}",
                "name": _name_of(estimate),
                "changes": [
                    {"field": name, "label": change.label, "old": change.old, "new": change.new}
                    for name, change in zip(different, changes, strict=True)
                ],
                "warnings": [status_note] if status_note else [],
            },
            required_terms=terms,
            target_type="supplement",
            target_id=estimate.id,
            target_fingerprint=fingerprint_estimate(estimate),
            confirm=agent_rules.confirm_supplement(
                verb="Change",
                keywords=["change", "update"],
                name=_name_of(estimate),
                record=_terms_of(estimate, with_total=False),
            ),
        ),
    )


def _photos_in_the_way(done: str) -> str:
    return (
        "Photos from a line that was deleted are still recorded where the new lines would "
        f"go, and the new lines would show them. Nothing was {done}. Ask the user to add "
        "these lines by hand in the editor."
    )


async def propose_supplement_add_lines(
    session: AsyncSession,
    actor: Profile,
    conversation: AgentConversation,
    *,
    supplement_id: str,
    additions: Sequence[line_additions.Addition],
) -> AgentAction:
    """Stage new lines, and new rooms, at the end of a supplement. Changes nothing else.

    The price of every line is decided here, from the catalogue or from the price the
    user stated, never by the model. The whole new rooms document is what is staged and
    what a commit writes, so the commit cannot differ from what was approved.
    """
    estimate = await _supplement(session, actor, supplement_id)
    _check_editable(actor, estimate)

    team = await settings_service.get_settings_row(session)
    catalogue = {
        str(row.id): line_additions.CatalogueEntry(
            id=str(row.id),
            name=row.name,
            category=row.category,
            unit=row.unit,
            unit_cost=row.unit_cost,
        )
        for row in await settings_service.list_catalogue(session)
    }
    try:
        plan = line_additions.plan_additions(
            estimate.rooms or [],
            additions,
            catalogue,
            units=[*(unit.value for unit in ItemUnit), *(team.custom_units or [])],
            categories=[*(item.value for item in ItemCategory), *(team.custom_categories or [])],
        )
        body = EstimateUpdate(rooms=plan.rooms)
    except line_additions.AdditionRefused as exc:
        raise ProposalRefused(str(exc)) from exc
    except ValidationError as exc:
        raise ProposalRefused(
            f"Those lines cannot be saved as described ({_problems(exc)})."
        ) from exc

    photos = await attachment_service.photo_positions(session, actor, estimate.id)
    if line_additions.photos_in_the_way(plan.positions, photos):
        raise ProposalRefused(_photos_in_the_way("staged"))

    added = [
        agent_rules.AddedLine(
            room=line.room,
            new_room=line.new_room,
            name=line.name,
            unit_cost=line.unit_cost,
            source=line.source,
            catalogue_unit_cost=line.catalogue_unit_cost,
        )
        for line in plan.lines
    ]
    record = _terms_of(estimate, with_total=False)
    status_note = _status_note(estimate, record)
    name = _name_of(estimate)
    rooms_document = [room.model_dump(by_alias=True, mode="json") for room in body.rooms or []]
    return await _store(
        session,
        actor,
        conversation,
        Draft(
            kind=SUPPLEMENT_ADD_LINES,
            payload={
                "supplement_id": str(estimate.id),
                "rooms": rooms_document,
                "positions": [list(position) for position in plan.positions],
            },
            summary=agent_rules.supplement_add_lines_summary(
                name=name,
                lines=added,
                old_total=plan.old_total,
                new_total=plan.new_total,
                status_note=status_note,
            ),
            policy=agent_rules.approval_policy(SUPPLEMENT_ADD_LINES),
            labels={
                "route": f"/estimates/{estimate.id}",
                "name": name,
                "lines": [
                    {
                        "room": line.room,
                        "room_index": line.room_index,
                        "new_room": line.new_room,
                        "name": line.name,
                        "quantity": str(line.quantity),
                        "unit": line.unit,
                        "category": line.category,
                        "unit_cost": str(line.unit_cost),
                        "catalogue_unit_cost": (
                            str(line.catalogue_unit_cost)
                            if line.catalogue_unit_cost is not None
                            else None
                        ),
                        "source": line.source,
                        "total": str(line.total),
                    }
                    for line in plan.lines
                ],
                "new_rooms": plan.new_rooms,
                "old_total": str(plan.old_total),
                "new_total": str(plan.new_total),
                "facts": _add_lines_facts(plan),
                "warnings": [status_note] if status_note else [],
            },
            required_terms=agent_rules.add_lines_terms(
                record=record, lines=added, new_total=plan.new_total
            ),
            target_type="supplement",
            target_id=estimate.id,
            target_fingerprint=fingerprint_estimate(estimate),
            confirm=agent_rules.confirm_add_lines(
                name=name,
                count=len(plan.lines),
                new_total=plan.new_total,
                record=_terms_of(estimate, with_total=False),
            ),
        ),
    )


def _add_lines_facts(plan: line_additions.Plan) -> list[dict[str, Any]]:
    """The approval card's rows: counts and the total. The lines are on the staged
    screen."""
    facts: list[dict[str, Any]] = [
        {"label": "Adding", "value": f"{len(plan.lines)} line{'' if len(plan.lines) == 1 else 's'}"}
    ]
    if plan.new_rooms:
        facts.append({"label": "New rooms", "value": ", ".join(plan.new_rooms)})
    facts.append(
        {
            "label": "Total",
            "value": agent_rules.money(plan.new_total),
            "was": agent_rules.money(plan.old_total),
        }
    )
    for line in plan.unpriced_by_catalogue:
        facts.append(
            {
                "label": line.name,
                "value": f"{agent_rules.money(line.unit_cost)} per {line.unit}",
                "source": "stated" if line.source == line_additions.STATED else "differs",
            }
        )
    return facts


async def propose_supplement_transition(
    session: AsyncSession,
    actor: Profile,
    conversation: AgentConversation,
    *,
    supplement_id: str,
    action: str,
) -> AgentAction:
    """Stage a status change. Refused here if the real one would be refused."""
    estimate = await _supplement(session, actor, supplement_id)
    try:
        estimate_rules.resolve_transition(
            action, estimate_service.actor_of(actor), EstimateStatus(estimate.status)
        )
    except (
        estimate_rules.UnknownTransition,
        estimate_rules.TransitionNotPermitted,
        estimate_rules.TransitionNotAvailable,
    ) as exc:
        raise ProposalRefused(f"{exc}.") from exc

    verb, note = agent_rules.TRANSITION_WORDS[action]
    policy = agent_rules.approval_policy(SUPPLEMENT_TRANSITION, transition=action)
    said_back, keywords = agent_rules.TRANSITION_CONFIRM.get(action, (verb, [action]))
    return await _store(
        session,
        actor,
        conversation,
        Draft(
            kind=SUPPLEMENT_TRANSITION,
            payload={"supplement_id": str(estimate.id), "action": action},
            summary=agent_rules.supplement_transition_summary(
                name=_name_of(estimate),
                action=action,
                status=estimate.status,
                total=estimate.total_amount,
            ),
            policy=policy,
            labels={
                "route": f"/estimates/{estimate.id}",
                "name": _name_of(estimate),
                "action": action,
                "action_label": verb[:1].upper() + verb[1:],
                "status": estimate.status,
                "total": agent_rules.money(estimate.total_amount),
                "warnings": [note] if note else [],
            },
            required_terms=_terms_of(estimate, with_total=True),
            target_type="supplement",
            target_id=estimate.id,
            target_fingerprint=fingerprint_estimate(estimate),
            confirm=(
                agent_rules.confirm_supplement(
                    verb=said_back,
                    keywords=keywords,
                    name=_name_of(estimate),
                    record=_terms_of(estimate, with_total=False),
                )
                if policy is AgentApprovalPolicy.VOICE_OR_CLICK
                else None
            ),
        ),
    )


async def propose_supplement_submit(
    session: AsyncSession,
    actor: Profile,
    conversation: AgentConversation,
    *,
    supplement_id: str,
) -> AgentAction:
    """Stage sending a supplement to the reviewer. Always needs a click: it emails them."""
    estimate = await _supplement(session, actor, supplement_id)
    try:
        reviewer = await settings_service.reviewer_or_error(session)
    except AppError as exc:
        raise ProposalRefused(exc.message) from exc
    who, what = estimate_service.actor_of(actor), estimate_service.snapshot_of(estimate)
    if not estimate_rules.can_submit_for_review(who, what):
        raise ProposalRefused("You can only submit supplements you created.")
    if not estimate_rules.can_be_submitted(what):
        raise ProposalRefused(
            f"A supplement that is {agent_rules.said_status(estimate.status)} cannot be sent "
            "for review. If it is already with the reviewer it has to be recalled first."
        )

    terms = _terms_of(estimate, with_total=True)
    terms.append(agent_readback.text_term("who will be emailed", reviewer.display_name))
    return await _store(
        session,
        actor,
        conversation,
        Draft(
            kind=SUPPLEMENT_SUBMIT,
            payload={"supplement_id": str(estimate.id)},
            summary=agent_rules.supplement_submit_summary(
                name=_name_of(estimate),
                total=estimate.total_amount,
                reviewer_name=reviewer.display_name,
                reviewer_email=reviewer.email,
            ),
            policy=agent_rules.approval_policy(SUPPLEMENT_SUBMIT),
            labels={
                "route": f"/estimates/{estimate.id}",
                "name": _name_of(estimate),
                "total": agent_rules.money(estimate.total_amount),
                "reviewer": {"name": reviewer.display_name, "email": reviewer.email},
                "warnings": [f"{reviewer.display_name} will be emailed the approval link."],
            },
            required_terms=terms,
            target_type="supplement",
            target_id=estimate.id,
            target_fingerprint=fingerprint_estimate(estimate),
        ),
    )


# ── Memory ────────────────────────────────────────────────────────────────────


async def propose_memory_change(
    session: AsyncSession,
    actor: Profile,
    conversation: AgentConversation,
    *,
    memory_id: str,
    new_content: str | None,
    user_words: Sequence[str],
    known_names: Sequence[str] = (),
) -> AgentAction:
    """Stage changing or forgetting something the assistant remembers.

    Adding a memory needs no approval; changing one does, with the old and new text
    shown, so that what the assistant believes about a person cannot be quietly
    rewritten. The new text is held to the same grounding rule as a new memory.
    """
    try:
        memory = await agent_memory_service.get_memory(session, actor, _uuid(memory_id, "a memory"))
    except AppError as exc:
        raise ProposalRefused(exc.message) from exc

    replacement = (new_content or "").strip() or None
    if replacement is not None:
        if replacement == memory.content:
            raise ProposalRefused("That is already what is remembered.")
        try:
            agent_memory_service.check_groundable(
                replacement, user_words=user_words, known_names=known_names
            )
        except agent_memory_service.MemoryRejected as exc:
            raise ProposalRefused(exc.message) from exc

    return await _store(
        session,
        actor,
        conversation,
        Draft(
            kind=MEMORY_CHANGE,
            payload={"memory_id": str(memory.id), "content": replacement},
            summary=agent_rules.memory_change_summary(old=memory.content, new=replacement),
            policy=agent_rules.approval_policy(MEMORY_CHANGE),
            labels={"old": memory.content, "new": replacement},
            target_type="memory",
            target_id=memory.id,
            target_fingerprint=fingerprint_memory(memory),
            confirm=agent_rules.confirm_memory(forget=replacement is None),
        ),
    )


async def downgrade_to_click(session: AsyncSession, action_id: uuid.UUID) -> None:
    """The read-back could not be verified: from now on only the button approves this."""
    await session.execute(
        update(AgentAction)
        .where(AgentAction.id == action_id, AgentAction.status == AgentActionStatus.PROPOSED.value)
        .values(approval_policy=AgentApprovalPolicy.CLICK.value, readback_verified=False)
    )


async def mark_verified(session: AsyncSession, action_id: uuid.UUID) -> None:
    await session.execute(
        update(AgentAction)
        .where(AgentAction.id == action_id, AgentAction.status == AgentActionStatus.PROPOSED.value)
        .values(readback_verified=True)
    )


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
    payload = action.payload
    if action.kind == MEETING_CREATE:
        written = await actions.create_meeting(
            session, actor, MeetingCreate.model_validate(payload)
        )
        return _target("meeting", written.meeting.id), written.follow_ups
    if action.kind == MEETING_UPDATE:
        written = await actions.update_meeting(
            session,
            actor,
            uuid.UUID(payload["meeting_id"]),
            MeetingUpdate.model_validate(payload["changes"]),
        )
        return _target("meeting", written.meeting.id), written.follow_ups
    if action.kind == SUPPLEMENT_CREATE:
        created = await actions.create_estimate(
            session, actor, EstimateCreate.model_validate(payload)
        )
        return _target("supplement", created.estimate.id), created.follow_ups
    if action.kind == SUPPLEMENT_UPDATE:
        updated = await actions.update_estimate(
            session,
            actor,
            uuid.UUID(payload["supplement_id"]),
            EstimateUpdate.model_validate(payload["changes"]),
        )
        return _target("supplement", updated.estimate.id), updated.follow_ups
    if action.kind == SUPPLEMENT_ADD_LINES:
        supplement_id = uuid.UUID(payload["supplement_id"])
        positions = [(int(room), int(item)) for room, item in payload["positions"]]
        # Checked again here, under the supplement's row lock: a photo can be uploaded
        # between the proposal and the approval, and the fingerprint does not cover
        # photos.
        photos = await attachment_service.photo_positions(session, actor, supplement_id)
        if line_additions.photos_in_the_way(positions, photos):
            raise _CommitFailed(_photos_in_the_way("saved"))
        rooms = EstimateUpdate.model_validate({"rooms": payload["rooms"]})
        added = await actions.update_estimate(session, actor, supplement_id, rooms)
        return _target("supplement", added.estimate.id), added.follow_ups
    if action.kind == SUPPLEMENT_TRANSITION:
        moved = await actions.transition_estimate(
            session, actor, uuid.UUID(payload["supplement_id"]), payload["action"]
        )
        return _target("supplement", moved.estimate.id), moved.follow_ups
    if action.kind == SUPPLEMENT_SUBMIT:
        sent = await actions.submit_estimate_for_review(
            session, actor, uuid.UUID(payload["supplement_id"])
        )
        return _target("supplement", sent.submission.estimate.id), sent.follow_ups
    if action.kind == MEMORY_CHANGE:
        memory_id = uuid.UUID(payload["memory_id"])
        if payload.get("content") is None:
            await agent_memory_service.delete_memory(session, actor, memory_id)
        else:
            await agent_memory_service.rewrite_memory(session, actor, memory_id, payload["content"])
        return _target("memory", memory_id), []
    raise _CommitFailed(f"Nothing knows how to commit a {action.kind!r} proposal.")


def _target(kind: str, record_id: uuid.UUID) -> dict[str, Any]:
    return {"type": kind, "id": str(record_id)}


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
    elif action.target_type == "supplement":
        estimate = await estimate_service.get_estimate(
            session, actor, action.target_id, for_update=True
        )
        current = fingerprint_estimate(estimate)
    elif action.target_type == "memory":
        memory = await agent_memory_service.get_memory(
            session, actor, action.target_id, for_update=True
        )
        current = fingerprint_memory(memory)
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
