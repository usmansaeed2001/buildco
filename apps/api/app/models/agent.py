"""BuildCo Assistant: conversations, transcripts, the action log, and memories.

Four tables, and what each is for:

* ``agent_conversations`` — one row per conversation. It carries the session ticket
  (hashed), which is what lets one Cloud Run service issue a ticket and another redeem
  it, and the heartbeat and connection generation that keep a user to one live
  conversation across instances.
* ``agent_messages`` — final transcripts of both sides. Text only; no audio is ever
  stored. Deleted after the retention window.
* ``agent_actions`` — **the proposal store and the audit log in one.** A proposal is a
  row with the exact payload that will be written; committing it changes the row's
  status and writes nothing the row does not already say. Kept indefinitely.
* ``agent_memories`` — what the assistant remembers about one person, with the words of
  theirs it was based on.

Everything hangs off ``profiles`` with ``ON DELETE CASCADE``: a conversation, and what
was said in it, belongs to the person and goes with them.
"""

from __future__ import annotations

# Runtime import: SQLAlchemy resolves Mapped[...] annotations at class-creation time,
# so uuid cannot hide under TYPE_CHECKING.
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, JSONBType, TimestampMixin, UUIDPrimaryKey, utcnow
from app.models.enums import (
    AgentActionStatus,
    AgentApprovalPolicy,
    AgentApprovedVia,
    AgentConversationStatus,
    AgentEndReason,
    AgentMemoryCategory,
    AgentMemorySource,
    AgentMessageRole,
    AgentMessageSource,
    values,
)


def _one_of(column: str, enum_cls: type, *, nullable: bool = False) -> str:
    listed = "','".join(values(enum_cls))
    check = f"{column} in ('{listed}')"
    return f"{column} is null or {check}" if nullable else check


