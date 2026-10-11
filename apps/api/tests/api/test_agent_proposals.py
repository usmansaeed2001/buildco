"""The commit, on its own: claimed once, refused when stale, refused when expired."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select

from app.agent import proposals
from app.models.agent import AgentAction, AgentConversation
from app.models.enums import AgentApprovedVia, UserStatus
from app.models.meeting import Meeting, MeetingAttendee
from app.models.profile import Profile
from app.schemas.meeting import MeetingCreate
from app.services import actions

START = datetime(2026, 10, 14, 21, 30, tzinfo=UTC)


@pytest.fixture
async def conversation(session_factory, member) -> AgentConversation:
    async with session_factory() as db:
        row = AgentConversation(user_id=member.id, status="active", client_timezone="UTC")
        db.add(row)
        await db.commit()
        return row


async def propose(session_factory, member, conversation, **overrides) -> AgentAction:
    arguments = {
        "title": "Hendricks walkthrough",
        "date": "2026-10-14",
        "start_time": "21:30",
        "duration_minutes": 45,
        **overrides,
    }
    async with session_factory() as db:
        action = await proposals.propose_meeting_create(
            db,
            await db.get(Profile, member.id),
            await db.get(AgentConversation, conversation.id),
            **arguments,
        )
        await db.commit()
        return action


async def commit(session_factory, action, member, via=AgentApprovedVia.CLICK):
    return await proposals.commit(session_factory, action.id, actor_id=member.id, via=via)


async def meetings(db) -> int:
    return await db.scalar(select(func.count()).select_from(Meeting)) or 0


# ── Once ──────────────────────────────────────────────────────────────────────


async def test_a_proposal_commits_once_and_a_second_attempt_is_told_so(
    session_factory, member, conversation, db, notifications
):
    action = await propose(session_factory, member, conversation)

    first = await commit(session_factory, action, member)
    second = await commit(session_factory, action, member, via=AgentApprovedVia.VOICE)

    assert first.committed
    assert (second.status, second.resolved_as) == ("already_resolved", "committed")
    assert await meetings(db) == 1
    # The first approval is the one on record.
    assert (await db.get(AgentAction, action.id)).approved_via == "click"


@pytest.mark.postgres
async def test_a_click_and_a_spoken_yes_at_the_same_moment_make_one_meeting(
    session_factory, member, other_member, conversation, db, notifications
):
    """The claim is an UPDATE guarded on the status, so two cannot both take it.

    Postgres only: on SQLite the two run on one connection and never actually overlap.
    """
    action = await propose(
        session_factory, member, conversation, attendee_ids=[str(other_member.id)]
    )

    outcomes = await asyncio.gather(
        commit(session_factory, action, member, via=AgentApprovedVia.CLICK),
        commit(session_factory, action, member, via=AgentApprovedVia.VOICE),
    )

    assert sorted(outcome.status for outcome in outcomes) == ["already_resolved", "committed"]
    assert await meetings(db) == 1
    # And one round of invites, not two.
    assert [sent.recipient for sent in notifications.sent] == [other_member.email]


# ── Not at all ────────────────────────────────────────────────────────────────


async def test_an_expired_proposal_is_not_committed(session_factory, member, conversation, db):
    action = await propose(session_factory, member, conversation)
    (await db.get(AgentAction, action.id)).expires_at = datetime.now(UTC) - timedelta(seconds=1)
    await db.commit()

    outcome = await commit(session_factory, action, member)

    assert outcome.status == "failed"
    assert "expired" in outcome.error
    assert await meetings(db) == 0
    assert (await db.get(AgentAction, action.id, populate_existing=True)).status == "failed"


async def test_nobody_else_can_commit_a_persons_proposal(
    session_factory, member, other_member, conversation, db
):
    action = await propose(session_factory, member, conversation)

    outcome = await proposals.commit(
        session_factory, action.id, actor_id=other_member.id, via=AgentApprovedVia.CLICK
    )

    assert outcome.status == "failed"
    assert await meetings(db) == 0


async def test_a_removed_person_cannot_commit_what_they_proposed_earlier(
    session_factory, member, conversation, db
):
    action = await propose(session_factory, member, conversation)
    (await db.get(Profile, member.id)).status = UserStatus.BANNED.value
    await db.commit()

    outcome = await commit(session_factory, action, member)

    assert outcome.status == "failed"
    assert await meetings(db) == 0


async def test_a_failed_commit_leaves_nothing_behind_and_owes_no_email(
    session_factory, member, other_member, conversation, db, notifications
):
    """The attendee is removed between the proposal and the approval. The action
    function refuses, the whole transaction rolls back, and nobody is emailed."""
    action = await propose(
        session_factory, member, conversation, attendee_ids=[str(other_member.id)]
    )
    (await db.get(Profile, other_member.id)).status = UserStatus.BANNED.value
    await db.commit()

    outcome = await commit(session_factory, action, member)

    assert outcome.status == "failed"
    assert "removed from the team" in outcome.error
    assert await meetings(db) == 0
    assert notifications.sent == []


# ── A record that changed underneath a proposal ───────────────────────────────


@pytest.fixture
async def existing(session_factory, member, other_member) -> Meeting:
    async with session_factory() as db:
        written = await actions.create_meeting(
            db,
            await db.get(Profile, member.id),
            MeetingCreate(
                title="Site walkthrough",
                start_time=START,
                end_time=START + timedelta(hours=1),
                attendee_ids=[other_member.id],
            ),
        )
        await db.commit()
        return written.meeting


async def targeting(session_factory, member, conversation, meeting_id) -> AgentAction:
    """A proposal that depends on an existing meeting being as it is now."""
    action = await propose(session_factory, member, conversation, title="Follow-up")
    async with session_factory() as db:
        row = await db.get(AgentAction, action.id)
        meeting = await db.get(Meeting, meeting_id)
        row.target_type = "meeting"
        row.target_id = meeting.id
        row.target_fingerprint = proposals.fingerprint_meeting(meeting)
        await db.commit()
    return action


async def test_a_proposal_commits_when_its_target_is_as_it_was(
    session_factory, member, conversation, existing, notifications
):
    action = await targeting(session_factory, member, conversation, existing.id)

    assert (await commit(session_factory, action, member)).committed


async def test_a_change_to_the_targets_fields_refuses_the_commit(
    session_factory, member, conversation, existing, db
):
    action = await targeting(session_factory, member, conversation, existing.id)
    (await db.get(Meeting, existing.id)).location = "Moved to the office"
    await db.commit()

    outcome = await commit(session_factory, action, member)

    assert outcome.status == "failed"
    assert "changed by someone else" in outcome.error
    assert await meetings(db) == 1


async def test_a_change_to_who_is_on_the_target_refuses_the_commit_too(
    session_factory, member, conversation, existing, db
):
    """The change ``updated_at`` cannot see: an attendee comes off, and the meeting's own
    row is never written. Comparing ``updated_at`` would have let the commit through."""
    action = await targeting(session_factory, member, conversation, existing.id)
    before = (await db.get(Meeting, existing.id)).updated_at
    attendee = await db.scalar(
        select(MeetingAttendee).where(MeetingAttendee.meeting_id == existing.id)
    )
    await db.delete(attendee)
    await db.commit()

    outcome = await commit(session_factory, action, member)

    assert (await db.get(Meeting, existing.id, populate_existing=True)).updated_at == before
    assert outcome.status == "failed"
    assert "changed by someone else" in outcome.error


def test_the_fingerprint_ignores_the_order_attendees_are_listed_in(member, other_member):
    def meeting(attendees):
        return Meeting(
            title="Site walkthrough",
            description="",
            location="",
            start_time=START,
            end_time=START + timedelta(hours=1),
            color="#3B82F6",
            attendees=[MeetingAttendee(user_id=p.id, email=p.email, name="") for p in attendees],
        )

    assert proposals.fingerprint_meeting(meeting([member, other_member])) == (
        proposals.fingerprint_meeting(meeting([other_member, member]))
    )
