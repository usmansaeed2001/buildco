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

from fastapi import status as http_status
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.errors import (
    AppError,
    Conflict,
    Forbidden,
    IntegrationUnavailable,
    NotFound,
    Unauthorized,
)
from app.logging import get_logger
from app.models.agent import AgentAction, AgentConversation, AgentMessage
from app.models.enums import (
    AgentActionStatus,
    AgentConversationStatus,
    AgentEndReason,
    AgentMessageRole,
    AgentMessageSource,
)
from app.models.profile import Profile
from app.models.settings import SETTINGS_ROW_ID, TeamSettings
from app.services.rules import agent_rules

log = get_logger(__name__)

#: How much of the first thing the user said becomes the conversation's title.
TITLE_LENGTH = 80
#: How long a conversation whose socket vanished is held open for it to come back.
RECONNECT_WINDOW_SECONDS = 60
#: A conversation still ``active`` whose heartbeat is older than this was orphaned by an
#: instance that died. Longer than the reconnect window, during which no heartbeat runs.
STALE_HEARTBEAT_SECONDS = 90
#: How many expired transcripts one session start clears. Bounded, so that starting a
#: conversation never waits on a backlog; the purge script clears the rest.
PURGE_BATCH = 20


def _hash_ticket(ticket: str) -> str:
    return hashlib.sha256(ticket.encode("utf-8")).hexdigest()


def _as_utc(value: datetime) -> datetime:
    """SQLite hands back naive datetimes; everything stored is UTC."""
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


# ── Who is offered it ─────────────────────────────────────────────────────────


class LimitReached(AppError):
    """The day's allowance of conversation time is spent."""

    status_code = http_status.HTTP_429_TOO_MANY_REQUESTS
    code = "limit_reached"
    default_message = "Today's time with BuildCo Assistant has been used."


@dataclass(frozen=True, slots=True)
class Allowance:
    limit_seconds: int
    used_seconds: int
    #: When the allowance starts again: the next 00:00 UTC.
    resets_at: datetime

    @property
    def remaining_seconds(self) -> int:
        return agent_rules.remaining_seconds(self.limit_seconds, self.used_seconds)


async def team_limit_seconds(session: AsyncSession) -> int:
    """The team's daily allowance per person, in seconds. Zero means switched off.

    Read from the database every time, deliberately. An environment variable is fixed
    for the life of a revision, and an instance draining its sockets can run for an
    hour on old values; a row it reads every few seconds, it sees change.
    """
    minutes = await session.scalar(
        select(TeamSettings.agent_daily_minutes).where(TeamSettings.id == SETTINGS_ROW_ID)
    )
    return agent_rules.daily_limit_seconds(minutes, get_settings().agent_daily_minutes_default)


async def allowance_for(
    session: AsyncSession, user_id: uuid.UUID, *, now: datetime | None = None
) -> Allowance:
    """How much of today's allowance this person has used, and what is left.

    Counted from ``live_seconds``, which each live socket writes as it accrues, so a
    crash loses nothing. A conversation counts towards the day it started in. The day
    is the server's, in UTC: nothing the browser says can move it.
    """
    now = now or datetime.now(UTC)
    used = await session.scalar(
        select(func.coalesce(func.sum(AgentConversation.live_seconds), 0)).where(
            AgentConversation.user_id == user_id,
            AgentConversation.started_at >= agent_rules.day_start(now),
        )
    )
    return Allowance(
        limit_seconds=await team_limit_seconds(session),
        used_seconds=int(used or 0),
        resets_at=agent_rules.next_reset(now),
    )


@dataclass(frozen=True, slots=True)
class AgentStatus:
    #: Whether this person may start a conversation. The launcher is drawn from this.
    enabled: bool
    max_session_seconds: int
    allowance: Allowance


def offered_to(user: Profile) -> bool:
    """Whether the assistant exists for this person at all: switched on, and their turn.

    Checked here and at session creation, both on the API service. The WebSocket
    service trusts the ticket and holds no copy of the pilot list, so there is one
    place to set it and nothing to drift.
    """
    settings = get_settings()
    return agent_rules.offered_to(
        user.email,
        enabled=settings.agent_enabled,
        audience=settings.agent_audience,
        pilot_emails=settings.agent_pilot_emails,
    )


