"""BuildCo Assistant: who is offered it, starting a conversation, and the session ticket."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError
from sqlalchemy import func, select

from app.agent import live
from app.config import Settings, get_settings
from app.models.agent import AgentAction, AgentConversation, AgentMemory, AgentMessage
from app.models.enums import AgentEndReason, UserStatus
from app.models.profile import Profile
from app.services import agent_service
from app.services.agent_service import TicketRefused


@pytest.fixture
def agent_on(monkeypatch):
    """The assistant switched on for everyone. Individual tests narrow it."""
    settings = get_settings()
    monkeypatch.setattr(settings, "agent_enabled", True)
    monkeypatch.setattr(settings, "agent_audience", "everyone")
    monkeypatch.setattr(settings, "agent_pilot_emails", [])
    return settings


async def start(client, **body):
    return await client.post("/api/v1/agent/sessions", json=body)


# ── Who is offered it ─────────────────────────────────────────────────────────


async def test_the_assistant_is_off_unless_it_is_switched_on(member_client):
    status = (await member_client.get("/api/v1/agent/status")).json()

    assert status["enabled"] is False


async def test_the_status_endpoint_needs_a_signed_in_user(anon_client):
    assert (await anon_client.get("/api/v1/agent/status")).status_code == 401


async def test_during_the_pilot_only_the_people_listed_are_offered_it(
    client_as, member, other_member, agent_on, monkeypatch
):
    monkeypatch.setattr(agent_on, "agent_audience", "pilot")
    monkeypatch.setattr(agent_on, "agent_pilot_emails", [member.email])

    async with client_as(member) as listed, client_as(other_member) as unlisted:
        on_the_list = (await listed.get("/api/v1/agent/status")).json()
        off_the_list = (await unlisted.get("/api/v1/agent/status")).json()

    assert (on_the_list["enabled"], off_the_list["enabled"]) == (True, False)


async def test_an_empty_pilot_list_offers_it_to_nobody_not_even_the_owner(
    owner_client, agent_on, monkeypatch
):
    """Fails closed, and applies to every role alike."""
    monkeypatch.setattr(agent_on, "agent_audience", "pilot")

    assert (await owner_client.get("/api/v1/agent/status")).json()["enabled"] is False
    assert (await start(owner_client)).status_code == 403


# ── Starting a conversation ───────────────────────────────────────────────────


async def test_a_conversation_cannot_be_started_while_the_assistant_is_off(member_client):
    response = await start(member_client)

    assert response.status_code == 503


async def test_starting_a_conversation_returns_a_ticket_and_where_to_connect(
    member_client, agent_on
):
    response = await start(member_client, client_timezone="America/Los_Angeles")

    assert response.status_code == 201
    body = response.json()
    assert body["ws_url"] == "ws://localhost:8000/api/v1/agent/live"
    assert len(body["ticket"]) >= 32
    assert body["limits"]["max_session_seconds"] == 1800


async def test_the_ticket_itself_is_never_stored(member_client, agent_on, db):
    body = (await start(member_client)).json()

    conversation = await db.get(AgentConversation, uuid.UUID(body["conversation_id"]))

    assert conversation.ticket_hash != body["ticket"]
    assert len(conversation.ticket_hash) == 64
    assert conversation.status == "pending"


async def test_an_unknown_timezone_is_stored_as_utc_rather_than_refused(
    member_client, agent_on, db
):
    body = (await start(member_client, client_timezone="Mars/Olympus_Mons")).json()

    conversation = await db.get(AgentConversation, uuid.UUID(body["conversation_id"]))

    assert conversation.client_timezone == "UTC"


async def test_starting_a_second_conversation_ends_the_first(member_client, agent_on, db):
    """One live conversation per person: a second tab takes over from the first."""
    first = (await start(member_client)).json()
    await redeem(db, first["ticket"])

    second = (await start(member_client)).json()

    earlier = await db.get(AgentConversation, uuid.UUID(first["conversation_id"]))
    await db.refresh(earlier)
    assert (earlier.status, earlier.end_reason) == ("ended", AgentEndReason.SUPERSEDED.value)
    assert second["conversation_id"] != first["conversation_id"]


# ── The ticket ────────────────────────────────────────────────────────────────


async def redeem(db, ticket):
    result = await agent_service.redeem_ticket(db, ticket)
    await db.commit()
    return result


async def test_a_ticket_opens_its_conversation_for_the_person_it_was_issued_to(
    member_client, member, agent_on, db
):
    body = (await start(member_client)).json()

    conversation, user = await redeem(db, body["ticket"])

    assert str(conversation.id) == body["conversation_id"]
    assert user.id == member.id
    assert conversation.status == "active"
    assert conversation.started_at is not None


async def test_a_ticket_works_once(member_client, agent_on, db):
    body = (await start(member_client)).json()
    await redeem(db, body["ticket"])

    with pytest.raises(TicketRefused):
        await redeem(db, body["ticket"])


async def test_a_made_up_ticket_is_refused(db, agent_on):
    with pytest.raises(TicketRefused):
        await redeem(db, "not-a-ticket-anyone-issued")


async def test_a_ticket_is_refused_after_a_minute(member_client, agent_on, db):
    body = (await start(member_client)).json()
    conversation = await db.get(AgentConversation, uuid.UUID(body["conversation_id"]))
    conversation.ticket_expires_at = datetime.now(UTC) - timedelta(seconds=1)
    await db.commit()

    with pytest.raises(TicketRefused):
        await redeem(db, body["ticket"])


async def test_a_ticket_is_refused_for_someone_removed_since_it_was_issued(
    member_client, member, agent_on, db
):
    body = (await start(member_client)).json()
    (await db.get(Profile, member.id)).status = UserStatus.BANNED.value
    await db.commit()

    with pytest.raises(TicketRefused):
        await redeem(db, body["ticket"])


async def test_a_ticket_for_a_conversation_that_was_superseded_is_refused(
    member_client, agent_on, db
):
    first = (await start(member_client)).json()
    await start(member_client)

    with pytest.raises(TicketRefused):
        await redeem(db, first["ticket"])


# ── The socket's front door ───────────────────────────────────────────────────


def test_a_socket_from_the_apps_own_origin_is_let_in():
    assert live.origin_allowed("http://testserver")
    assert live.origin_allowed("http://testserver/")


@pytest.mark.parametrize("origin", ["https://evil.example", "http://testserver.evil.example", None])
def test_a_socket_from_anywhere_else_is_not(origin):
    """A WebSocket is not subject to CORS, so this check is ours to make."""
    assert not live.origin_allowed(origin)


# ── Reading a conversation back ───────────────────────────────────────────────


async def test_a_person_can_read_their_own_conversation(member_client, agent_on):
    body = (await start(member_client)).json()

    response = await member_client.get(f"/api/v1/agent/conversations/{body['conversation_id']}")

    assert response.status_code == 200
    assert response.json()["messages"] == []


async def test_nobody_else_can_read_it_not_even_the_owner(client_as, member, owner, agent_on):
    """404, not 403. There is deliberately no team-wide view of anyone's conversations."""
    async with client_as(member) as member_client:
        body = (await start(member_client)).json()

    async with client_as(owner) as owner_client:
        response = await owner_client.get(f"/api/v1/agent/conversations/{body['conversation_id']}")

    assert response.status_code == 404


