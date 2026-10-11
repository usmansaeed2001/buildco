"""The writes that have more than one caller, each as a single function.

A handler used to be the only way to perform these, and it showed: the router shaped the
request, called the service, and then built and queued the email itself. Anything else
that called the service directly would have created a meeting that invited nobody, or
submitted an estimate that no reviewer ever heard about.

Each function here is the whole action. It takes the acting user and the same request
model the HTTP API validates, takes the row lock on what it is about to change, calls
the service (which runs every permission and state check), and hands back the result
together with the work owed once the transaction has committed. Callers differ only in
how they run that work: a route puts it on ``BackgroundTasks``; anything else awaits it
after its own commit.

Three rules keep this honest:

- **Nothing here checks a permission.** The services do. An action that re-decided who
  may do what would be a second copy of the rule, and second copies drift.
- **Nothing here sends anything.** A ``FollowUp`` is a description of work, built while
  the session is open so that running it needs no database.
- **Deletes are not here.** Trashing an estimate and cancelling a meeting have exactly
  one caller each and stay in their routers.
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.estimate import Estimate
from app.models.meeting import Meeting
from app.models.profile import Profile
from app.schemas.estimate import EstimateCreate, EstimateUpdate
from app.schemas.meeting import MeetingCreate, MeetingUpdate
from app.services import estimate_service, meeting_service, notifications
from app.services.estimate_service import SubmissionResult
from app.services.integrations import slack
from app.services.integrations.email import EmailAttachment
from app.services.meeting_service import InviteBundle
from app.services.rules.estimate_totals import EstimateTotals, line_total


@dataclass(frozen=True, slots=True)
class FollowUp:
    """One piece of work owed after the transaction commits: an email, a Slack post.

    Never run one before the commit. If the transaction then rolled back, the reviewer
    would hold a link to a submission that does not exist.
    """

    func: Callable[..., Awaitable[object]]
    args: tuple[Any, ...] = ()
    kwargs: dict[str, Any] = field(default_factory=dict)

    async def run(self) -> None:
        await self.func(*self.args, **self.kwargs)


@dataclass(frozen=True, slots=True)
class MeetingWritten:
    meeting: Meeting
    follow_ups: list[FollowUp] = field(default_factory=list)
    #: Removed people this write took off the meeting. Empty for a create.
    dropped: list[Profile] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class EstimateWritten:
    estimate: Estimate
    follow_ups: list[FollowUp] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class EstimateSubmitted:
    submission: SubmissionResult
    #: Computed once here and reused for the response, so the email and the screen
    #: cannot show different numbers.
    totals: EstimateTotals
    follow_ups: list[FollowUp] = field(default_factory=list)


# ── Meetings ──────────────────────────────────────────────────────────────────

_MEETING_ONLY_ARGUMENTS = {"attendee_ids", "attendee_emails", "google_access_token"}


def _invites(bundle: InviteBundle | None, subject: str, template: str) -> list[FollowUp]:
    """The invite email with its .ics attachment, or nothing if there is nobody to tell."""
    if bundle is None or not bundle.recipients:
        return []
    return [
        FollowUp(
            notifications.notify_many,
            (bundle.recipients, subject, template, bundle.context),
            {
                "attachments": [
                    EmailAttachment(
                        filename=bundle.ics_filename,
                        content=bundle.ics.encode("utf-8"),
                        content_type="text/calendar",
                    )
                ]
            },
        )
    ]


async def create_meeting(
    session: AsyncSession, actor: Profile, body: MeetingCreate
) -> MeetingWritten:
    """Schedule a meeting and prepare its invites. Open to any signed-in user."""
    meeting, bundle = await meeting_service.create_meeting(
        session,
        actor,
        data=body.model_dump(exclude=_MEETING_ONLY_ARGUMENTS),
        attendee_ids=body.attendee_ids,
        attendee_emails=list(body.attendee_emails),
        google_access_token=body.google_access_token,
    )
    return MeetingWritten(
        meeting=meeting,
        follow_ups=_invites(bundle, f"📅 Meeting invite: {meeting.title}", "meeting_invite.html"),
    )


async def update_meeting(
    session: AsyncSession, actor: Profile, meeting_id: uuid.UUID, body: MeetingUpdate
) -> MeetingWritten:
    """Change a meeting, re-inviting only when something attendees care about moved.

    The meeting is loaded under its row lock, so two edits made at the same moment are
    applied one after the other and the second works from what the first left. That
    matters most for an edit to the attendee list alone, which writes nothing to the
    ``meetings`` row and would not otherwise wait for anything.
    """
    meeting = await meeting_service.get_meeting(session, actor, meeting_id, for_update=True)
    meeting, bundle, dropped = await meeting_service.update_meeting(
        session,
        actor,
        meeting,
        changes=body.model_dump(exclude_unset=True, exclude=_MEETING_ONLY_ARGUMENTS),
        attendee_ids=body.attendee_ids,
        attendee_emails=None if body.attendee_emails is None else list(body.attendee_emails),
    )
    return MeetingWritten(
        meeting=meeting,
        follow_ups=_invites(bundle, f"📅 Meeting updated: {meeting.title}", "meeting_invite.html"),
        dropped=dropped,
    )


# ── Estimates ─────────────────────────────────────────────────────────────────


def _rooms_document(body: EstimateCreate | EstimateUpdate) -> list[dict[str, Any]]:
    """The rooms as they are stored: camelCase keys, JSON-safe values."""
    return [room.model_dump(by_alias=True, mode="json") for room in body.rooms or []]


async def create_estimate(
    session: AsyncSession, actor: Profile, body: EstimateCreate
) -> EstimateWritten:
    """Create an estimate owned by the actor. Nothing is sent to anyone."""
    payload = body.model_dump()
    payload["rooms"] = _rooms_document(body)
    return EstimateWritten(await estimate_service.create_estimate(session, actor, payload))


async def update_estimate(
    session: AsyncSession, actor: Profile, estimate_id: uuid.UUID, body: EstimateUpdate
) -> EstimateWritten:
    """Apply a partial update to an estimate's contents, under its row lock."""
    changes = body.model_dump(exclude_unset=True)
    if body.rooms is not None:
        changes["rooms"] = _rooms_document(body)
    return EstimateWritten(
        await estimate_service.update_estimate(session, actor, estimate_id, changes)
    )