async def status_for(session: AsyncSession, user: Profile) -> AgentStatus:
    """What the browser needs to decide whether to offer the assistant, and what to show."""
    return AgentStatus(
        enabled=offered_to(user),
        max_session_seconds=get_settings().agent_max_session_seconds,
        allowance=await allowance_for(session, user.id),
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
    if not offered_to(user):
        raise Forbidden("BuildCo Assistant is not available to your account yet.")
    await _require_allowance(session, user)
    await purge_expired_transcripts(session, limit=PURGE_BATCH)

    now = datetime.now(UTC)
    await _drop_open_proposals(
        session,
        select(AgentConversation.id).where(
            AgentConversation.user_id == user.id,
            AgentConversation.status != AgentConversationStatus.ENDED.value,
        ),
    )
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


async def _require_allowance(session: AsyncSession, user: Profile) -> Allowance:
    allowance = await allowance_for(session, user.id)
    if allowance.remaining_seconds <= 0:
        log.info("agent_allowance_exhausted", user=str(user.id), at="session")
        raise LimitReached()
    return allowance


async def _drop_open_proposals(session: AsyncSession, conversations: object) -> None:
    """A proposal still open when its conversation ends is dropped, never committed."""
    await session.execute(
        update(AgentAction)
        .where(
            AgentAction.conversation_id.in_(conversations),  # type: ignore[arg-type]
            AgentAction.status == AgentActionStatus.PROPOSED.value,
        )
        .values(status=AgentActionStatus.CANCELLED.value, resolved_at=datetime.now(UTC))
    )


def _new_ticket(conversation: AgentConversation) -> str:
    ticket = secrets.token_urlsafe(32)
    conversation.ticket_hash = _hash_ticket(ticket)
    conversation.ticket_expires_at = datetime.now(UTC) + timedelta(
        seconds=get_settings().agent_ticket_ttl_seconds
    )
    conversation.ticket_used_at = None
    return ticket


async def reconnect(
    session: AsyncSession, user: Profile, conversation_id: uuid.UUID
) -> IssuedSession:
    """A fresh ticket for a conversation whose socket dropped, while it can still be had.

    This is recovery from a network blip, not resuming: a conversation that has ended
    cannot be reopened. It is refused once the minute's grace has passed, and checked
    against the allowance and the pilot list exactly as a new conversation is.
    """
    conversation = await session.scalar(
        select(AgentConversation)
        .where(AgentConversation.id == conversation_id, AgentConversation.user_id == user.id)
        .with_for_update()
    )
    if conversation is None:
        raise NotFound("Conversation not found.")
    if not offered_to(user):
        raise Forbidden("BuildCo Assistant is not available to your account yet.")

    now = datetime.now(UTC)
    dropped = conversation.disconnected_at
    beat = conversation.last_heartbeat_at
    gone = conversation.status != AgentConversationStatus.ACTIVE.value
    too_late = dropped is not None and now - _as_utc(dropped) > timedelta(
        seconds=RECONNECT_WINDOW_SECONDS
    )
    orphaned = beat is None or now - _as_utc(beat) > timedelta(seconds=STALE_HEARTBEAT_SECONDS)
    if gone or too_late or orphaned:
        # Refused, and nothing is changed here: a refusal rolls its transaction back.
        # A conversation that is past its minute and still marked active is ended by
        # the timer on its instance, or by the reaper if that instance died.
        raise Conflict("That conversation has ended. Start a new one.")
    await _require_allowance(session, user)

    ticket = _new_ticket(conversation)
    await session.flush()
    settings = get_settings()
    return IssuedSession(
        conversation=conversation,
        ticket=ticket,
        ws_url=f"{settings.agent_ws_base_url}{settings.api_v1_prefix}/agent/live",
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

    A ticket for a conversation that is already active is a reconnect, and **bumps the
    conversation's generation**. A dropped connection is often only half dead: the old
    server session cannot tell, keeps running, and still sees the conversation as
    active. The generation is what tells it otherwise. Its next heartbeat updates no
    row, and it shuts itself down without touching the meter.
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
        or conversation.status == AgentConversationStatus.ENDED.value
    ):
        raise TicketRefused()

    profile = await session.get(Profile, conversation.user_id)
    if profile is None or profile.is_banned:
        raise TicketRefused()

    conversation.ticket_used_at = now
    conversation.last_heartbeat_at = now
    if conversation.status == AgentConversationStatus.ACTIVE.value:
        was = conversation.connection_generation
        conversation.connection_generation = was + 1
        conversation.disconnected_at = None
        log.info(
            "agent_reconnected",
            conversation_id=str(conversation.id),
            old_generation=was,
            new_generation=was + 1,
        )
    else:
        conversation.status = AgentConversationStatus.ACTIVE.value
        conversation.started_at = now
    await session.flush()
    return conversation, profile


# ── While it is live ──────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Heartbeat:
    #: False when this socket no longer owns the conversation: it has ended, or a
    #: reconnect has taken it over under a newer generation.
    owns_it: bool
    #: Why it ended, if it has. ``None`` for a socket that was merely superseded by a
    #: reconnect: the conversation carries on, elsewhere.
    ended_as: str | None = None
    remaining_seconds: int = 0


async def heartbeat(
    session: AsyncSession,
    conversation_id: uuid.UUID,
    generation: int,
    *,
    live_seconds: int,
) -> Heartbeat:
    """Stamp the conversation, advance its meter, and find out whether it is still ours.

    One guarded update does all three. It matches only while the conversation is active
    **and this socket holds its current generation**, so a half-dead connection that a
    reconnect has replaced adds nothing to the meter, however long it lingers.

    Also re-reads the team's allowance, which is what lets an owner switch the
    assistant off for conversations already in progress.
    """
    stamped = await session.execute(
        update(AgentConversation)
        .where(
            AgentConversation.id == conversation_id,
            AgentConversation.status == AgentConversationStatus.ACTIVE.value,
            AgentConversation.connection_generation == generation,
        )
        .values(
            last_heartbeat_at=datetime.now(UTC),
            live_seconds=AgentConversation.live_seconds + max(0, live_seconds),
        )
    )
    row = (
        await session.execute(
            select(
                AgentConversation.user_id, AgentConversation.status, AgentConversation.end_reason
            ).where(AgentConversation.id == conversation_id)
        )
    ).first()
    if row is None:
        return Heartbeat(owns_it=False, ended_as=AgentEndReason.ERROR.value)
    user_id, status, end_reason = row
    if not stamped.rowcount:  # type: ignore[attr-defined]
        ended = status == AgentConversationStatus.ENDED.value
        return Heartbeat(owns_it=False, ended_as=(end_reason or "error") if ended else None)
    allowance = await allowance_for(session, user_id)
    return Heartbeat(owns_it=True, remaining_seconds=allowance.remaining_seconds)


async def mark_dropped(session: AsyncSession, conversation_id: uuid.UUID, generation: int) -> bool:
    """The socket went away without saying goodbye. Hold the conversation open.

    Ending it here, which is the obvious thing to do when a socket closes, would refuse
    every reconnect.
    """
    marked = await session.execute(
        update(AgentConversation)
        .where(
            AgentConversation.id == conversation_id,
            AgentConversation.status == AgentConversationStatus.ACTIVE.value,
            AgentConversation.connection_generation == generation,
        )
        .values(disconnected_at=datetime.now(UTC))
    )
    return bool(marked.rowcount)  # type: ignore[attr-defined]


async def end_if_not_back(
    session: AsyncSession, conversation_id: uuid.UUID, generation: int
) -> bool:
    """End a dropped conversation that nobody reconnected to. False if somebody did."""
    ended = await session.execute(
        update(AgentConversation)
        .where(
            AgentConversation.id == conversation_id,
            AgentConversation.status == AgentConversationStatus.ACTIVE.value,
            AgentConversation.connection_generation == generation,
            AgentConversation.disconnected_at.is_not(None),
        )
        .values(
            status=AgentConversationStatus.ENDED.value,
            ended_at=datetime.now(UTC),
            end_reason=AgentEndReason.DISCONNECTED.value,
        )
    )
    if not ended.rowcount:  # type: ignore[attr-defined]
        return False
    await _drop_open_proposals(session, [conversation_id])
    log.info(
        "agent_session_ended",
        conversation_id=str(conversation_id),
        reason=AgentEndReason.DISCONNECTED.value,
        generation=generation,
    )
    return True


async def reap_orphans(session: AsyncSession, user: Profile) -> int:
    """End this person's conversations that an instance died holding.

    Nothing else would: the timer that ends a dropped conversation lives on the
    instance, and went with it. Run when the person opens their history or starts a
    session.
    """
    cutoff = datetime.now(UTC) - timedelta(seconds=STALE_HEARTBEAT_SECONDS)
    orphaned = select(AgentConversation.id).where(
        AgentConversation.user_id == user.id,
        AgentConversation.status == AgentConversationStatus.ACTIVE.value,
        or_(
            AgentConversation.last_heartbeat_at.is_(None),
            AgentConversation.last_heartbeat_at < cutoff,
        ),
    )
    ids = list(await session.scalars(orphaned))
    if not ids:
        return 0
    await _drop_open_proposals(session, ids)
    await session.execute(
        update(AgentConversation)
        .where(AgentConversation.id.in_(ids))
        .values(
            status=AgentConversationStatus.ENDED.value,
            ended_at=datetime.now(UTC),
            end_reason=AgentEndReason.DISCONNECTED.value,
        )
    )
    return len(ids)


async def record_usage(
    session: AsyncSession, conversation_id: uuid.UUID, *, seconds_in: int, seconds_out: int
) -> None:
    """Add to the audio totals kept for working out what a conversation cost."""
    await session.execute(
        update(AgentConversation)
        .where(AgentConversation.id == conversation_id)
        .values(
            audio_seconds_in=AgentConversation.audio_seconds_in + max(0, seconds_in),
            audio_seconds_out=AgentConversation.audio_seconds_out + max(0, seconds_out),
        )
    )


async def end_conversation(
    session: AsyncSession, conversation_id: uuid.UUID, reason: AgentEndReason
) -> None:
    """Mark a conversation ended. A conversation that has already ended keeps its reason."""
    await _drop_open_proposals(session, [conversation_id])
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


def transcript_expired(conversation: AgentConversation, now: datetime | None = None) -> bool:
    """Whether this conversation's transcript is past its retention and must not be shown.

    True from the moment it is too old, whether or not the rows have been deleted yet:
    an expired transcript is hidden from every read immediately, and removed when the
    purge gets to it.
    """
    if conversation.transcript_purged_at is not None:
        return True
    finished = conversation.ended_at or conversation.started_at or conversation.created_at
    if finished is None:
        return False
    keep = timedelta(days=get_settings().agent_transcript_retention_days)
    return _as_utc(finished) < (now or datetime.now(UTC)) - keep


async def purge_expired_transcripts(session: AsyncSession, *, limit: int) -> int:
    """Delete the text of conversations past their retention. Returns how many.

    The conversation itself stays, with its date and its actions: the action log is
    kept indefinitely, and that includes the few words that approved each
    voice-approved action. Only what was said in passing goes, and the title with it,
    because the title is the first thing the user said.
    """
    cutoff = datetime.now(UTC) - timedelta(days=get_settings().agent_transcript_retention_days)
    due = list(
        await session.scalars(
            select(AgentConversation.id)
            .where(
                AgentConversation.transcript_purged_at.is_(None),
                AgentConversation.status == AgentConversationStatus.ENDED.value,
                func.coalesce(AgentConversation.ended_at, AgentConversation.created_at) < cutoff,
            )
            .order_by(AgentConversation.created_at)
            .limit(limit)
        )
    )
    if not due:
        return 0
    await session.execute(delete(AgentMessage).where(AgentMessage.conversation_id.in_(due)))
    await session.execute(
        update(AgentConversation)
        .where(AgentConversation.id.in_(due))
        .values(transcript_purged_at=datetime.now(UTC), title="")
    )
    log.info("agent_transcripts_purged", conversations=len(due))
    return len(due)


@dataclass(frozen=True, slots=True)
class HistoryEntry:
    conversation: AgentConversation
    #: How many things were actually saved in it.
    action_count: int
    transcript_expired: bool


@dataclass(frozen=True, slots=True)
class HistoryPage:
    items: list[HistoryEntry]
    total: int


async def list_conversations(
    session: AsyncSession, user: Profile, *, limit: int = 20, offset: int = 0
) -> HistoryPage:
    """The caller's own past conversations, newest first. Nobody else's, ever."""
    await reap_orphans(session, user)
    mine = (
        AgentConversation.user_id == user.id,
        AgentConversation.started_at.is_not(None),
    )
    total = await session.scalar(select(func.count()).select_from(AgentConversation).where(*mine))
    rows = list(
        await session.scalars(
            select(AgentConversation)
            .where(*mine)
            .order_by(AgentConversation.started_at.desc())
            .limit(limit)
            .offset(offset)
        )
    )
    counts: dict[uuid.UUID, int] = {}
    if rows:
        counted = await session.execute(
            select(AgentAction.conversation_id, func.count())
            .where(
                AgentAction.conversation_id.in_([row.id for row in rows]),
                AgentAction.status == AgentActionStatus.COMMITTED.value,
            )
            .group_by(AgentAction.conversation_id)
        )
        counts = {row[0]: row[1] for row in counted.all()}
    now = datetime.now(UTC)
    return HistoryPage(
        items=[
            HistoryEntry(
                conversation=row,
                action_count=counts.get(row.id, 0),
                transcript_expired=transcript_expired(row, now),
            )
            for row in rows
        ],
        total=total or 0,
    )


@dataclass(frozen=True, slots=True)
class ConversationRecord:
    conversation: AgentConversation
    messages: list[AgentMessage]
    actions: list[AgentAction]
    transcript_expired: bool = False


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

    expired = transcript_expired(conversation)
    messages = (
        []
        if expired
        else list(
            await session.scalars(
                select(AgentMessage)
                .where(AgentMessage.conversation_id == conversation_id)
                .order_by(AgentMessage.seq)
            )
        )
    )
    actions = list(
        await session.scalars(
            select(AgentAction)
            .where(AgentAction.conversation_id == conversation_id)
            .order_by(AgentAction.created_at, AgentAction.id)
        )
    )
    return ConversationRecord(
        conversation=conversation, messages=messages, actions=actions, transcript_expired=expired
    )
