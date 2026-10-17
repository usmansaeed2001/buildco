"""A whole conversation, with the browser and the model both scripted.

The model here does whatever the test tells it to, including the things a real one was
seen doing against its instructions: committing on a "yes" that interrupted the
read-back, and carrying on as if a commit it was interrupted during had never happened.
Those are the cases worth having, because nothing about the server's guarantees may
depend on the model behaving.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass

import pytest
from sqlalchemy import func, select

from app.agent import conversation as conversation_module
from app.agent.conversation import Ending, LiveConversation
from app.config import get_settings
from app.models.agent import AgentAction, AgentConversation, AgentMessage
from app.models.enums import AgentEndReason, UserStatus
from app.models.meeting import Meeting
from app.models.profile import Profile
from app.services import agent_service
from tests.agent_fakes import FakeSocket, ScriptedModel


@dataclass
class Talk:
    conversation: LiveConversation
    socket: FakeSocket
    model: ScriptedModel
    running: asyncio.Task
    id: uuid.UUID


@pytest.fixture
async def talk(session_factory, member, notifications, monkeypatch):
    """A live conversation for ``member``, in Pacific time, already under way."""
    settings = get_settings()
    monkeypatch.setattr(settings, "agent_enabled", True)
    monkeypatch.setattr(settings, "agent_audience", "everyone")

    async with session_factory() as db:
        issued = await agent_service.create_session(
            db, await db.get(Profile, member.id), client_timezone="America/Los_Angeles"
        )
        await db.commit()
        opened, _ = await agent_service.redeem_ticket(db, issued.ticket)
        await db.commit()

    socket, model = FakeSocket(), ScriptedModel()
    live = LiveConversation(
        socket=socket,
        model=model,
        factory=session_factory,
        conversation_id=opened.id,
        user_id=member.id,
    )
    running = asyncio.create_task(live.run())
    await socket.wait_for("ready")
    await model.wait_for_session(1)

    yield Talk(live, socket, model, running, opened.id)

    if not running.done():
        socket.frame("end")
        await asyncio.wait_for(running, 3)


async def eventually(check, timeout: float = 3.0):
    """Wait for something the server does on its own time to have happened."""

    async def poll():
        while True:
            value = await check()
            if value:
                return value
            await asyncio.sleep(0.01)

    return await asyncio.wait_for(poll(), timeout)


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


async def stage(talk: Talk, **overrides) -> dict:
    return await talk.model.session.calls("propose_create_meeting", **a_meeting(**overrides))


async def hear_the_readback(talk: Talk, staged: dict, db, *, finished_at: float) -> None:
    """The agent speaks the summary in full, and the browser reports that it played."""
    talk.model.session.says(staged["summary"] + " Do you approve?")
    await talk.socket.wait_for("turn_complete", readback_for=staged["proposal_id"])
    talk.socket.microphone(finished_at)
    talk.socket.frame("readback_played", proposal_id=staged["proposal_id"])

    async def played():
        action = await db.get(AgentAction, uuid.UUID(staged["proposal_id"]), populate_existing=True)
        return action.readback_played_at is not None

    await eventually(played)


async def meetings(db) -> int:
    return await db.scalar(select(func.count()).select_from(Meeting)) or 0


async def action(db, staged: dict) -> AgentAction:
    return await db.get(AgentAction, uuid.UUID(staged["proposal_id"]), populate_existing=True)


# ── Starting ──────────────────────────────────────────────────────────────────


async def test_the_model_is_told_who_it_is_talking_to_and_in_which_timezone(talk, member):
    told = talk.model.session.instruction

    assert f"Name: {member.display_name}" in told
    assert "Time zone: America/Los_Angeles" in told
    assert member.display_name in talk.model.session.vocabulary


async def test_the_model_is_given_the_tools_and_no_others(talk):
    """A new tool is a deliberate act: this list has to be edited to add one.

    What none of them can reach is checked in ``test_agent_tools``.
    """
    assert set(talk.model.session.tools) == {
        "search_supplements",
        "get_supplement",
        "list_meetings",
        "get_meeting",
        "search_projects",
        "get_project",
        "list_team_members",
        "search_catalogue",
        "get_team_settings",
        "get_current_view",
        "list_memories",
        "propose_create_meeting",
        "propose_update_meeting",
        "propose_create_supplement",
        "propose_update_supplement_details",
        "propose_add_supplement_lines",
        "propose_supplement_transition",
        "propose_submit_for_review",
        "propose_change_memory",
        "commit_proposal",
        "cancel_proposal",
        "show_in_app",
        "remember",
        "end_conversation",
    }


async def test_microphone_audio_reaches_the_model(talk):
    talk.socket.microphone(2.0)

    async def arrived():
        return talk.model.session.audio_seconds == 2.0

    await eventually(arrived)


async def test_what_is_said_on_both_sides_is_kept_as_text(talk, db):
    talk.model.session.hears("What is on my calendar tomorrow?", began_at=1.0)
    talk.model.session.says("Nothing is scheduled tomorrow.")
    await talk.socket.wait_for("turn_complete")

    async def both():
        rows = list(await db.scalars(select(AgentMessage).order_by(AgentMessage.seq)))
        return rows if len(rows) == 2 else None

    lines = await eventually(both)
    assert [(line.role, line.source, line.text) for line in lines] == [
        ("user", "voice", "What is on my calendar tomorrow?"),
        ("assistant", "voice", "Nothing is scheduled tomorrow."),
    ]
    conversation = await db.get(AgentConversation, talk.id, populate_existing=True)
    assert conversation.title == "What is on my calendar tomorrow?"


# ── Proposing ─────────────────────────────────────────────────────────────────


async def test_proposing_stages_the_meeting_and_saves_nothing(talk, db):
    staged = await stage(talk)

    assert staged["ok"] is True
    assert "Hendricks walkthrough on Wednesday, 14 October 2026 at 2:30 PM" in staged["summary"]
    assert await meetings(db) == 0
    assert (await action(db, staged)).status == "proposed"


async def test_the_browser_is_put_into_work_mode_and_shown_exactly_what_would_be_saved(talk):
    staged = await stage(talk, location="12 Maple Street")

    assert (await talk.socket.wait_for("mode"))["mode"] == "working"
    directive = await talk.socket.wait_for("ui", action="stage")
    card = await talk.socket.wait_for("proposal")
    assert directive["proposal"] == {k: v for k, v in card.items() if k != "type"}
    assert card["id"] == staged["proposal_id"]
    assert card["summary"] == staged["summary"]
    assert card["payload"]["location"] == "12 Maple Street"
    # 2:30 pm Pacific on 14 October is 21:30 UTC: the time was read in the user's zone.
    assert card["payload"]["start_time"].startswith("2026-10-14T21:30")


async def test_the_staged_form_is_given_a_label_for_every_attendee(talk, other_member):
    await stage(
        talk, attendee_ids=[str(other_member.id)], guest_emails=["adjuster@insurer.example.com"]
    )

    card = await talk.socket.wait_for("proposal")
    assert card["labels"]["attendees"] == [
        {"label": other_member.display_name},
        {"label": "adjuster@insurer.example.com", "note": "outside guest"},
    ]


async def test_nothing_is_staged_over_a_dialog_the_user_has_open(talk, db):
    talk.socket.frame("context", route="/calendar", dialog_open=True)
    await asyncio.sleep(0.05)

    staged = await stage(talk)

    assert staged["ok"] is False
    assert "dialog open" in staged["tell_the_user"]
    assert talk.socket.of("proposal") == []
    assert await db.scalar(select(func.count()).select_from(AgentAction)) == 0


async def test_a_proposal_the_browser_cannot_show_is_dropped(talk, db):
    talk.socket.stage_answer = {"ok": False, "reason": "The calendar could not be opened."}

    staged = await stage(talk)

    assert staged == {"ok": False, "tell_the_user": "The calendar could not be opened."}
    assert (await talk.socket.wait_for("proposal_result"))["status"] == "cancelled"
    assert talk.socket.of("mode")[-1]["mode"] == "conversing"


async def test_a_removed_person_cannot_be_proposed_as_an_attendee(talk, other_member, db):
    (await db.get(Profile, other_member.id)).status = UserStatus.BANNED.value
    await db.commit()

    staged = await stage(talk, attendee_ids=[str(other_member.id)])

    assert staged["ok"] is False
    assert "removed from the team" in staged["tell_the_user"]
    assert talk.socket.of("proposal") == []


async def test_an_id_that_is_not_a_team_members_is_refused_not_dropped(talk):
    staged = await stage(talk, attendee_ids=[str(uuid.uuid4())])

    assert staged["ok"] is False
    assert "not on the team" in staged["tell_the_user"]


async def test_a_correction_replaces_the_proposal_it_corrects(talk, db):
    first = await stage(talk)
    second = await stage(talk, start_time="16:00")

    assert (await talk.socket.wait_for("proposal_result", id=first["proposal_id"]))[
        "status"
    ] == "superseded"
    assert (await action(db, first)).status == "superseded"
    assert (await action(db, second)).status == "proposed"


# ── Approving by voice ────────────────────────────────────────────────────────


async def test_a_yes_after_the_whole_readback_commits_the_meeting(talk, db):
    staged = await stage(talk)
    await hear_the_readback(talk, staged, db, finished_at=40.0)
    talk.model.session.hears("Yes, go ahead.", began_at=41.0)

    result = await talk.model.session.calls("commit_proposal", proposal_id=staged["proposal_id"])

    assert result["ok"] is True
    assert await meetings(db) == 1
    saved = await action(db, staged)
    assert (saved.status, saved.approved_via) == ("committed", "voice")
    assert saved.approval_utterance == "Yes, go ahead."
    assert saved.result["type"] == "meeting"
    outcome = await talk.socket.wait_for("proposal_result", status="committed")
    assert outcome["target"] == saved.result
    assert talk.socket.of("mode")[-1]["mode"] == "conversing"


async def test_a_commit_before_the_readback_has_been_heard_is_refused(talk, db):
    """The model asks to commit straight after staging. It has read nothing back."""
    staged = await stage(talk)

    result = await talk.model.session.calls("commit_proposal", proposal_id=staged["proposal_id"])

    assert result["ok"] is False
    assert await meetings(db) == 0
    assert (await action(db, staged)).status == "proposed"


async def test_a_yes_that_interrupted_the_readback_does_not_count(talk, db):
    """What the real model did every time: commit on a yes spoken over the summary."""
    staged = await stage(talk)
    talk.model.session.starts_saying("I am about to create the meeting Hendricks")
    talk.model.session.hears("Yes.", began_at=3.0)
    talk.model.session.is_interrupted()
    await talk.socket.wait_for("interrupted")
    # A browser that reported it played anyway is not believed: the turn never finished.
    talk.socket.microphone(5.0)
    talk.socket.frame("readback_played", proposal_id=staged["proposal_id"])
    await asyncio.sleep(0.05)

    result = await talk.model.session.calls("commit_proposal", proposal_id=staged["proposal_id"])

    assert result["ok"] is False
    assert await meetings(db) == 0
    assert all(frame["readback_for"] is None for frame in talk.socket.of("turn_complete"))


async def test_a_yes_that_began_before_the_readback_finished_does_not_count(talk, db):
    staged = await stage(talk)
    talk.model.session.hears("Yes yes, fine.", began_at=12.0)
    await hear_the_readback(talk, staged, db, finished_at=40.0)

    result = await talk.model.session.calls("commit_proposal", proposal_id=staged["proposal_id"])

    assert result["ok"] is False
    assert "before the read-back had finished" in result["tell_the_user"]
    assert await meetings(db) == 0


async def test_a_turn_that_did_not_speak_the_summary_is_not_the_readback(talk, db):
    """The agent says something else after staging. Hearing that is not hearing the summary."""
    staged = await stage(talk)
    talk.model.session.says("One moment while I set that up.")
    await talk.socket.wait_for("turn_complete", spoke=True)
    talk.socket.microphone(10.0)
    talk.socket.frame("readback_played", proposal_id=staged["proposal_id"])
    talk.model.session.hears("Yes.", began_at=11.0)

    result = await talk.model.session.calls("commit_proposal", proposal_id=staged["proposal_id"])

    assert result["ok"] is False
    assert await meetings(db) == 0


async def test_typing_yes_after_the_readback_counts(talk, db):
    staged = await stage(talk)
    await hear_the_readback(talk, staged, db, finished_at=40.0)
    talk.socket.frame("text", text="yes")

    async def passed_on():
        return "yes" in talk.model.session.texts

    await eventually(passed_on)
    result = await talk.model.session.calls("commit_proposal", proposal_id=staged["proposal_id"])

    assert result["ok"] is True
    assert await meetings(db) == 1


# ── On a phone ────────────────────────────────────────────────────────────────


async def on_a_phone(talk: Talk) -> None:
    talk.socket.frame("context", route="/calendar", layout="phone")

    async def told():
        return talk.conversation.on_phone

    await eventually(told)


async def test_on_a_phone_the_model_is_told_to_ask_for_the_line_back(talk):
    await on_a_phone(talk)

    staged = await stage(talk)

    assert "Hendricks walkthrough, Wednesday 14 October at 2:30 PM" in staged["what_to_do"]
    shown = await talk.socket.wait_for("proposal")
    assert shown["labels"]["confirm"]["line"] == (
        "Hendricks walkthrough, Wednesday 14 October at 2:30 PM"
    )


async def test_on_a_phone_a_yes_alone_does_not_approve(talk, db):
    await on_a_phone(talk)
    staged = await stage(talk)
    await hear_the_readback(talk, staged, db, finished_at=40.0)
    talk.model.session.hears("Yes, go ahead.", began_at=41.0)

    result = await talk.model.session.calls("commit_proposal", proposal_id=staged["proposal_id"])

    assert result["ok"] is False
    assert "say the confirmation line back" in result["tell_the_user"]
    assert "Hendricks walkthrough, Wednesday 14 October at 2:30 PM" in result["tell_the_user"]
    assert await meetings(db) == 0


async def test_on_a_phone_saying_the_line_back_approves(talk, db):
    await on_a_phone(talk)
    staged = await stage(talk)
    await hear_the_readback(talk, staged, db, finished_at=40.0)
    talk.model.session.hears("Yes.", began_at=41.0)
    talk.model.session.hears(
        "Hendricks walkthrough, Wednesday the fourteenth of October at two thirty PM",
        began_at=43.0,
    )

    async def heard():
        return "Hendricks" in talk.conversation._last_heard

    await eventually(heard)
    result = await talk.model.session.calls("commit_proposal", proposal_id=staged["proposal_id"])

    assert result["ok"] is True
    assert await meetings(db) == 1


async def test_on_a_phone_the_readback_heard_through_the_microphone_is_not_the_users_words(
    talk, db
):
    """Speech that began before the read-back finished may be the read-back itself."""
    await on_a_phone(talk)
    staged = await stage(talk)
    talk.model.session.hears(
        "Hendricks walkthrough on Wednesday 14 October 2026 at 2:30 PM", began_at=12.0
    )
    await hear_the_readback(talk, staged, db, finished_at=40.0)
    talk.model.session.hears("Yes.", began_at=41.0)

    async def heard():
        return talk.conversation._last_heard == "Yes."

    await eventually(heard)
    result = await talk.model.session.calls("commit_proposal", proposal_id=staged["proposal_id"])

    assert result["ok"] is False
    assert await meetings(db) == 0


async def test_on_a_phone_typing_the_line_approves(talk, db):
    await on_a_phone(talk)
    staged = await stage(talk)
    await hear_the_readback(talk, staged, db, finished_at=40.0)
    talk.socket.frame("text", text="hendricks walkthrough 14 october 2:30pm")

    async def passed_on():
        return any("hendricks" in text for text in talk.model.session.texts)

    await eventually(passed_on)
    result = await talk.model.session.calls("commit_proposal", proposal_id=staged["proposal_id"])

    assert result["ok"] is True
    assert await meetings(db) == 1


# ── Approving with a click ────────────────────────────────────────────────────


async def test_a_meeting_that_invites_someone_cannot_be_approved_by_voice(talk, other_member, db):
    staged = await stage(talk, attendee_ids=[str(other_member.id)])
    assert staged["approval"] == "click"
    await hear_the_readback(talk, staged, db, finished_at=40.0)
    talk.model.session.hears("Yes, send it.", began_at=41.0)

    result = await talk.model.session.calls("commit_proposal", proposal_id=staged["proposal_id"])

    assert result["ok"] is False
    assert "press Approve" in result["tell_the_user"]
    assert await meetings(db) == 0


async def test_clicking_approve_commits_it_and_sends_the_invite(
    talk, other_member, db, notifications
):
    staged = await stage(talk, attendee_ids=[str(other_member.id)])

    talk.socket.frame("approval", proposal_id=staged["proposal_id"], decision="approve")
    await talk.socket.wait_for("proposal_result", status="committed")

    assert await meetings(db) == 1
    assert (await action(db, staged)).approved_via == "click"
    assert [sent.recipient for sent in notifications.sent] == [other_member.email]
    # The model did not make this happen and has to be told that it did.
    assert any(
        text.startswith("[System notice") and "pressed Approve" in text and "saved" in text
        for text in talk.model.session.texts
    )


async def test_clicking_approve_does_not_need_the_readback_to_have_finished(talk, db):
    """The card on screen is complete, and the card is what is being approved."""
    staged = await stage(talk)

    talk.socket.frame("approval", proposal_id=staged["proposal_id"], decision="approve")
    await talk.socket.wait_for("proposal_result", status="committed")

    assert await meetings(db) == 1


async def test_a_click_from_someone_removed_mid_conversation_saves_nothing(talk, member, db):
    """A click is not a tool call, so nothing else would have checked."""
    staged = await stage(talk)
    (await db.get(Profile, member.id)).status = UserStatus.BANNED.value
    await db.commit()

    talk.socket.frame("approval", proposal_id=staged["proposal_id"], decision="approve")
    outcome = await talk.socket.wait_for("proposal_result", status="failed")

    assert "can no longer do this" in outcome["error"]
    assert await meetings(db) == 0
    assert (await action(db, staged)).status == "failed"


async def test_clicking_reject_saves_nothing_and_tells_the_model(talk, db):
    staged = await stage(talk)

    talk.socket.frame("approval", proposal_id=staged["proposal_id"], decision="reject")
    await talk.socket.wait_for("proposal_result", status="cancelled")

    assert await meetings(db) == 0
    assert (await action(db, staged)).status == "cancelled"
    assert any("pressed Reject" in text for text in talk.model.session.texts)
    assert talk.socket.of("mode")[-1]["mode"] == "conversing"


async def test_the_model_can_drop_a_proposal_when_the_user_says_no(talk, db):
    staged = await stage(talk)

    result = await talk.model.session.calls("cancel_proposal", proposal_id=staged["proposal_id"])

    assert result["status"] == "cancelled"
    assert (await action(db, staged)).status == "cancelled"
    assert await meetings(db) == 0


# ── Stop ──────────────────────────────────────────────────────────────────────


async def test_stop_hands_the_form_over_and_unlocks_the_app(talk, db):
    staged = await stage(talk)

    talk.socket.frame("stop")
    await talk.socket.wait_for("proposal_result", status="handed_over")

    assert (await action(db, staged)).status == "handed_over"
    assert await meetings(db) == 0
    assert talk.socket.of("mode")[-1]["mode"] == "conversing"
    assert any("pressed Stop" in text for text in talk.model.session.texts)


async def test_a_proposal_handed_over_can_no_longer_be_committed(talk, db):
    staged = await stage(talk)
    talk.socket.frame("stop")
    await talk.socket.wait_for("proposal_result", status="handed_over")

    result = await talk.model.session.calls("commit_proposal", proposal_id=staged["proposal_id"])

    assert result["ok"] is False
    assert await meetings(db) == 0


# ── A commit the user talks over ──────────────────────────────────────────────


async def test_a_commit_the_user_talked_over_is_reported_to_the_model_anyway(talk, db):
    """The model is told its call was cancelled, and would say nothing was saved."""
    staged = await stage(talk)
    await hear_the_readback(talk, staged, db, finished_at=40.0)
    talk.model.session.hears("Yes, go ahead.", began_at=41.0)
    result = await talk.model.session.calls("commit_proposal", proposal_id=staged["proposal_id"])
    assert result["ok"] is True

    # The user was already speaking: the model never gets to report the result.
    talk.model.session.hears("Wait, hold on.", began_at=43.0)
    talk.model.session.is_interrupted()

    async def told():
        return [text for text in talk.model.session.texts if "the commit finished" in text]

    notices = await eventually(told)
    assert notices[0].startswith("[System notice")
    assert "saved" in notices[0]
    assert await meetings(db) == 1


async def test_a_commit_the_model_did_report_is_not_reported_twice(talk, db):
    staged = await stage(talk)
    await hear_the_readback(talk, staged, db, finished_at=40.0)
    talk.model.session.hears("Yes.", began_at=41.0)
    await talk.model.session.calls("commit_proposal", proposal_id=staged["proposal_id"])
    talk.model.session.says("Done, the meeting is saved.")
    await talk.socket.wait_for("turn_complete", spoke=True, readback_for=None)

    talk.model.session.hears("Thanks.", began_at=50.0)
    talk.model.session.is_interrupted()
    await asyncio.sleep(0.05)

    assert not any("the commit finished" in text for text in talk.model.session.texts)


# ── The model session dying ───────────────────────────────────────────────────


async def test_a_dead_model_session_is_replaced_and_told_where_things_stand(talk, db):
    """A committed meeting and an open proposal must both survive the model's amnesia."""
    first = await stage(talk)
    talk.socket.frame("approval", proposal_id=first["proposal_id"], decision="approve")
    await talk.socket.wait_for("proposal_result", status="committed")
    talk.model.session.hears("Now one for Friday at nine for an hour.", began_at=60.0)
    second = await stage(
        talk, title="Friday standup", date="2026-10-16", start_time="09:00", duration_minutes=60
    )

    talk.model.session.dies(TimeoutError("timed out during opening handshake"))
    replacement = await talk.model.wait_for_session(2)

    assert (await talk.socket.wait_for("notice"))["kind"] == "model_reconnected"
    told = replacement.instruction
    assert "Already committed" in told and "Saved: create the meeting Hendricks walkthrough" in told
    assert second["proposal_id"] in told and "Friday standup" in told
    assert "user: Now one for Friday at nine for an hour." in told
    assert not talk.running.done()
    # And the proposal that was open is still approvable.
    talk.socket.frame("approval", proposal_id=second["proposal_id"], decision="approve")
    await talk.socket.wait_for("proposal_result", id=second["proposal_id"], status="committed")
    assert await meetings(db) == 2


async def test_a_model_session_that_simply_closes_is_replaced_too(talk):
    talk.model.session.dies()

    await talk.model.wait_for_session(2)

    assert not talk.running.done()


async def test_a_model_that_cannot_be_brought_back_ends_the_conversation(talk, monkeypatch):
    monkeypatch.setattr(conversation_module, "MAX_MODEL_RESTARTS", 2)

    for number in (1, 2, 3):
        (await talk.model.wait_for_session(number)).dies(RuntimeError("unavailable"))

    assert await asyncio.wait_for(talk.running, 3) == Ending.ended(AgentEndReason.ERROR)
    assert talk.socket.of("error")[0]["code"] == "integration_unavailable"
    assert talk.socket.sent[-1]["type"] == "ended"
    assert talk.socket.sent[-1]["reason"] == "error"


# ── Ending ────────────────────────────────────────────────────────────────────


async def test_closing_the_panel_ends_the_conversation_and_drops_an_open_proposal(talk, db):
    staged = await stage(talk)

    talk.socket.frame("end")

    assert await asyncio.wait_for(talk.running, 3) == Ending.ended(AgentEndReason.USER_CLOSED)
    assert (await action(db, staged)).status == "cancelled"
    assert await meetings(db) == 0
    assert talk.model.session.closed


