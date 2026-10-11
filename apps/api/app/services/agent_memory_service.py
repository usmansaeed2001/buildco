"""What BuildCo Assistant remembers about one person.

A memory is a short fact about the user: what to call them, how they like answers, a
habit of theirs. It is loaded at the start of every conversation, which is how the
assistant knows somebody's name on a new day when conversations cannot be resumed.

**A memory must come from the user's own mouth.** The assistant reads records aloud, and
some of the text in a record was written by an outsider: a reviewer's note arrives
through the public review page. If anything the assistant read could become something it
believes about the user, a stranger could steer every later conversation. So the server
checks each memory against what the user themselves said or typed in this conversation,
and refuses the rest. See ``agent_readback.ungrounded``.

Adding a memory needs no approval. Changing or forgetting one from inside a conversation
goes through a proposal; deleting one from the Profile page is the user's own act.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import AppError, NotFound, ValidationFailed
from app.logging import get_logger
from app.models.agent import AgentMemory, AgentMessage
from app.models.enums import AgentMemoryCategory, AgentMemorySource, AgentMessageRole
from app.models.profile import Profile
from app.services.rules import agent_readback, agent_rules

log = get_logger(__name__)

MAX_LENGTH = 500


class MemoryRejected(AppError):
    """This may not be remembered. The message is for the assistant to give the user."""

    status_code = ValidationFailed.status_code
    code = "validation_failed"
    default_message = "That cannot be remembered."

    def __init__(self, message: str, *, reason: str) -> None:
        super().__init__(message)
        self.reason = reason


def check_groundable(
    content: str, *, user_words: Sequence[str], known_names: Sequence[str] = ()
) -> None:
    """Refuse a memory that is a secret, a business fact, or not the user's own words."""
    forbidden = agent_readback.forbidden_memory(content)
    if forbidden == "secret":
        raise MemoryRejected("I do not keep passwords, codes or anything secret.", reason="secret")
    if forbidden == "business_fact":
        raise MemoryRejected(
            "Prices and rates belong in the rate catalogue, where everyone can see and "
            "correct them, so I do not keep them as memories.",
            reason="business_fact",
        )
    if len(content) > MAX_LENGTH:
        raise MemoryRejected("That is too long to remember. Make it shorter.", reason="too_long")

    missing = agent_readback.ungrounded(content, user_words, known_names=known_names)
    if missing:
        raise MemoryRejected(
            "I can only remember what you told me yourself in this conversation, and you "
            f"have not said this part: {', '.join(missing)}. Ask the user to say it, or "
            "leave it out.",
            reason="ungrounded",
        )


async def user_words(session: AsyncSession, conversation_id: uuid.UUID) -> list[str]:
    """Everything the user has said or typed in this conversation, oldest first."""
    rows = await session.scalars(
        select(AgentMessage.text)
        .where(
            AgentMessage.conversation_id == conversation_id,
            AgentMessage.role == AgentMessageRole.USER.value,
        )
        .order_by(AgentMessage.seq)
    )
    return list(rows)


async def list_memories(session: AsyncSession, user: Profile) -> list[AgentMemory]:
    rows = await session.scalars(
        select(AgentMemory)
        .where(AgentMemory.user_id == user.id)
        .order_by(AgentMemory.created_at, AgentMemory.id)
    )
    return list(rows)


async def get_memory(
    session: AsyncSession, user: Profile, memory_id: uuid.UUID, *, for_update: bool = False
) -> AgentMemory:
    """One of the caller's own memories. Anyone else's is a 404."""
    query = select(AgentMemory).where(AgentMemory.id == memory_id, AgentMemory.user_id == user.id)
    if for_update:
        query = query.with_for_update()
    memory: AgentMemory | None = await session.scalar(query)
    if memory is None:
        raise NotFound("That memory does not exist.")
    return memory


async def remember(
    session: AsyncSession,
    user: Profile,
    *,
    conversation_id: uuid.UUID,
    content: str,
    category: str,
    evidence: str,
    explicit: bool,
    known_names: Sequence[str] = (),
) -> AgentMemory:
    """Add a memory, if it is grounded in what the user said in this conversation."""
    content = " ".join(content.split())
    if not content:
        raise MemoryRejected("There is nothing there to remember.", reason="empty")
    try:
        kind = AgentMemoryCategory(category)
    except ValueError as exc:
        raise MemoryRejected(
            "A memory is an identity, a preference or a work_habit.", reason="category"
        ) from exc

    said = await user_words(session, conversation_id)
    try:
        check_groundable(content, user_words=said, known_names=known_names)
        if not agent_readback.evidence_is_the_users(evidence, said):
            raise MemoryRejected(
                "The evidence has to be the user's own words from this conversation. "
                "Quote what they said.",
                reason="evidence",
            )
    except MemoryRejected as rejected:
        # The reason only. What was offered may be the planted text itself.
        log.info(
            "agent_memory_rejected",
            conversation_id=str(conversation_id),
            reason=rejected.reason,
        )
        raise

    held = await session.scalar(
        select(func.count()).select_from(AgentMemory).where(AgentMemory.user_id == user.id)
    )
    if (held or 0) >= agent_rules.MEMORY_LIMIT:
        raise MemoryRejected(
            f"I already hold {agent_rules.MEMORY_LIMIT} memories about you, which is the "
            "most I keep. Some can be deleted on the Profile page, under What the "
            "assistant remembers.",
            reason="limit",
        )

    memory = AgentMemory(
        user_id=user.id,
        category=kind.value,
        content=content,
        source=(AgentMemorySource.EXPLICIT if explicit else AgentMemorySource.INFERRED).value,
        evidence=evidence.strip(),
        source_conversation_id=conversation_id,
    )
    session.add(memory)
    await session.flush()
    return memory


async def rewrite_memory(
    session: AsyncSession, user: Profile, memory_id: uuid.UUID, content: str
) -> AgentMemory:
    """Replace a memory's text. Reached only by committing an approved proposal."""
    memory = await get_memory(session, user, memory_id, for_update=True)
    memory.content = content
    await session.flush()
    return memory


async def delete_memory(session: AsyncSession, user: Profile, memory_id: uuid.UUID) -> None:
    memory = await get_memory(session, user, memory_id, for_update=True)
    await session.delete(memory)
    await session.flush()
