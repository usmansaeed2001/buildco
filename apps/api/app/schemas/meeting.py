"""Meeting schemas."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import EmailStr, Field, model_validator

from app.schemas.common import ActorRef, ORMSchema, Schema

HEX_COLOR = r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$"

#: Ceiling on outside addresses per meeting. Anyone signed in may schedule a meeting,
#: so this is also the most mail one request can send from the BuildCo sender.
MAX_GUESTS = 50


class MeetingBase(Schema):
    title: str = Field(min_length=1, max_length=300)
    description: str = Field(default="", max_length=10_000)
    location: str = Field(default="", max_length=500)
    start_time: datetime
    end_time: datetime
    color: str = Field(default="#3B82F6", pattern=HEX_COLOR)
    project_id: uuid.UUID | None = None
    attendee_ids: list[uuid.UUID] = Field(default_factory=list, max_length=100)
    #: People outside the team, invited by address alone. They get the email and the
    #: .ics like anyone else but have no account, so the meeting never appears to them
    #: in the app. An address that turns out to belong to a team member is treated as
    #: that member — see ``meeting_service._resolve_invitees``.
    attendee_emails: list[EmailStr] = Field(default_factory=list, max_length=MAX_GUESTS)

    @model_validator(mode="after")
    def _end_after_start(self) -> MeetingBase:
        if self.end_time <= self.start_time:
            raise ValueError("end_time must be after start_time")
        return self


class MeetingCreate(MeetingBase):
    """Creating a meeting.

    ``google_access_token`` is a short-lived OAuth token the client obtained from the
    Firebase Google provider with the ``calendar.events`` scope. It is used once, to
    create the Meet conference, and never stored. Omitting it produces a perfectly
    valid meeting with no Meet link.
    """

    google_access_token: str | None = Field(default=None, max_length=4000)


class MeetingUpdate(Schema):
    """Partial update.

    ``attendee_ids`` and ``attendee_emails`` are independent: supplying one replaces that
    half of the attendee list wholesale and leaves the other half alone.
    """

    title: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = Field(default=None, max_length=10_000)
    location: str | None = Field(default=None, max_length=500)
    start_time: datetime | None = None
    end_time: datetime | None = None
    color: str | None = Field(default=None, pattern=HEX_COLOR)
    project_id: uuid.UUID | None = None
    attendee_ids: list[uuid.UUID] | None = Field(default=None, max_length=100)
    attendee_emails: list[EmailStr] | None = Field(default=None, max_length=MAX_GUESTS)
    google_access_token: str | None = Field(default=None, max_length=4000)


class AttendeeOut(ORMSchema):
    """One invitee. ``user_id`` and ``profile`` are null for a guest invited by email."""

    id: uuid.UUID
    user_id: uuid.UUID | None = None
    email: str
    name: str
    profile: ActorRef | None = None


class MeetingOut(ORMSchema):
    id: uuid.UUID
    title: str
    description: str
    location: str
    start_time: datetime
    end_time: datetime
    color: str
    project_id: uuid.UUID | None = None
    meet_link: str | None = None
    google_event_id: str | None = None
    created_by: uuid.UUID | None = None
    creator: ActorRef | None = None
    attendees: list[AttendeeOut] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime
