"""What a live conversation does because time passed, or because its socket changed hands.

The meter, the daily allowance, the pause while waiting for an approval, idling out,
expiry, the read-back check, and a dropped connection being picked up again. None of it
is the model's doing, and the model here is scripted to be no help.

Time is a clock the test owns. The conversation looks at it a hundred times a second, so
"thirty seconds pass" is one line and takes no time at all.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import func, select

from app.agent import conversation as conversation_module
from app.agent import live
from app.agent.conversation import Ending, LiveConversation
from app.config import get_settings
from app.errors import Conflict
from app.models.agent import AgentAction, AgentConversation
from app.models.enums import AgentEndReason
from app.models.meeting import Meeting
from app.models.profile import Profile
from app.models.settings import SETTINGS_ROW_ID, TeamSettings
from app.services import agent_service
from app.services.agent_service import LimitReached
from tests.agent_fakes import FakeSocket, ScriptedModel, eventually, open_talk


class Clock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now

    async def passes(self, seconds: float) -> None:
        """This much time goes by, and the conversation has had a chance to notice."""
        self.now += seconds
        await asyncio.sleep(0.06)


@pytest.fixture
def clock(monkeypatch) -> Clock:
    """Time that moves only when the test says so, looked at very often.

    The heartbeat keeps its real interval, in this clock's seconds. So one happens when
    a test lets five seconds pass and not otherwise, which keeps the database quiet:
    under SQLite every session here shares one connection.
    """
    monkeypatch.setattr(conversation_module, "TICK_SECONDS", 0.01)
    # Silence is its own subject, below. Everywhere else it would end the conversation
    # in the middle of a test about something that takes longer than two minutes.
    monkeypatch.setattr(get_settings(), "agent_idle_warning_seconds", 10**9)
    monkeypatch.setattr(get_settings(), "agent_idle_timeout_seconds", 10**9)
    return Clock()


@pytest.fixture
def idling(monkeypatch, clock) -> None:
    """The real idle timings: a question at ninety seconds, the end at two minutes."""
    monkeypatch.setattr(get_settings(), "agent_idle_warning_seconds", 90)
    monkeypatch.setattr(get_settings(), "agent_idle_timeout_seconds", 120)


@pytest.fixture
def agent_on(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "agent_enabled", True)
    monkeypatch.setattr(settings, "agent_audience", "everyone")
    return settings


@pytest.fixture
async def talk(session_factory, member, notifications, agent_on, clock):
    async with open_talk(session_factory, member, clock=clock) as live_talk:
        yield live_talk


def a_meeting(**overrides):
    return {
        "title": "Hendricks walkthrough",
        "date": "2026-10-14",
        "start_time": "14:30",
        "duration_minutes": 45,
        "attendee_ids": [],
        "guest_emails": [],
        "location": "",
        "description": "",
        **overrides,
    }


async def stage(talk, **overrides) -> dict:
    return await talk.model.session.calls("propose_create_meeting", **a_meeting(**overrides))


async def read_back(talk, staged: dict, *, played_at: float = 40.0, saying: str | None = None):
    """The agent reads the summary, and the browser reports that it finished playing."""
    talk.model.session.says(saying or staged["summary"] + " Do you approve?")
    await talk.socket.wait_for("turn_complete", readback_for=staged["proposal_id"])
    talk.socket.microphone(played_at)
    talk.socket.frame("readback_played", proposal_id=staged["proposal_id"])

    async def reported() -> bool:
        return talk.conversation._open is None or talk.conversation._open.played_at is not None

    await eventually(reported)


async def the_action(db, staged: dict) -> AgentAction:
    return await db.get(AgentAction, uuid.UUID(staged["proposal_id"]), populate_existing=True)


async def the_conversation(db, talk) -> AgentConversation:
    return await db.get(AgentConversation, talk.id, populate_existing=True)


async def set_team_minutes(db, minutes: int | None) -> None:
    row = await db.get(TeamSettings, SETTINGS_ROW_ID)
    if row is None:
        row = TeamSettings(id=SETTINGS_ROW_ID)
        db.add(row)
    row.agent_daily_minutes = minutes
    await db.commit()


async def live_seconds(db, talk) -> int:
    return (await the_conversation(db, talk)).live_seconds


# ── Was the read-back really said ─────────────────────────────────────────────


async def test_a_readback_with_everything_in_it_is_verified(talk, db):
    staged = await stage(talk)

    await read_back(talk, staged)

    async def verified():
        return (await the_action(db, staged)).readback_verified

    assert await eventually(verified)
    assert len(talk.socket.of("proposal")) == 1


async def test_a_readback_that_left_out_the_time_makes_it_a_click(talk, db):
    """Nothing unusual about the meeting. What must be heard is which one, and when."""
    staged = await stage(talk)
    assert staged["approval"] == "voice_or_click"

    await read_back(
        talk,
        staged,
        saying="I am about to create the meeting Hendricks walkthrough. Shall I go ahead?",
    )

    again = await talk.socket.wait_for("proposal", approval="click")
    assert again["id"] == staged["proposal_id"]
    row = await the_action(db, staged)
    assert (row.approval_policy, row.readback_verified) == ("click", False)
    assert any("can no longer be approved by voice" in text for text in talk.model.session.texts)


async def test_a_yes_cannot_approve_what_was_not_fully_read_back(talk, db):
    staged = await stage(talk, guest_emails=[])
    await read_back(
        talk,
        staged,
        saying="I am about to create the meeting Hendricks walkthrough on October 14th.",
    )
    await talk.socket.wait_for("proposal", approval="click")
    talk.model.session.hears("Yes.", began_at=41.0)

    answer = await talk.model.session.calls("commit_proposal", proposal_id=staged["proposal_id"])

    assert answer["ok"] is False and "cannot be approved by voice" in answer["tell_the_user"]
    assert await db.scalar(select(func.count()).select_from(Meeting)) == 0
    # The button still works, and the card it sits on was always complete.
    talk.socket.frame("approval", proposal_id=staged["proposal_id"], decision="approve")
    await talk.socket.wait_for("proposal_result", status="committed")


async def test_a_few_words_before_the_readback_do_not_count_against_it(talk, db):
    staged = await stage(talk)

    talk.model.session.says("One moment.")
    await talk.socket.wait_for("turn_complete", spoke=True, readback_for=None)
    await read_back(talk, staged)

    async def verified():
        return (await the_action(db, staged)).readback_verified

    assert await eventually(verified)
    assert (await the_action(db, staged)).approval_policy == "voice_or_click"


async def test_an_address_read_out_with_a_letter_missing_is_caught(talk, db):
    """A click-only proposal already; what matters is that it is noticed and logged."""
    staged = await stage(talk, guest_emails=["maria@acme.example"])
    wrong = staged["summary"].replace("maria@acme.example", "m a r i at acme dot example")

    await read_back(talk, staged, saying=wrong)

    row = await the_action(db, staged)
    assert (row.approval_policy, row.readback_verified) == ("click", False)
    assert len(talk.socket.of("proposal")) == 1


# ── Waiting for an answer ─────────────────────────────────────────────────────


async def test_the_microphone_pauses_when_nobody_answers_the_readback(talk, clock):
    staged = await stage(talk)
    await read_back(talk, staged)
    await asyncio.sleep(0.05)
    assert talk.socket.of("audio") == []

    await clock.passes(31)

    paused = await talk.socket.wait_for("audio", state="paused")
    assert paused["reason"] == "approval"


async def test_nothing_is_streamed_or_metered_while_paused(talk, clock, db):
    staged = await stage(talk)
    await read_back(talk, staged)
    await clock.passes(31)
    await talk.socket.wait_for("audio", state="paused")
    before = await eventually(lambda: live_seconds(db, talk))
    heard = talk.model.session.audio_seconds

    talk.socket.microphone(5)
    await clock.passes(300)
    await asyncio.sleep(0.1)

    assert talk.model.session.audio_seconds == heard
    assert await live_seconds(db, talk) == before == 31


async def test_tap_to_talk_brings_the_microphone_back(talk, clock):
    staged = await stage(talk)
    await read_back(talk, staged)
    await clock.passes(31)
    await talk.socket.wait_for("audio", state="paused")

    talk.socket.frame("resume")

    await talk.socket.wait_for("audio", state="live")
    talk.socket.microphone(2)
    await eventually(lambda: _heard(talk, more_than=40.0))


async def _heard(talk, *, more_than: float) -> bool:
    return talk.model.session.audio_seconds > more_than


async def test_speaking_inside_the_window_keeps_it_open(talk, clock):
    staged = await stage(talk)
    await read_back(talk, staged)
    await clock.passes(20)
    talk.model.session.hears("Actually, hold on.", began_at=45.0)
    await talk.socket.wait_for("transcript", role="user", final=True)

    await clock.passes(20)
    await asyncio.sleep(0.1)

    assert talk.socket.of("audio") == []


async def test_approving_by_click_works_while_paused_and_ends_the_pause(talk, clock, db):
    staged = await stage(talk)
    await read_back(talk, staged)
    await clock.passes(31)
    await talk.socket.wait_for("audio", state="paused")

    talk.socket.frame("approval", proposal_id=staged["proposal_id"], decision="approve")

    await talk.socket.wait_for("proposal_result", status="committed")
    await talk.socket.wait_for("audio", state="live")
    assert await db.scalar(select(func.count()).select_from(Meeting)) == 1


async def test_a_proposal_left_unanswered_expires(talk, clock, db):
    staged = await stage(talk)
    talk.conversation._open.expires_at = talk.conversation._open.expires_at.replace(year=2020)

    expired = await talk.socket.wait_for("proposal_result", status="expired")

    assert expired["id"] == staged["proposal_id"]
    assert (await the_action(db, staged)).status == "expired"
    await talk.socket.wait_for("mode", mode="conversing")
    assert any("has expired" in text for text in talk.model.session.texts)


# ── The meter and the allowance ───────────────────────────────────────────────


async def test_time_with_live_audio_is_written_to_the_conversation_as_it_accrues(talk, clock, db):
    await clock.passes(12)

    assert await eventually(lambda: live_seconds(db, talk)) == 12


async def test_the_browser_is_told_how_much_of_today_is_left(talk):
    ready = talk.socket.of("ready")[0]

    assert ready["limits"] == {"max_session_seconds": 1800, "remaining_seconds": 600}
    assert ready["resumed"] is False


async def test_the_user_is_warned_with_a_minute_left(talk, clock):
    await clock.passes(545)

    notice = await talk.socket.wait_for("notice", kind="allowance_low")

    assert 0 < notice["seconds"] <= 60
    assert any("one minute" in text for text in talk.model.session.texts)
    assert not talk.running.done()


async def test_the_conversation_ends_when_the_allowance_runs_out(talk, clock, db):
    await clock.passes(601)

    ending = await asyncio.wait_for(talk.running, 3)

    assert ending == Ending.ended(AgentEndReason.TIME_LIMIT, "allowance")
    assert talk.socket.sent[-1] == {"type": "ended", "reason": "time_limit", "detail": "allowance"}
    assert (await live_seconds(db, talk)) >= 600


async def test_a_proposal_already_waiting_outlives_the_allowance_and_a_click_commits_it(
    talk, clock, db
):
    """The audio stops and the model is closed. The staged form is not thrown away."""
    staged = await stage(talk)

    await clock.passes(601)

    paused = await talk.socket.wait_for("audio", state="paused")
    assert paused["reason"] == "allowance"
    assert talk.model.session.closed
    assert not talk.running.done()
    assert (await the_action(db, staged)).status == "proposed"

    talk.socket.frame("approval", proposal_id=staged["proposal_id"], decision="approve")

    await talk.socket.wait_for("proposal_result", status="committed")
    assert await asyncio.wait_for(talk.running, 3) == Ending.ended(
        AgentEndReason.TIME_LIMIT, "allowance"
    )
    assert await db.scalar(select(func.count()).select_from(Meeting)) == 1


async def test_setting_the_teams_allowance_to_zero_ends_a_live_conversation(talk, clock, db):
    """The off switch. No deploy, and it reaches a conversation already in progress."""
    await set_team_minutes(db, 0)

    await clock.passes(6)
    ending = await asyncio.wait_for(talk.running, 3)

    assert ending == Ending.ended(AgentEndReason.TIME_LIMIT, "allowance")


async def test_time_used_in_an_earlier_conversation_today_counts(
    session_factory, member, notifications, agent_on, clock, db
):
    async with open_talk(session_factory, member, clock=clock) as first:
        await clock.passes(400)
        await eventually(lambda: live_seconds(db, first))

    async with open_talk(session_factory, member, clock=clock) as second:
        assert second.socket.of("ready")[0]["limits"]["remaining_seconds"] == 200


async def test_a_new_conversation_is_refused_once_the_allowance_is_spent(
    session_factory, member, notifications, agent_on, clock, db
):
    async with open_talk(session_factory, member, clock=clock) as first:
        await clock.passes(601)
        await asyncio.wait_for(first.running, 3)

    with pytest.raises(LimitReached):
        await agent_service.create_session(
            db, await db.get(Profile, member.id), client_timezone="UTC"
        )


async def test_the_user_is_warned_two_minutes_before_the_hard_cap(talk, clock, db):
    await set_team_minutes(db, 600)

    await clock.passes(1_690)

    await talk.socket.wait_for("notice", kind="time_limit_warning")
    assert not talk.running.done()


# ── Silence ───────────────────────────────────────────────────────────────────


async def test_after_ninety_seconds_of_silence_the_agent_asks_and_at_two_minutes_it_ends(
    talk, clock, idling
):
    await clock.passes(91)
    await talk.socket.wait_for("notice", kind="idle_warning")
    assert any("still there" in text for text in talk.model.session.texts)
    assert not talk.running.done()

    await clock.passes(30)

    assert await asyncio.wait_for(talk.running, 3) == Ending.ended(AgentEndReason.IDLE_TIMEOUT)


async def test_the_user_speaking_starts_the_silence_again(talk, clock, idling):
    await clock.passes(80)
    talk.model.session.hears("Still here.", began_at=80.0)
    await talk.socket.wait_for("transcript", role="user", final=True)

    await clock.passes(80)
    await asyncio.sleep(0.1)

    assert talk.socket.of("notice") == []
    assert not talk.running.done()


async def test_the_silence_is_not_counted_while_the_agent_is_speaking(talk, clock, idling):
    talk.model.session.starts_saying("Let me read you all twelve of them")
    await talk.socket.wait_for("transcript", role="assistant")

    await clock.passes(300)
    await asyncio.sleep(0.1)

    assert talk.socket.of("notice") == []
    assert not talk.running.done()


async def test_the_silence_is_not_counted_while_a_proposal_waits(talk, clock, idling):
    await stage(talk)

    await clock.passes(300)
    await asyncio.sleep(0.1)

    assert [notice["kind"] for notice in talk.socket.of("notice")] == []
    assert not talk.running.done()


# ── Saying goodbye ────────────────────────────────────────────────────────────


async def test_the_conversation_ends_once_the_agent_has_said_goodbye(talk):
    await talk.model.session.calls("end_conversation")
    assert not talk.running.done()

    talk.model.session.says("Goodbye, Mia.")

    assert await asyncio.wait_for(talk.running, 3) == Ending.ended(AgentEndReason.USER_CLOSED)


async def test_it_ends_anyway_if_the_agent_says_nothing(talk, clock):
    await talk.model.session.calls("end_conversation")

    await clock.passes(9)

    assert await asyncio.wait_for(talk.running, 3) == Ending.ended(AgentEndReason.USER_CLOSED)


# ── One conversation, one socket ──────────────────────────────────────────────


async def test_starting_another_conversation_ends_this_one(talk, clock, db, member):
    await agent_service.create_session(db, await db.get(Profile, member.id), client_timezone="UTC")
    await db.commit()

    await clock.passes(6)
    ending = await asyncio.wait_for(talk.running, 3)

    assert ending == Ending.ended(AgentEndReason.SUPERSEDED)
    assert talk.socket.sent[-1]["reason"] == "superseded"


async def reconnect(session_factory, user, conversation_id) -> int:
    """What the browser does after a drop: a fresh ticket, redeemed."""
    async with session_factory() as db:
        issued = await agent_service.reconnect(db, await db.get(Profile, user.id), conversation_id)
        await db.commit()
        again, _ = await agent_service.redeem_ticket(db, issued.ticket)
        await db.commit()
        return again.connection_generation


async def test_a_socket_that_has_been_replaced_stops_and_adds_nothing_to_the_meter(
    talk, clock, db, session_factory, member
):
    """A half-dead connection cannot tell it is dead. Its generation can."""
    assert await reconnect(session_factory, member, talk.id) == 1

    await clock.passes(50)
    ending = await asyncio.wait_for(talk.running, 3)

    assert ending == Ending("replaced")
    row = await the_conversation(db, talk)
    assert (row.status, row.live_seconds, row.end_reason) == ("active", 0, None)


async def test_a_replaced_socket_leaves_the_open_proposal_alone(
    talk, clock, db, session_factory, member
):
    staged = await stage(talk)

    await reconnect(session_factory, member, talk.id)
    await clock.passes(6)
    await asyncio.wait_for(talk.running, 3)
    await live.settle(session_factory, talk.id, talk.generation, Ending("replaced"))

    assert (await the_action(db, staged)).status == "proposed"
    assert (await the_conversation(db, talk)).status == "active"


# ── A dropped connection ──────────────────────────────────────────────────────


async def drop(talk, session_factory) -> None:
    """The connection goes away unannounced, and the endpoint does what it does then."""
    talk.socket.hang_up()
    ending = await asyncio.wait_for(talk.running, 3)
    assert ending == Ending("dropped")
    await live.settle(session_factory, talk.id, talk.generation, ending)


@pytest.fixture
def short_window(monkeypatch) -> float:
    monkeypatch.setattr(agent_service, "RECONNECT_WINDOW_SECONDS", 0.3)
    return 0.3


async def test_a_dropped_conversation_is_held_open_and_not_metered(
    talk, clock, db, session_factory, short_window
):
    await clock.passes(10)
    await eventually(lambda: live_seconds(db, talk))

    await drop(talk, session_factory)
    await clock.passes(500)

    row = await the_conversation(db, talk)
    assert (row.status, row.live_seconds) == ("active", 10)
    assert row.disconnected_at is not None


async def test_nobody_coming_back_ends_it_as_disconnected_and_drops_the_proposal(
    talk, db, session_factory, member, short_window
):
    staged = await stage(talk)
    await drop(talk, session_factory)

    async def ended():
        return (await the_conversation(db, talk)).status == "ended"

    await eventually(ended)

    assert (await the_conversation(db, talk)).end_reason == "disconnected"
    assert (await the_action(db, staged)).status == "cancelled"
    with pytest.raises(Conflict):
        await reconnect(session_factory, member, talk.id)


async def test_coming_back_inside_the_window_carries_on_where_it_was(
    talk, db, session_factory, member, short_window, notifications
):
    """Seeded with what was committed and what is open, so neither is proposed again."""
    first = await stage(talk)
    talk.socket.frame("approval", proposal_id=first["proposal_id"], decision="approve")
    await talk.socket.wait_for("proposal_result", status="committed")
    second = await stage(talk, title="Friday standup", date="2026-10-16")
    await drop(talk, session_factory)

    generation = await reconnect(session_factory, member, talk.id)
    socket, model = FakeSocket(), ScriptedModel()
    resumed = asyncio.create_task(
        LiveConversation(
            socket=socket,
            model=model,
            factory=session_factory,
            conversation_id=talk.id,
            user_id=member.id,
            generation=generation,
        ).run()
    )
    ready = await socket.wait_for("ready")
    session = await model.wait_for_session(1)

    assert ready["resumed"] is True and generation == 1
    assert (await socket.wait_for("proposal"))["id"] == second["proposal_id"]
    assert (await socket.wait_for("mode"))["mode"] == "working"
    assert "Saved: create the meeting Hendricks walkthrough" in session.instruction
    assert second["proposal_id"] in session.instruction

    # The old timer fires and finds the conversation has moved on.
    await asyncio.sleep(short_window + 0.2)
    row = await the_conversation(db, talk)
    assert (row.status, row.disconnected_at) == ("active", None)

    # And the proposal that was open before the drop can still be approved.
    socket.frame("approval", proposal_id=second["proposal_id"], decision="approve")
    await socket.wait_for("proposal_result", status="committed")
    assert await db.scalar(select(func.count()).select_from(Meeting)) == 2
    socket.frame("end")
    await asyncio.wait_for(resumed, 3)


async def test_a_reconnect_is_refused_when_the_allowance_has_run_out(
    talk, clock, db, session_factory, member
):
    await clock.passes(10)
    await eventually(lambda: live_seconds(db, talk))
    await set_team_minutes(db, 0)

    # Dropped before its next heartbeat could notice.
    talk.socket.hang_up()
    await asyncio.wait_for(talk.running, 3)

    row = await the_conversation(db, talk)
    if row.status == "active":
        with pytest.raises(LimitReached):
            await reconnect(session_factory, member, talk.id)
    else:
        with pytest.raises(Conflict):
            await reconnect(session_factory, member, talk.id)


async def test_a_conversation_orphaned_by_a_dead_instance_is_reaped_when_history_opens(
    talk, db, session_factory, member, monkeypatch
):
    staged = await stage(talk)
    talk.socket.hang_up()
    await asyncio.wait_for(talk.running, 3)
    # The instance died: no timer, and a heartbeat that stopped long ago.
    monkeypatch.setattr(agent_service, "STALE_HEARTBEAT_SECONDS", -1)

    page = await agent_service.list_conversations(db, await db.get(Profile, member.id))
    await db.commit()

    assert [(e.conversation.status, e.conversation.end_reason) for e in page.items] == [
        ("ended", "disconnected")
    ]
    assert (await the_action(db, staged)).status == "cancelled"


async def test_an_announced_end_ends_it_at_once(talk, db, session_factory):
    talk.socket.frame("end")
    ending = await asyncio.wait_for(talk.running, 3)

    await live.settle(session_factory, talk.id, talk.generation, ending)

    row = await the_conversation(db, talk)
    assert (row.status, row.end_reason) == ("ended", "user_closed")
