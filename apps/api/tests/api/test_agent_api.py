"""BuildCo Assistant: who is offered it, starting a conversation, and the session ticket."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from app.agent import live
from app.config import Settings, get_settings
from app.models.agent import AgentConversation
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