# ── A half-configured voice service refuses to start ──────────────────────────

PRODUCTION = {
    "environment": "production",
    "agent_serve_live": True,
    "resend_api_key": "re_test",
    "site_url": "https://app.buildco.example",
    "notify_from_email": "notify@buildco.example",
}


def settings_with(**overrides):
    return Settings(_env_file=None, **{**PRODUCTION, **overrides})


def test_a_fully_configured_voice_service_starts():
    assert settings_with().agent_serve_live


@pytest.mark.parametrize(
    ("missing", "says"),
    [
        ({"resend_api_key": None}, "RESEND_API_KEY"),
        ({"site_url": "http://localhost:5173"}, "SITE_URL"),
        ({"notify_from_email": "onboarding@resend.dev"}, "NOTIFY_FROM_EMAIL"),
    ],
)
def test_the_voice_service_will_not_start_in_production_without_its_email_settings(missing, says):
    """It sends the invites and reviewer emails for what the assistant commits. Left to
    degrade quietly, the user would be told a meeting was created that nobody was
    invited to."""
    with pytest.raises(ValidationError, match=says):
        settings_with(**missing)


def test_the_api_service_is_not_held_to_that():
    """Only the process that serves the voice stream sends on the assistant's behalf."""
    assert settings_with(agent_serve_live=False, resend_api_key=None)


