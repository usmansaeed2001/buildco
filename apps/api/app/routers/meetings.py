"""Meeting endpoints."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Path, Query, status

from app.deps import CurrentUser, DbSession, Elevated
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
    start_after: Annotated[datetime | None, Query(alias="from")] = None,
    start_before: Annotated[datetime | None, Query(alias="to")] = None,
    project_id: Annotated[uuid.UUID | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[MeetingOut]:
    """Meetings in ascending time order.

    Use ``from`` and ``to`` to window a calendar view. The calendar is shared across
    the team, so this is not filtered by role.
    """
    rows = await meeting_service.list_meetings(
        db,
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
    meeting = await meeting_service.get_meeting(db, meeting_id)
    return MeetingOut.model_validate(meeting)


@router.post("", response_model=MeetingOut, status_code=status.HTTP_201_CREATED)
async def create_meeting(
    body: MeetingCreate, db: DbSession, background: BackgroundTasks, actor: Elevated
) -> MeetingOut:
    """Schedule a meeting and invite attendees.

    Supply ``google_access_token`` — a short-lived OAuth token from the Firebase Google
    provider carrying the ``calendar.events`` scope — to attach a Google Meet
    conference. Without it the meeting is still created and invited, just without a
    video link.
    """
    payload = body.model_dump(exclude={"attendee_ids", "google_access_token"})
    meeting, bundle = await meeting_service.create_meeting(
        db,
        actor,
        data=payload,
        attendee_ids=body.attendee_ids,
        google_access_token=body.google_access_token,
    )
    _send_invites(background, bundle, f"📅 Meeting invite: {meeting.title}", "meeting_invite.html")
    return MeetingOut.model_validate(meeting)


@router.patch("/{meeting_id}", response_model=MeetingOut)
async def update_meeting(
    body: MeetingUpdate,
    db: DbSession,
    background: BackgroundTasks,
    actor: Elevated,
    meeting_id: Annotated[uuid.UUID, Path()],
) -> MeetingOut:
    """Update a meeting.

    Attendees are re-invited only when the time, location, title, or attendee list
    actually changed — recolouring a meeting does not email everyone.
    """
    meeting = await meeting_service.get_meeting(db, meeting_id)
    changes = body.model_dump(exclude_unset=True, exclude={"attendee_ids", "google_access_token"})
    meeting, bundle = await meeting_service.update_meeting(
        db, actor, meeting, changes=changes, attendee_ids=body.attendee_ids
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
    actor: Elevated,
    meeting_id: Annotated[uuid.UUID, Path()],
    google_access_token: Annotated[str | None, Query(max_length=4000)] = None,
) -> Ack:
    """Cancel a meeting and send attendees a cancellation for their calendars."""
    meeting = await meeting_service.get_meeting(db, meeting_id)
    title = meeting.title
    bundle = await meeting_service.delete_meeting(
        db, actor, meeting, google_access_token=google_access_token
    )
    _send_invites(background, bundle, f"❌ Meeting cancelled: {title}", "meeting_cancelled.html")
    return Ack()