class AgentConversation(Base, UUIDPrimaryKey, TimestampMixin):
    __tablename__ = "agent_conversations"
    __table_args__ = (
        CheckConstraint(_one_of("status", AgentConversationStatus), name="status_valid"),
        CheckConstraint(
            _one_of("end_reason", AgentEndReason, nullable=True), name="end_reason_valid"
        ),
        # One live conversation per person, enforced where two instances cannot
        # disagree about it. Starting a second marks the first ended in the same
        # transaction, so this never fires in normal use; it is what makes a race
        # between two tabs lose cleanly rather than leave two.
        Index(
            "uq_agent_conversations_one_active_per_user",
            "user_id",
            unique=True,
            postgresql_where=text("status = 'active'"),
            sqlite_where=text("status = 'active'"),
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    status: Mapped[str] = mapped_column(
        String(20),
        server_default=text(f"'{AgentConversationStatus.PENDING.value}'"),
        default=AgentConversationStatus.PENDING.value,
        nullable=False,
    )
    #: The first thing the user said, truncated. Cleared when the transcript is purged.
    title: Mapped[str] = mapped_column(
        String(200), server_default=text("''"), default="", nullable=False
    )

    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    end_reason: Mapped[str | None] = mapped_column(String(20))

    #: Stamped by the live socket every few seconds. A conversation still ``active``
    #: whose heartbeat is stale was orphaned by an instance that died.
    last_heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    #: Bumped by every reconnect. A socket holding an older number is a half-dead
    #: connection that has not noticed, and shuts itself down.
    connection_generation: Mapped[int] = mapped_column(
        Integer, server_default=text("0"), default=0, nullable=False
    )
    #: Set when a socket goes away unannounced; cleared by a reconnect.
    disconnected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    #: SHA-256 of the session ticket. Only the hash is stored: the ticket travels in a
    #: WebSocket URL, and a URL ends up in logs.
    ticket_hash: Mapped[str | None] = mapped_column(String(64), index=True)
    ticket_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ticket_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    transcript_purged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    #: Seconds with live audio. This is what the daily allowance is counted from, and
    #: it is written as it accrues so that a crash does not lose it.
    live_seconds: Mapped[int] = mapped_column(
        Integer, server_default=text("0"), default=0, nullable=False
    )
    model: Mapped[str] = mapped_column(
        String(100), server_default=text("''"), default="", nullable=False
    )
    audio_seconds_in: Mapped[int] = mapped_column(
        Integer, server_default=text("0"), default=0, nullable=False
    )
    audio_seconds_out: Mapped[int] = mapped_column(
        Integer, server_default=text("0"), default=0, nullable=False
    )
    #: IANA zone the browser reported. Dates in a read-back are spoken in it.
    client_timezone: Mapped[str] = mapped_column(
        String(64), server_default=text("'UTC'"), default="UTC", nullable=False
    )

    def __repr__(self) -> str:
        return f"<AgentConversation {self.id} {self.status}>"


class AgentMessage(Base, UUIDPrimaryKey):
    __tablename__ = "agent_messages"
    __table_args__ = (
        CheckConstraint(_one_of("role", AgentMessageRole), name="role_valid"),
        CheckConstraint(_one_of("source", AgentMessageSource), name="source_valid"),
        UniqueConstraint("conversation_id", "seq", name="uq_agent_messages_conversation_seq"),
    )

    conversation_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("agent_conversations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    #: Order within the conversation. Timestamps tie; this does not.
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False)
    source: Mapped[str] = mapped_column(String(20), nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    #: When the utterance began, which is not when its transcript was finalised.
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), default=utcnow, nullable=False
    )


class AgentAction(Base, UUIDPrimaryKey):
    __tablename__ = "agent_actions"
    __table_args__ = (
        CheckConstraint(_one_of("status", AgentActionStatus), name="status_valid"),
        CheckConstraint(
            _one_of("approval_policy", AgentApprovalPolicy), name="approval_policy_valid"
        ),
        CheckConstraint(
            _one_of("approved_via", AgentApprovedVia, nullable=True), name="approved_via_valid"
        ),
    )

    conversation_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("agent_conversations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    #: What it does, e.g. ``meeting.create``.
    kind: Mapped[str] = mapped_column(String(60), nullable=False)
    status: Mapped[str] = mapped_column(
        String(20),
        server_default=text(f"'{AgentActionStatus.PROPOSED.value}'"),
        default=AgentActionStatus.PROPOSED.value,
        nullable=False,
    )
    #: The exact values proposed. A commit writes these and nothing else: it carries
    #: no values of its own, so nothing can change between approval and write.
    payload: Mapped[dict[str, Any]] = mapped_column(JSONBType, nullable=False)
    #: What the staged form shows that the payload alone does not say, such as the
    #: name behind an attendee id.
    labels: Mapped[dict[str, Any]] = mapped_column(
        JSONBType, server_default=text("'{}'"), default=dict, nullable=False
    )
    #: The read-back, written by the server from the payload.
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    approval_policy: Mapped[str] = mapped_column(String(20), nullable=False)

    target_type: Mapped[str | None] = mapped_column(String(40))
    target_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True))
    #: A hash of what the proposal depends on in its target, taken when it was made
    #: and compared under a row lock at commit. Not ``updated_at``, which misses a
    #: change to a meeting's attendees or a photo on an estimate.
    target_fingerprint: Mapped[str | None] = mapped_column(String(64))

    #: The essentials and each exception, with the terms that must be heard for it.
    required_terms: Mapped[list[Any]] = mapped_column(
        JSONBType, server_default=text("'[]'"), default=list, nullable=False
    )
    readback_verified: Mapped[bool] = mapped_column(
        Boolean, server_default=text("false"), default=False, nullable=False
    )
    #: When the browser reported that the read-back had finished playing.
    readback_played_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    approved_via: Mapped[str | None] = mapped_column(String(20))
    #: What the user said, for a voice approval. Kept as the evidence of it.
    approval_utterance: Mapped[str | None] = mapped_column(Text)
    #: What the commit produced, e.g. the id of the meeting it created.
    result: Mapped[dict[str, Any] | None] = mapped_column(JSONBType)
    error: Mapped[str | None] = mapped_column(Text)

    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), default=utcnow, nullable=False
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    def __repr__(self) -> str:
        return f"<AgentAction {self.kind} {self.status}>"


class AgentMemory(Base, UUIDPrimaryKey, TimestampMixin):
    __tablename__ = "agent_memories"
    __table_args__ = (
        CheckConstraint(_one_of("category", AgentMemoryCategory), name="category_valid"),
        CheckConstraint(_one_of("source", AgentMemorySource), name="source_valid"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    category: Mapped[str] = mapped_column(String(20), nullable=False)
    content: Mapped[str] = mapped_column(String(500), nullable=False)
    source: Mapped[str] = mapped_column(String(20), nullable=False)
    #: The user's own words this was based on. A memory with none is not accepted.
    evidence: Mapped[str] = mapped_column(Text, nullable=False)
    #: ``SET NULL``: purging or deleting a conversation must not take what was learned
    #: in it.
    source_conversation_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("agent_conversations.id", ondelete="SET NULL")
    )