def test_nor_is_local_development():
    assert settings_with(environment="local", resend_api_key=None, site_url="http://localhost:5173")


# ── The daily allowance ───────────────────────────────────────────────────────


async def a_conversation(
    db, user, *, live_seconds=0, started=None, ended=None, title=""
) -> AgentConversation:
    now = datetime.now(UTC)
    row = AgentConversation(
        user_id=user.id,
        status="ended",
        title=title,
        started_at=started or now,
        ended_at=ended or started or now,
        end_reason="user_closed",
        live_seconds=live_seconds,
        last_heartbeat_at=started or now,
    )
    db.add(row)
    await db.commit()
    return row


async def test_the_status_says_how_much_of_today_is_left_and_when_it_resets(
    member_client, member, agent_on, db
):
    await a_conversation(db, member, live_seconds=150)

    status = (await member_client.get("/api/v1/agent/status")).json()

    assert (status["daily_limit_seconds"], status["used_seconds"]) == (600, 150)
    assert status["remaining_seconds"] == 450
    resets = datetime.fromisoformat(status["resets_at"])
    assert (resets.hour, resets.minute, resets.utcoffset()) == (0, 0, timedelta(0))
    assert resets > datetime.now(UTC)


async def test_someone_elses_time_is_not_counted_against_you(
    member_client, other_member, agent_on, db
):
    await a_conversation(db, other_member, live_seconds=600)

    assert (await member_client.get("/api/v1/agent/status")).json()["remaining_seconds"] == 600


async def test_yesterdays_time_does_not_count_today(member, db):
    """The day turns at 00:00 UTC, on the server's clock."""
    midnight = datetime(2026, 10, 12, 0, 0, tzinfo=UTC)
    await a_conversation(db, member, live_seconds=600, started=midnight - timedelta(minutes=5))
    await a_conversation(db, member, live_seconds=90, started=midnight + timedelta(minutes=5))

    late_yesterday = await agent_service.allowance_for(
        db, member.id, now=midnight - timedelta(seconds=1)
    )
    early_today = await agent_service.allowance_for(
        db, member.id, now=midnight + timedelta(hours=1)
    )

    assert late_yesterday.remaining_seconds == 0
    assert (early_today.used_seconds, early_today.remaining_seconds) == (90, 510)
    assert early_today.resets_at == midnight + timedelta(days=1)


async def test_a_conversation_is_refused_once_todays_allowance_is_spent(
    member_client, member, agent_on, db
):
    await a_conversation(db, member, live_seconds=600)

    refused = await start(member_client)

    assert refused.status_code == 429
    assert refused.json()["error"]["code"] == "limit_reached"
    assert (await member_client.get("/api/v1/agent/status")).json()["remaining_seconds"] == 0


async def test_an_owner_sets_the_teams_allowance_and_a_member_cannot(
    client_as, owner, member, agent_on
):
    async with client_as(member) as as_member, client_as(owner) as as_owner:
        assert (await as_member.get("/api/v1/settings")).json()["agent_daily_minutes"] == 10
        denied = await as_member.patch("/api/v1/settings", json={"agent_daily_minutes": 60})
        changed = await as_owner.patch("/api/v1/settings", json={"agent_daily_minutes": 25})
        status = (await as_member.get("/api/v1/agent/status")).json()

    assert denied.status_code == 403
    assert changed.json()["agent_daily_minutes"] == 25
    assert status["daily_limit_seconds"] == 25 * 60


async def test_an_allowance_of_zero_switches_the_assistant_off_for_everyone(
    client_as, owner, agent_on
):
    """Zero is a figure, not "unset": it must not fall back to the default."""
    async with client_as(owner) as as_owner:
        await as_owner.patch("/api/v1/settings", json={"agent_daily_minutes": 0})
        status = (await as_owner.get("/api/v1/agent/status")).json()
        refused = await start(as_owner)

    assert (status["daily_limit_seconds"], status["remaining_seconds"]) == (0, 0)
    assert refused.status_code == 429