async def test_a_dropped_connection_is_reported_as_a_drop_not_as_an_ending(talk, db):
    """The socket's part is over. Whether the conversation is, is decided a minute later."""
    staged = await stage(talk)

    talk.socket.hang_up()

    assert await asyncio.wait_for(talk.running, 3) == Ending("dropped")
    assert talk.socket.of("ended") == []
    assert talk.model.session.closed
    # Still staged: the browser may be back within the minute.
    assert (await action(db, staged)).status == "proposed"


async def test_a_conversation_is_ended_at_the_time_limit(session_factory, member, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "agent_enabled", True)
    monkeypatch.setattr(settings, "agent_audience", "everyone")
    monkeypatch.setattr(settings, "agent_max_session_seconds", 0.2)
    async with session_factory() as db:
        issued = await agent_service.create_session(
            db, await db.get(Profile, member.id), client_timezone="UTC"
        )
        await db.commit()
        opened, _ = await agent_service.redeem_ticket(db, issued.ticket)
        await db.commit()
    socket = FakeSocket()

    reason = await LiveConversation(
        socket=socket,
        model=ScriptedModel(),
        factory=session_factory,
        conversation_id=opened.id,
        user_id=member.id,
    ).run()

    assert reason == Ending.ended(AgentEndReason.TIME_LIMIT)
    assert socket.sent[-1]["type"] == "ended"
    assert socket.sent[-1]["reason"] == "time_limit"
