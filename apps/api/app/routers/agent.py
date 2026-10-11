"""BuildCo Assistant: REST endpoints.

These are served by the API service and reach the browser through the ordinary
same-origin path. The voice stream itself is a WebSocket on a different service; see
``app/agent/live.py``.

Every endpoint here is scoped to the caller's own rows. Nobody, owners and admins
included, can read another person's conversation or memories.
"""

from __future__ import annotations

import uuid
from typing import Annotated
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Path, Query, status

from app.deps import CurrentUser, DbSession
from app.schemas.agent import (
    AgentActionOut,
    AgentConversationOut,
    AgentConversationSummaryOut,
    AgentLimitsOut,
    AgentMemoryOut,
    AgentMessageOut,
    AgentSessionCreate,
    AgentSessionOut,
    AgentStatusOut,
)
from app.schemas.common import Ack, Limit, Offset, Page
from app.services import agent_memory_service, agent_service
from app.services.agent_service import IssuedSession

router = APIRouter(prefix="/agent", tags=["agent"])


@router.get("/status", response_model=AgentStatusOut)
async def agent_status(db: DbSession, user: CurrentUser) -> AgentStatusOut:
    """Whether the assistant is offered to the caller, and how much of today is left.

    ``enabled`` is false when it is switched off, and false for anyone not on the pilot
    list while the audience is ``pilot``. The browser draws the launcher from this, so a
    person who is not offered it never sees it.
    """
    current = await agent_service.status_for(db, user)
    allowance = current.allowance
    return AgentStatusOut(
        enabled=current.enabled,
        max_session_seconds=current.max_session_seconds,
        daily_limit_seconds=allowance.limit_seconds,
        used_seconds=allowance.used_seconds,
        remaining_seconds=allowance.remaining_seconds,
        resets_at=allowance.resets_at,
    )


async def _issued(db: DbSession, user: CurrentUser, issued: IssuedSession) -> AgentSessionOut:
    current = await agent_service.status_for(db, user)
    return AgentSessionOut(
        conversation_id=issued.conversation.id,
        ws_url=issued.ws_url,
        ticket=issued.ticket,
        limits=AgentLimitsOut(
            max_session_seconds=current.max_session_seconds,
            remaining_seconds=current.allowance.remaining_seconds,
        ),
    )


@router.post("/sessions", response_model=AgentSessionOut, status_code=status.HTTP_201_CREATED)
async def create_session(
    body: AgentSessionCreate, db: DbSession, user: CurrentUser
) -> AgentSessionOut:
    """Start a conversation and get the ticket that opens its WebSocket.

    503 when the assistant is switched off; 403 for a caller outside the pilot list;
    429 ``limit_reached`` when today's allowance is spent. Starting a conversation ends
    any other the caller has open, for instance in another tab.

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
    return await _issued(db, user, issued)


@router.post("/sessions/{conversation_id}/reconnect", response_model=AgentSessionOut)
async def reconnect(
    db: DbSession, user: CurrentUser, conversation_id: Annotated[uuid.UUID, Path()]
) -> AgentSessionOut:
    """A fresh ticket for a conversation whose connection dropped.

    Works for a minute after the drop. After that, and for any conversation that has
    ended, it is a 409: a conversation cannot be resumed. 429 when the allowance has
    run out in the meantime.
    """
    issued = await agent_service.reconnect(db, user, conversation_id)
    return await _issued(db, user, issued)


@router.get("/conversations", response_model=Page[AgentConversationSummaryOut])
async def list_conversations(
    db: DbSession,
    user: CurrentUser,
    limit: Annotated[Limit, Query()] = 20,
    offset: Annotated[Offset, Query()] = 0,
) -> Page[AgentConversationSummaryOut]:
    """The caller's own past conversations, newest first."""
    page = await agent_service.list_conversations(db, user, limit=limit, offset=offset)
    return Page[AgentConversationSummaryOut](
        items=[
            AgentConversationSummaryOut(
                id=entry.conversation.id,
                status=entry.conversation.status,
                title="" if entry.transcript_expired else entry.conversation.title,
                started_at=entry.conversation.started_at,
                ended_at=entry.conversation.ended_at,
                end_reason=entry.conversation.end_reason,
                duration_seconds=entry.conversation.live_seconds,
                action_count=entry.action_count,
                transcript_expired=entry.transcript_expired,
            )
            for entry in page.items
        ],
        total=page.total,
        limit=limit,
        offset=offset,
    )


@router.get("/conversations/{conversation_id}", response_model=AgentConversationOut)
async def get_conversation(
    db: DbSession, user: CurrentUser, conversation_id: Annotated[uuid.UUID, Path()]
) -> AgentConversationOut:
    """One of the caller's own conversations, with its transcript and its actions.

    Also how the panel learns what became of the last action after a dropped connection.
    Someone else's conversation is a 404. A transcript older than the retention period
    is not returned; the actions always are.
    """
    record = await agent_service.get_conversation(db, user, conversation_id)
    out = AgentConversationOut.model_validate(record.conversation)
    out.transcript_expired = record.transcript_expired
    if record.transcript_expired:
        out.title = ""
    out.messages = [AgentMessageOut.model_validate(message) for message in record.messages]
    out.actions = [AgentActionOut.model_validate(action) for action in record.actions]
    return out


@router.get("/memories", response_model=list[AgentMemoryOut])
async def list_memories(db: DbSession, user: CurrentUser) -> list[AgentMemoryOut]:
    """What the assistant remembers about the caller, oldest first."""
    rows = await agent_memory_service.list_memories(db, user)
    return [AgentMemoryOut.model_validate(row) for row in rows]


@router.delete("/memories/{memory_id}", response_model=Ack)
async def delete_memory(
    db: DbSession, user: CurrentUser, memory_id: Annotated[uuid.UUID, Path()]
) -> Ack:
    """Make the assistant forget one thing. Someone else's memory is a 404."""
    await agent_memory_service.delete_memory(db, user, memory_id)
    return Ack()
