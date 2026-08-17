"""Meeting schemas."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import Field, model_validator

from app.schemas.common import ActorRef, ORMSchema, Schema

HEX_COLOR = r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$"


class MeetingBase(Schema):
    title: str = Field(min_length=1, max_length=300)
    description: str = Field(default="", max_length=10_000)
    location: str = Field(default="", max_length=500)
    start_time: datetime
    end_time: datetime
    color: str = Field(default="#3B82F6", pattern=HEX_COLOR)
    project_id: uuid.UUID | None = None
    attendee_ids: list[uuid.UUID] = Field(default_factory=list, max_length=100)

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
    """Partial update. Supplying ``attendee_ids`` replaces the attendee list wholesale."""

    title: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = Field(default=None, max_length=10_000)
    location: str | None = Field(default=None, max_length=500)
    start_time: datetime | None = None
    end_time: datetime | None = None
    color: str | None = Field(default=None, pattern=HEX_COLOR)
    project_id: uuid.UUID | None = None
    attendee_ids: list[uuid.UUID] | None = Field(default=None, max_length=100)
    google_access_token: str | None = Field(default=None, max_length=4000)


class AttendeeOut(ORMSchema):
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