async def transition_estimate(
    session: AsyncSession, actor: Profile, estimate_id: uuid.UUID, action: str
) -> EstimateWritten:
    """Move an estimate through its status state machine, under its row lock."""
    estimate, transition = await estimate_service.apply_transition(
        session, actor, estimate_id, action
    )

    follow_ups: list[FollowUp] = []
    if transition.notifies_admins:
        follow_ups.append(
            FollowUp(
                notifications.notify_admins,
                (
                    f"🔒 Estimate locked — {estimate.project_name} ({estimate.identifier})",
                    "notice.html",
                    {
                        "badge": "Estimate Locked",
                        "tone": "red",
                        "headline": estimate.project_name,
                        "body": "This estimate has been locked. Only the owner can unlock it.",
                        "rows": [
                            ("Claim ID", estimate.identifier),
                            ("Locked by", actor.display_name),
                        ],
                    },
                ),
                {"exclude_id": actor.id, "pref": "estimate_locked"},
            )
        )
    return EstimateWritten(estimate, follow_ups)


async def submit_estimate_for_review(
    session: AsyncSession, actor: Profile, estimate_id: uuid.UUID
) -> EstimateSubmitted:
    """Send an estimate to the configured reviewer, under its row lock.

    Owes two things afterwards: the reviewer's email, carrying the approval links, and
    the Slack post. Both wait for the commit, so a slow provider cannot fail a
    submission that has already been recorded.
    """
    result = await estimate_service.submit_for_review(session, actor, estimate_id)
    estimate = result.estimate
    reviewer = result.reviewer
    totals = estimate_service.totals_for(estimate)

    email = FollowUp(
        notifications.notify_one,
        (
            reviewer.email,
            f"📋 Estimate for review — {estimate.project_name} ({estimate.identifier})",
            "estimate_review_request.html",
            {
                "project_name": estimate.project_name,
                "identifier": estimate.identifier,
                "client_name": estimate.client_name,
                "insurance_carrier": estimate.insurance_carrier,
                "pm_name": estimate.pm_name,
                "submitted_by": actor.display_name,
                "submitted_at": (
                    estimate.submitted_at.strftime("%d %b %Y, %H:%M UTC")
                    if estimate.submitted_at
                    else ""
                ),
                "recipient_name": reviewer.display_name,
                "totals": totals,
                "rooms": _rooms_for_email(estimate, totals),
                "approve_url": result.approve_url,
                "changes_url": result.changes_url,
                "reject_url": result.reject_url,
            },
        ),
    )
    posted = FollowUp(
        slack.post_estimate_submitted,
        kwargs={
            "project_name": estimate.project_name,
            "identifier": estimate.identifier,
            "client_name": estimate.client_name,
            "submitted_by": actor.display_name,
            "recipient_email": reviewer.email,
        },
    )
    return EstimateSubmitted(submission=result, totals=totals, follow_ups=[email, posted])


def _rooms_for_email(estimate: Estimate, totals: EstimateTotals) -> list[dict[str, object]]:
    """Flatten the rooms document into the shape the review template iterates.

    Pairing each stored room with its computed total here means the template does no
    arithmetic, which is what kept the legacy email's numbers and the app's numbers
    from ever being compared.
    """
    rendered: list[dict[str, object]] = []
    for index, raw_room in enumerate(estimate.rooms or []):
        if not isinstance(raw_room, dict):
            continue
        room_total = totals.rooms[index].total if index < len(totals.rooms) else 0
        items = []
        for raw_item in raw_room.get("items") or []:
            if not isinstance(raw_item, dict):
                continue
            quantity = raw_item.get("quantity", 0)
            unit_cost = raw_item.get("unitCost", raw_item.get("unit_cost", 0))
            items.append(
                {
                    "name": raw_item.get("name", ""),
                    "unit": raw_item.get("unit", ""),
                    "quantity": quantity,
                    "unit_cost": unit_cost,
                    "total": line_total(quantity, unit_cost),
                }
            )
        rendered.append(
            {
                "name": raw_room.get("name", "Untitled room"),
                "total": room_total,
                "items": items,
            }
        )
    return rendered
