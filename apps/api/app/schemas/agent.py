"""BuildCo Assistant: the REST contract. The voice stream has its own, over a WebSocket."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from app.schemas.common import ORMSchema, Schema


class AgentStatusOut(BaseModel):
    #: Whether the caller may start a conversation. The launcher is drawn from this.
    enabled: bool
    max_session_seconds: int


class AgentSessionCreate(Schema):
    #: The browser's IANA zone, e.g. ``America/Los_Angeles``. Dates the user speaks are
    #: read in it and read back in it. An unknown zone is treated as UTC.
    client_timezone: str = Field(default="UTC", max_length=64)


class AgentLimitsOut(BaseModel):
    max_session_seconds: int


class AgentSessionOut(BaseModel):
    conversation_id: uuid.UUID
    #: Where to open the WebSocket. Not this API's origin in production.
    ws_url: str
    #: Opens the socket once, within a minute. Never stored by the server in the clear.
    ticket: str
    limits: AgentLimitsOut


class AgentMessageOut(ORMSchema):
    seq: int
    role: str
    source: str
    text: str
    created_at: datetime


class AgentActionOut(ORMSchema):
    id: uuid.UUID
    kind: str
    status: str
    summary: str
    approval_policy: str
    approved_via: str | None
    #: What a commit produced, e.g. ``{"type": "meeting", "id": "…"}``.
    result: dict[str, Any] | None
    error: str | None
    created_at: datetime
    resolved_at: datetime | None


class AgentConversationOut(ORMSchema):
    id: uuid.UUID
    status: str
    title: str
    started_at: datetime | None
    ended_at: datetime | None
    end_reason: str | None
    messages: list[AgentMessageOut] = Field(default_factory=list)
    actions: list[AgentActionOut] = Field(default_factory=list)