@pytest.mark.parametrize("minutes", [-1, 1441, 2.5])
async def test_an_allowance_has_to_be_a_sensible_number_of_minutes(owner_client, minutes):
    response = await owner_client.patch("/api/v1/settings", json={"agent_daily_minutes": minutes})

    assert response.status_code == 422


# ── Reconnecting ──────────────────────────────────────────────────────────────


async def test_a_dropped_conversation_can_be_reconnected_to_with_a_fresh_ticket(
    member_client, agent_on, db
):
    started = (await start(member_client)).json()
    await agent_service.redeem_ticket(db, started["ticket"])
    await db.commit()

    again = await member_client.post(
        f"/api/v1/agent/sessions/{started['conversation_id']}/reconnect"
    )

    assert again.status_code == 200
    body = again.json()
    assert body["conversation_id"] == started["conversation_id"]
    assert body["ticket"] != started["ticket"]
    conversation, _ = await agent_service.redeem_ticket(db, body["ticket"])
    assert conversation.connection_generation == 1


async def test_nobody_can_reconnect_to_another_persons_conversation(
    client_as, member, owner, agent_on, db
):
    async with client_as(member) as as_member, client_as(owner) as as_owner:
        started = (await start(as_member)).json()
        await agent_service.redeem_ticket(db, started["ticket"])
        await db.commit()

        theirs = await as_owner.post(
            f"/api/v1/agent/sessions/{started['conversation_id']}/reconnect"
        )

    assert theirs.status_code == 404


async def test_a_conversation_that_has_ended_cannot_be_reconnected_to(
    member_client, member, agent_on, db
):
    """There is no resuming. A reconnect is for a blip, inside a minute."""
    ended = await a_conversation(db, member)

    response = await member_client.post(f"/api/v1/agent/sessions/{ended.id}/reconnect")

    assert response.status_code == 409


async def test_a_reconnect_more_than_a_minute_after_the_drop_is_refused(
    member_client, agent_on, db
):
    started = (await start(member_client)).json()
    conversation, _ = await agent_service.redeem_ticket(db, started["ticket"])
    conversation.disconnected_at = datetime.now(UTC) - timedelta(seconds=61)
    await db.commit()

    response = await member_client.post(
        f"/api/v1/agent/sessions/{started['conversation_id']}/reconnect"
    )

    assert response.status_code == 409


# ── History ───────────────────────────────────────────────────────────────────


def an_action(conversation, user, status="committed", **extra) -> AgentAction:
    return AgentAction(
        conversation_id=conversation.id,
        user_id=user.id,
        kind="meeting.create",
        status=status,
        payload={},
        summary="I am about to create the meeting X.",
        approval_policy="voice_or_click",
        expires_at=datetime.now(UTC),
        **extra,
    )


async def test_history_lists_a_persons_own_conversations_newest_first(
    client_as, member, other_member, agent_on, db
):
    now = datetime.now(UTC)
    await a_conversation(
        db, member, title="Book the walkthrough", live_seconds=75, started=now - timedelta(hours=2)
    )
    recent = await a_conversation(
        db, member, title="Archive the Okafor one", started=now - timedelta(hours=1)
    )
    await a_conversation(db, other_member, title="Not mine")
    db.add_all(
        [an_action(recent, member, status) for status in ("committed", "committed", "cancelled")]
    )
    await db.commit()

    async with client_as(member) as as_member:
        page = (await as_member.get("/api/v1/agent/conversations")).json()

    assert page["total"] == 2
    assert [
        (row["title"], row["action_count"], row["duration_seconds"]) for row in page["items"]
    ] == [("Archive the Okafor one", 2, 0), ("Book the walkthrough", 0, 75)]


async def test_history_needs_a_signed_in_user(anon_client):
    assert (await anon_client.get("/api/v1/agent/conversations")).status_code == 401


async def test_a_conversation_that_never_connected_is_not_history(member_client, agent_on):
    await start(member_client)

    assert (await member_client.get("/api/v1/agent/conversations")).json()["items"] == []


