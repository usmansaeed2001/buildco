"""Meeting endpoints."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Path, Query, status

from app.deps import CurrentUser, DbSession
from app.models.enums import MeetingScope
from app.schemas.common import Ack
from app.schemas.meeting import MeetingCreate, MeetingOut, MeetingUpdate
from app.services import meeting_service, notifications
from app.services.integrations.email import EmailAttachment
from app.services.meeting_service import InviteBundle

router = APIRouter(prefix="/meetings", tags=["meetings"])


def _send_invites(
    background: BackgroundTasks, bundle: InviteBundle, subject: str, template: str
) -> None:
    """Queue calendar invites with their .ics attachment."""
    if not bundle.recipients:
        return
    background.add_task(
        notifications.notify_many,
        bundle.recipients,
        subject,
        template,
        bundle.context,
        attachments=[
            EmailAttachment(
                filename=bundle.ics_filename,
                content=bundle.ics.encode("utf-8"),
                content_type="text/calendar",
            )
        ],
    )


@router.get("", response_model=list[MeetingOut])
async def list_meetings(
    db: DbSession,
    user: CurrentUser,
    scope: Annotated[MeetingScope, Query()] = MeetingScope.ALL,
    start_after: Annotated[datetime | None, Query(alias="from")] = None,
    start_before: Annotated[datetime | None, Query(alias="to")] = None,
    project_id: Annotated[uuid.UUID | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[MeetingOut]:
    """Meetings in ascending time order, scoped to what the caller may see.

    Use ``from`` and ``to`` to window a calendar view, and ``scope`` to narrow it to
    meetings the caller created (``mine``) or was invited to (``invited``).

    ``scope=all`` returns the whole team calendar for owners and admins. For anyone else
    it is silently clamped to mine-or-invited — the calendar is **no longer shared with
    every member**, which is a deliberate reversal of the original design. See
    ``meeting_service.list_meetings``.
    """
    rows = await meeting_service.list_meetings(
        db,
        user,
        scope=scope,
        start_after=start_after,
        start_before=start_before,
        project_id=project_id,
        limit=limit,
        offset=offset,
    )
    return [MeetingOut.model_validate(m) for m in rows]


@router.get("/{meeting_id}", response_model=MeetingOut)
async def get_meeting(
    db: DbSession, user: CurrentUser, meeting_id: Annotated[uuid.UUID, Path()]
) -> MeetingOut:
    meeting = await meeting_service.get_meeting(db, user, meeting_id)
    return MeetingOut.model_validate(meeting)


@router.post("", response_model=MeetingOut, status_code=status.HTTP_201_CREATED)
async def create_meeting(
    body: MeetingCreate, db: DbSession, background: BackgroundTasks, actor: CurrentUser
) -> MeetingOut:
    """Schedule a meeting and invite attendees.

    Open to any authenticated user. It used to be elevated-only, which made "meetings I
    created" an empty category for most of the team and left members unable to put their
    own work on the calendar at all. Editing and cancelling stay narrower — see
    ``PATCH``.

    Supply ``google_access_token`` — a short-lived OAuth token from the Firebase Google
    provider carrying the ``calendar.events`` scope — to attach a Google Meet
    conference. Without it the meeting is still created and invited, just without a
    video link.

    ``attendee_ids`` invites team members; ``attendee_emails`` invites anyone else by
    address. Both receive the same email and .ics.
    """
    payload = body.model_dump(exclude={"attendee_ids", "attendee_emails", "google_access_token"})
    meeting, bundle = await meeting_service.create_meeting(
        db,
        actor,
        data=payload,
        attendee_ids=body.attendee_ids,
        attendee_emails=list(body.attendee_emails),
        google_access_token=body.google_access_token,
    )
    _send_invites(background, bundle, f"📅 Meeting invite: {meeting.title}", "meeting_invite.html")
    return MeetingOut.model_validate(meeting)


@router.patch("/{meeting_id}", response_model=MeetingOut)
async def update_meeting(
    body: MeetingUpdate,
    db: DbSession,
    background: BackgroundTasks,
    actor: CurrentUser,
    meeting_id: Annotated[uuid.UUID, Path()],
) -> MeetingOut:
    """Update a meeting.

    A meeting may be changed by whoever created it, or by any owner or admin. Being
    *invited* to one is not enough: an attendee who could move the time would re-invite
    everyone else from an account they would not expect it from.

    Attendees are re-invited only when the time, location, title, or attendee list
    actually changed — recolouring a meeting does not email everyone.
    """
    meeting = await meeting_service.get_meeting(db, actor, meeting_id)
    meeting_service.require_manageable(actor, meeting)
    changes = body.model_dump(
        exclude_unset=True, exclude={"attendee_ids", "attendee_emails", "google_access_token"}
    )
    meeting, bundle = await meeting_service.update_meeting(
        db,
        actor,
        meeting,
        changes=changes,
        attendee_ids=body.attendee_ids,
        attendee_emails=None if body.attendee_emails is None else list(body.attendee_emails),
    )
    if bundle is not None:
        _send_invites(
            background,
            bundle,
            f"📅 Meeting updated: {meeting.title}",
            "meeting_invite.html",
        )
    return MeetingOut.model_validate(meeting)


@router.delete("/{meeting_id}", response_model=Ack)
async def delete_meeting(
    db: DbSession,
    background: BackgroundTasks,
    actor: CurrentUser,
    meeting_id: Annotated[uuid.UUID, Path()],
    google_access_token: Annotated[str | None, Query(max_length=4000)] = None,
) -> Ack:
    """Cancel a meeting and send attendees a cancellation for their calendars.

    Same rule as ``PATCH``: the creator, or an owner or admin.
    """
    meeting = await meeting_service.get_meeting(db, actor, meeting_id)
    meeting_service.require_manageable(actor, meeting)
    title = meeting.title
    bundle = await meeting_service.delete_meeting(
        db, actor, meeting, google_access_token=google_access_token
    )
    _send_invites(background, bundle, f"❌ Meeting cancelled: {title}", "meeting_cancelled.html")
    return Ack()
