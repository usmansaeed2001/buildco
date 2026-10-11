"""BuildCo Assistant: REST endpoints.

These are served by the API service and reach the browser through the ordinary
same-origin path. The voice stream itself is a WebSocket on a different service; see
``app/agent/live.py``.

Every endpoint here is scoped to the caller's own rows. Nobody, owners and admins
included, can read another person's conversation.
"""

from __future__ import annotations

import uuid
from typing import Annotated
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Path, status

from app.deps import CurrentUser, DbSession
from app.schemas.agent import (
    AgentActionOut,
    AgentConversationOut,
    AgentLimitsOut,
    AgentMessageOut,
    AgentSessionCreate,
    AgentSessionOut,
    AgentStatusOut,
)
from app.services import agent_service

router = APIRouter(prefix="/agent", tags=["agent"])


@router.get("/status", response_model=AgentStatusOut)
async def agent_status(user: CurrentUser) -> AgentStatusOut:
    """Whether the assistant is offered to the caller.

    False when it is switched off, and false for anyone not on the pilot list while the
    audience is ``pilot``. The browser draws the launcher from this, so a person who is
    not offered it never sees it.
    """
    current = agent_service.status_for(user)
    return AgentStatusOut(enabled=current.enabled, max_session_seconds=current.max_session_seconds)


@router.post("/sessions", response_model=AgentSessionOut, status_code=status.HTTP_201_CREATED)
async def create_session(
    body: AgentSessionCreate, db: DbSession, user: CurrentUser
) -> AgentSessionOut:
    """Start a conversation and get the ticket that opens its WebSocket.

    503 when the assistant is switched off; 403 for a caller outside the pilot list.
    Starting a conversation ends any other the caller has open, for instance in another
    tab.

    The ticket is single-use and expires in a minute. It exists because a browser cannot
    send an ``Authorization`` header on a WebSocket, and an ID token in a URL would end
    up in request logs.
    """
    try:
        ZoneInfo(body.client_timezone)
        timezone = body.client_timezone
    except (ZoneInfoNotFoundError, ValueError):
        timezone = "UTC"

    issued = await agent_service.create_session(db, user, client_timezone=timezone)
    return AgentSessionOut(
        conversation_id=issued.conversation.id,
        ws_url=issued.ws_url,
        ticket=issued.ticket,
        limits=AgentLimitsOut(
            max_session_seconds=agent_service.status_for(user).max_session_seconds
        ),
    )


@router.get("/conversations/{conversation_id}", response_model=AgentConversationOut)
async def get_conversation(
    db: DbSession, user: CurrentUser, conversation_id: Annotated[uuid.UUID, Path()]
) -> AgentConversationOut:
    """One of the caller's own conversations, with its transcript and its actions.

    Also how the panel learns what became of the last action after a dropped connection.
    Someone else's conversation is a 404.
    """
    record = await agent_service.get_conversation(db, user, conversation_id)
    out = AgentConversationOut.model_validate(record.conversation)
    out.messages = [AgentMessageOut.model_validate(message) for message in record.messages]
    out.actions = [AgentActionOut.model_validate(action) for action in record.actions]
    return out
