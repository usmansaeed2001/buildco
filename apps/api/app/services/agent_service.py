"""BuildCo Assistant: conversations, session tickets, and the transcript.

The voice stream cannot ride the API's ordinary path. Firebase Hosting's ``/api/**``
rewrite does not proxy WebSockets, so the browser connects straight to a Cloud Run URL,
and a browser cannot put an ``Authorization`` header on a WebSocket. A Firebase ID token
in the URL would end up in request logs. So a conversation starts in two steps:

1. An ordinary authenticated request creates the conversation and gets a **ticket**.
2. The browser opens the socket with that ticket, once.

The ticket is single-use, lives for a minute, and is stored only as a hash. It lives in
the database rather than in memory because the service that issues it and the service
that redeems it are different Cloud Run services.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.errors import AppError, Forbidden, IntegrationUnavailable, NotFound, Unauthorized
from app.logging import get_logger
from app.models.agent import AgentAction, AgentConversation, AgentMessage
from app.models.enums import (
    AgentConversationStatus,
    AgentEndReason,
    AgentMessageRole,
    AgentMessageSource,
)
from app.models.profile import Profile
from app.services.rules import agent_rules

log = get_logger(__name__)

#: How much of the first thing the user said becomes the conversation's title.
TITLE_LENGTH = 80


def _hash_ticket(ticket: str) -> str:
    return hashlib.sha256(ticket.encode("utf-8")).hexdigest()


def _as_utc(value: datetime) -> datetime:
    """SQLite hands back naive datetimes; everything stored is UTC."""
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


# ── Who is offered it ─────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class AgentStatus:
    #: Whether this person may start a conversation. The launcher is drawn from this.
    enabled: bool
    max_session_seconds: int


def status_for(user: Profile) -> AgentStatus:
    """What the browser needs to decide whether to offer the assistant at all.

    Checked here and at session creation, both on the API service. The WebSocket
    service trusts the ticket and holds no copy of the pilot list, so there is one
    place to set it and nothing to drift.
    """
    settings = get_settings()
    return AgentStatus(
        enabled=agent_rules.offered_to(
            user.email,
            enabled=settings.agent_enabled,
            audience=settings.agent_audience,
            pilot_emails=settings.agent_pilot_emails,
        ),
        max_session_seconds=settings.agent_max_session_seconds,
    )


# ── Starting a conversation ───────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class IssuedSession:
    conversation: AgentConversation
    #: Shown to the browser once and never stored.
    ticket: str
    ws_url: str


async def create_session(
    session: AsyncSession, user: Profile, *, client_timezone: str
) -> IssuedSession:
    """Create a conversation and the ticket that opens its socket.

    Starting a conversation ends any other this person has, in the same transaction,
    with the reason ``superseded``. One live conversation per person is what stops two
    tabs from running, and paying for, two at once; the partial unique index on the
    table is what makes that hold when the two requests land on different instances.
    """
    settings = get_settings()
    if not settings.agent_enabled:
        raise IntegrationUnavailable("BuildCo Assistant is not switched on.")
    if not status_for(user).enabled:
        raise Forbidden("BuildCo Assistant is not available to your account yet.")

    now = datetime.now(UTC)
    await session.execute(
        update(AgentConversation)
        .where(
            AgentConversation.user_id == user.id,
            AgentConversation.status.in_(
                [AgentConversationStatus.PENDING.value, AgentConversationStatus.ACTIVE.value]
            ),
        )
        .values(
            status=AgentConversationStatus.ENDED.value,
            ended_at=now,
            end_reason=AgentEndReason.SUPERSEDED.value,
        )
    )

    ticket = secrets.token_urlsafe(32)
    conversation = AgentConversation(
        user_id=user.id,
        status=AgentConversationStatus.PENDING.value,
        ticket_hash=_hash_ticket(ticket),
        ticket_expires_at=now + timedelta(seconds=settings.agent_ticket_ttl_seconds),
        model=settings.agent_model,
        client_timezone=client_timezone,
    )
    session.add(conversation)
    await session.flush()

    log.info("agent_session_created", conversation_id=str(conversation.id), user=str(user.id))
    prefix = settings.api_v1_prefix
    return IssuedSession(
        conversation=conversation,
        ticket=ticket,
        ws_url=f"{settings.agent_ws_base_url}{prefix}/agent/live",
    )


class TicketRefused(AppError):
    """The ticket does not open a socket. Deliberately says no more than that."""

    status_code = Unauthorized.status_code
    code = "unauthorized"
    default_message = "This session ticket is not valid."


async def redeem_ticket(session: AsyncSession, ticket: str) -> tuple[AgentConversation, Profile]:
    """Exchange a ticket for its conversation and the person it belongs to, once.

    Refused when the ticket is unknown, already used, expired, belongs to a
    conversation that has since ended, or belongs to someone who has been removed.
    Every refusal looks the same from outside.

    Looked up by hash, then compared in constant time, the same pattern as invitation
    tokens. Redeeming marks the conversation ``active``.
    """
    presented = _hash_ticket(ticket)
    conversation = await session.scalar(
        select(AgentConversation)
        .where(AgentConversation.ticket_hash == presented)
        .with_for_update()
    )
    if conversation is None or not secrets.compare_digest(
        conversation.ticket_hash or "", presented
    ):
        raise TicketRefused()

    now = datetime.now(UTC)
    expires = conversation.ticket_expires_at
    if (
        conversation.ticket_used_at is not None
        or expires is None
        or _as_utc(expires) < now
        or conversation.status != AgentConversationStatus.PENDING.value
    ):
        raise TicketRefused()

    profile = await session.get(Profile, conversation.user_id)
    if profile is None or profile.is_banned:
        raise TicketRefused()

    conversation.ticket_used_at = now
    conversation.status = AgentConversationStatus.ACTIVE.value
    conversation.started_at = now
    conversation.last_heartbeat_at = now
    await session.flush()
    return conversation, profile


async def end_conversation(
    session: AsyncSession, conversation_id: uuid.UUID, reason: AgentEndReason
) -> None:
    """Mark a conversation ended. A conversation that has already ended keeps its reason."""
    await session.execute(
        update(AgentConversation)
        .where(
            AgentConversation.id == conversation_id,
            AgentConversation.status != AgentConversationStatus.ENDED.value,
        )
        .values(
            status=AgentConversationStatus.ENDED.value,
            ended_at=datetime.now(UTC),
            end_reason=reason.value,
        )
    )
    log.info("agent_session_ended", conversation_id=str(conversation_id), reason=reason.value)


async def is_still_active(session: AsyncSession, conversation_id: uuid.UUID) -> bool:
    status = await session.scalar(
        select(AgentConversation.status).where(AgentConversation.id == conversation_id)
    )
    return status == AgentConversationStatus.ACTIVE.value


# ── Transcript ────────────────────────────────────────────────────────────────


async def append_message(
    session: AsyncSession,
    conversation_id: uuid.UUID,
    *,
    role: AgentMessageRole,
    source: AgentMessageSource,
    text: str,
) -> AgentMessage:
    """Record one finished utterance. Final transcripts only, and never audio.

    The first thing the user says also becomes the conversation's title, which is what
    the history list shows.
    """
    last = await session.scalar(
        select(func.max(AgentMessage.seq)).where(AgentMessage.conversation_id == conversation_id)
    )
    message = AgentMessage(
        conversation_id=conversation_id,
        seq=(last or 0) + 1,
        role=role.value,
        source=source.value,
        text=text,
    )
    session.add(message)

    if role is AgentMessageRole.USER:
        await session.execute(
            update(AgentConversation)
            .where(AgentConversation.id == conversation_id, AgentConversation.title == "")
            .values(title=text[:TITLE_LENGTH])
        )
    await session.flush()
    return message


# ── Reading one back ──────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class ConversationRecord:
    conversation: AgentConversation
    messages: list[AgentMessage]
    actions: list[AgentAction]


async def get_conversation(
    session: AsyncSession, user: Profile, conversation_id: uuid.UUID
) -> ConversationRecord:
    """One of the caller's own conversations, with its transcript and its actions.

    **Nobody sees anyone else's**, owners and admins included: it is a 404, not a 403,
    because that a conversation exists is itself the other person's business.

    This is also how the panel learns what became of the last action after a dropped
    connection, so that it never implies something was lost when it was saved.
    """
    conversation = await session.get(AgentConversation, conversation_id)
    if conversation is None or conversation.user_id != user.id:
        raise NotFound("Conversation not found.")

    messages = list(
        await session.scalars(
            select(AgentMessage)
            .where(AgentMessage.conversation_id == conversation_id)
            .order_by(AgentMessage.seq)
        )
    )
    actions = list(
        await session.scalars(
            select(AgentAction)
            .where(AgentAction.conversation_id == conversation_id)
            .order_by(AgentAction.created_at, AgentAction.id)
        )
    )
    return ConversationRecord(conversation=conversation, messages=messages, actions=actions)
