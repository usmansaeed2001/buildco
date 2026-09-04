"""The note-parsing adapter: provider selection, and what happens when a call goes wrong.

There were no tests here at all until now, which is the direct reason a retired model id
reached production twice. `llama-3.3-70b-versatile` was dead when the environment was
first provisioned and was *still* the configured value in `.env` when note parsing was
reported broken — a 400 from the provider saying only "the model does not exist", with
nothing on our side recording which model had been asked for.

So these cover the failure modes rather than the happy path alone.
"""

from __future__ import annotations

import json
from collections.abc import Callable

import httpx
import pytest

from app.config import Settings
from app.errors import IntegrationUnavailable, ValidationFailed
from app.services.integrations import ai_provider

GOOD_ESTIMATE = {
    "project_name": "Storm damage",
    "rooms": [{"name": "Roof", "items": [{"name": "Shingles", "quantity": 20, "unitCost": 12.5}]}],
}


def _settings(**overrides: object) -> Settings:
    """A Settings object with no provider configured unless a test asks for one.

    Built directly rather than through `get_settings()`, which is `lru_cache`d and reads
    the developer's real `.env` — a suite that depended on that would pass or fail
    depending on whose machine it ran on.
    """
    base: dict[str, object] = {"open_ai_api_key": None, "groq_api_key": None}
    return Settings(**{**base, **overrides})  # type: ignore[arg-type]


@pytest.fixture
def provider(monkeypatch: pytest.MonkeyPatch) -> Callable[..., list[httpx.Request]]:
    """Point the adapter at a stub transport and record what it sent."""

    def configure(
        *, responder: Callable[[httpx.Request], httpx.Response], **settings: object
    ) -> list[httpx.Request]:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return responder(request)

        real_client = httpx.AsyncClient

        def factory(**_kwargs: object) -> httpx.AsyncClient:
            return real_client(transport=httpx.MockTransport(handler))

        monkeypatch.setattr(ai_provider.httpx, "AsyncClient", factory)
        monkeypatch.setattr(ai_provider, "get_settings", lambda: _settings(**settings))
        return seen

    return configure


def _replies(payload: object, status: int = 200) -> Callable[[httpx.Request], httpx.Response]:
    content = payload if isinstance(payload, str) else json.dumps(payload)
    body = {"choices": [{"message": {"content": content}}]}
    return lambda _request: httpx.Response(status, json=body)


# ── Provider selection ────────────────────────────────────────────────────────


async def test_no_provider_configured_is_a_503(monkeypatch: pytest.MonkeyPatch) -> None:
    """Unconfigured must be distinguishable from broken: the UI says so in words."""
    monkeypatch.setattr(ai_provider, "get_settings", lambda: _settings())

    with pytest.raises(IntegrationUnavailable) as caught:
        await ai_provider.parse_notes("some notes")

    assert "OPEN_AI_API_KEY" in str(caught.value)


async def test_openai_is_used_when_its_key_is_set(provider) -> None:
    seen = provider(
        responder=_replies(GOOD_ESTIMATE),
        open_ai_api_key="sk-test",
        openai_model="gpt-4o-mini",
    )

    await ai_provider.parse_notes("two rooms")

    assert seen[0].url.host == "api.openai.com"
    assert json.loads(seen[0].content)["model"] == "gpt-4o-mini"
    assert seen[0].headers["authorization"] == "Bearer sk-test"


async def test_groq_still_answers_while_openai_is_unset(provider) -> None:
    """The transitional fallback. Delete this test with the branch it covers."""
    seen = provider(
        responder=_replies(GOOD_ESTIMATE),
        groq_api_key="gsk-test",
        groq_model="openai/gpt-oss-120b",
    )

    await ai_provider.parse_notes("two rooms")

    assert seen[0].url.host == "api.groq.com"


async def test_openai_wins_when_both_are_configured(provider) -> None:
    seen = provider(
        responder=_replies(GOOD_ESTIMATE), open_ai_api_key="sk-test", groq_api_key="gsk-test"
    )

    await ai_provider.parse_notes("two rooms")

    assert seen[0].url.host == "api.openai.com"


# ── Failure modes ─────────────────────────────────────────────────────────────


async def test_a_retired_model_is_logged_with_the_model_id(
    provider, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The whole point of the logging change.

    A provider 400 says only that the model does not exist. Without the id in our own
    logs, diagnosing it means guessing which value the running process actually read.
    Asserted on the structlog call rather than `caplog`, which structlog does not feed.
    """
    logged: list[dict[str, object]] = []
    monkeypatch.setattr(ai_provider.log, "error", lambda _event, **kw: logged.append(kw))
    provider(
        responder=lambda _r: httpx.Response(400, json={"error": {"message": "model not found"}}),
        open_ai_api_key="sk-test",
        openai_model="gpt-retired-9000",
    )

    with pytest.raises(IntegrationUnavailable):
        await ai_provider.parse_notes("two rooms")

    assert logged[0]["model"] == "gpt-retired-9000"
    assert logged[0]["status"] == 400


async def test_an_unreachable_provider_is_a_503(provider) -> None:
    def explode(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    provider(responder=explode, open_ai_api_key="sk-test")

    with pytest.raises(IntegrationUnavailable):
        await ai_provider.parse_notes("two rooms")


async def test_malformed_json_is_a_422_not_a_503(provider) -> None:
    """A bad answer is the model's fault, not the integration's — the caller can retry."""
    provider(responder=_replies("this is not json at all"), open_ai_api_key="sk-test")

    with pytest.raises(ValidationFailed):
        await ai_provider.parse_notes("two rooms")


async def test_an_empty_answer_is_a_422(provider) -> None:
    provider(responder=_replies(""), open_ai_api_key="sk-test")

    with pytest.raises(ValidationFailed):
        await ai_provider.parse_notes("two rooms")


async def test_a_json_array_is_refused(provider) -> None:
    """Valid JSON of the wrong shape still cannot become an estimate."""
    provider(responder=_replies([1, 2, 3]), open_ai_api_key="sk-test")

    with pytest.raises(ValidationFailed):
        await ai_provider.parse_notes("two rooms")


async def test_a_good_answer_comes_back_as_a_dict(provider) -> None:
    provider(responder=_replies(GOOD_ESTIMATE), open_ai_api_key="sk-test")

    parsed = await ai_provider.parse_notes("two rooms")

    assert parsed["rooms"][0]["name"] == "Roof"
