"""Delete the text of BuildCo Assistant conversations past their retention period.

A transcript can hold other people's speech, caught by an open microphone on a job
site, so it is kept for ``AGENT_TRANSCRIPT_RETENTION_DAYS`` (90 by default) and then
deleted. **The action log is not touched**: what was proposed, approved and committed
is kept indefinitely, including the few words that approved each voice-approved action.

Nothing depends on this being run. An expired transcript is hidden from every read the
moment it expires, and each new conversation clears a small batch as it starts. This
clears the rest in one go, and is the thing to schedule as a Cloud Run Job if the
backlog ever matters. There is no scheduler in the project and this does not add one.

Idempotent. Safe to run at any time, and safe to interrupt.

    uv run python scripts/purge_agent_transcripts.py            # delete
    uv run python scripts/purge_agent_transcripts.py --dry-run  # count only
"""

from __future__ import annotations

import argparse
import asyncio
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

from app.config import get_settings
from app.db import get_session_factory
from app.models.agent import AgentConversation
from app.models.enums import AgentConversationStatus
from app.services import agent_service

BATCH = 200


async def count_due() -> int:
    cutoff = datetime.now(UTC) - timedelta(days=get_settings().agent_transcript_retention_days)
    async with get_session_factory()() as session:
        due = await session.scalar(
            select(func.count())
            .select_from(AgentConversation)
            .where(
                AgentConversation.transcript_purged_at.is_(None),
                AgentConversation.status == AgentConversationStatus.ENDED.value,
                func.coalesce(AgentConversation.ended_at, AgentConversation.created_at) < cutoff,
            )
        )
    return int(due or 0)


async def purge() -> int:
    """Clear every expired transcript, a batch per transaction."""
    cleared = 0
    while True:
        async with get_session_factory()() as session:
            done = await agent_service.purge_expired_transcripts(session, limit=BATCH)
            await session.commit()
        if not done:
            return cleared
        cleared += done
        print(f"  cleared {cleared}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="count, and delete nothing")
    args = parser.parse_args()

    days = get_settings().agent_transcript_retention_days
    if args.dry_run:
        print(f"{asyncio.run(count_due())} transcripts are older than {days} days.")
        return
    print(f"Deleting transcripts older than {days} days.")
    print(f"Done. {asyncio.run(purge())} cleared.")


if __name__ == "__main__":
    main()