async def old_conversation(db, user) -> AgentConversation:
    long_ago = datetime.now(UTC) - timedelta(days=91)
    row = await a_conversation(db, user, title="An old one", started=long_ago, ended=long_ago)
    db.add_all(
        [
            AgentMessage(conversation_id=row.id, seq=1, role="user", source="voice", text="Hello"),
            an_action(row, user, approved_via="voice", approval_utterance="yes, go ahead"),
        ]
    )
    await db.commit()
    return row


async def test_a_transcript_past_ninety_days_is_hidden_at_once_and_its_actions_are_not(
    member_client, member, agent_on, db
):
    """Hidden from every read immediately, whether or not it has been deleted yet."""
    old = await old_conversation(db, member)

    listed = (await member_client.get("/api/v1/agent/conversations")).json()["items"][0]
    opened = (await member_client.get(f"/api/v1/agent/conversations/{old.id}")).json()

    assert (listed["title"], listed["transcript_expired"], listed["action_count"]) == ("", True, 1)
    assert (opened["transcript_expired"], opened["messages"], opened["title"]) == (True, [], "")
    assert [action["status"] for action in opened["actions"]] == ["committed"]
    # Not deleted yet: only hidden.
    assert await db.scalar(select(func.count()).select_from(AgentMessage)) == 1


async def test_starting_a_conversation_deletes_expired_transcripts_and_keeps_the_action_log(
    member_client, member, agent_on, db
):
    old = await old_conversation(db, member)
    kept = await a_conversation(db, member, title="A recent one")
    db.add(AgentMessage(conversation_id=kept.id, seq=1, role="user", source="voice", text="Hi"))
    await db.commit()

    await start(member_client)

    remaining = list(await db.scalars(select(AgentMessage.conversation_id)))
    assert remaining == [kept.id]
    await db.refresh(old)
    assert (old.title, old.transcript_purged_at is not None) == ("", True)
    action = await db.scalar(select(AgentAction).where(AgentAction.conversation_id == old.id))
    # The few words that approved it are the evidence of the approval, and are kept.
    assert (action.status, action.approval_utterance) == ("committed", "yes, go ahead")


async def test_the_purge_works_in_bounded_batches(member, db):
    for _ in range(3):
        await old_conversation(db, member)

    first = await agent_service.purge_expired_transcripts(db, limit=2)
    second = await agent_service.purge_expired_transcripts(db, limit=2)
    third = await agent_service.purge_expired_transcripts(db, limit=2)

    assert (first, second, third) == (2, 1, 0)
    assert await db.scalar(select(func.count()).select_from(AgentMessage)) == 0


# ── Memories ──────────────────────────────────────────────────────────────────


async def a_memory(db, user, content="Prefers to be called Sam") -> AgentMemory:
    row = AgentMemory(
        user_id=user.id,
        category="identity",
        content=content,
        source="explicit",
        evidence="please call me Sam",
    )
    db.add(row)
    await db.commit()
    return row


async def test_a_person_sees_what_the_assistant_remembers_about_them_and_why(
    client_as, member, other_member, db
):
    await a_memory(db, member)
    await a_memory(db, other_member, content="Not about me")

    async with client_as(member) as as_member:
        listed = (await as_member.get("/api/v1/agent/memories")).json()

    assert [
        (row["content"], row["category"], row["source"], row["evidence"]) for row in listed
    ] == [("Prefers to be called Sam", "identity", "explicit", "please call me Sam")]


async def test_a_person_can_delete_a_memory_of_their_own(member_client, member, db):
    memory = await a_memory(db, member)

    response = await member_client.delete(f"/api/v1/agent/memories/{memory.id}")

    assert response.status_code == 200
    assert (await member_client.get("/api/v1/agent/memories")).json() == []


async def test_nobody_can_delete_another_persons_memory_not_even_the_owner(
    client_as, member, owner, db
):
    memory = await a_memory(db, member)

    async with client_as(owner) as as_owner:
        response = await as_owner.delete(f"/api/v1/agent/memories/{memory.id}")

    assert response.status_code == 404
    assert await db.scalar(select(func.count()).select_from(AgentMemory)) == 1


async def test_memories_need_a_signed_in_user(anon_client):
    assert (await anon_client.get("/api/v1/agent/memories")).status_code == 401
    assert (await anon_client.delete(f"/api/v1/agent/memories/{uuid.uuid4()}")).status_code == 401
