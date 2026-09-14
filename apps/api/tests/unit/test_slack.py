"""The estimate-submitted Slack webhook.

The payload is a contract with the Zapier workflow and with the legacy app posting to the
same channel, so it is asserted byte-for-byte rather than by loose substring checks.
"""

from __future__ import annotations

import json

import httpx
import pytest

from app.services.integrations import slack

EXPECTED_BODY = (
    '{"text": "📋 *New Supplement Estimate Submitted for Review*", "blocks": '
    '[{"type": "section", "text": {"type": "mrkdwn", "text": '
    '"📋 *Smith Residence Water Damage* has been submitted for approval.\\n'
    "*Claim ID:* CLM-2024-0187\\n"
    "*Client:* —\\n"
    "*Submitted by:* Jane Doe\\n"
    '*Sent to:* cbarrera@lahandyconstruction.com"}}]}'
)


def _example(**overrides: object) -> dict[str, object]:
    args: dict[str, object] = {
        "project_name": "Smith Residence Water Damage",
        "identifier": "CLM-2024-0187",
        "client_name": "",
        "submitted_by": "Jane Doe",
        "recipient_email": "cbarrera@lahandyconstruction.com",
    }
    args.update(overrides)
    return args


def test_the_payload_matches_the_legacy_message_exactly():
    payload = slack.build_estimate_submitted_payload(**_example())  # type: ignore[arg-type]

    assert json.dumps(payload, ensure_ascii=False) == EXPECTED_BODY


@pytest.mark.parametrize("client_name", [None, ""])
def test_a_missing_client_renders_as_an_em_dash(client_name):
    payload = slack.build_estimate_submitted_payload(**_example(client_name=client_name))  # type: ignore[arg-type]

    assert "\n*Client:* —\n" in payload["blocks"][0]["text"]["text"]  # type: ignore[index]


def test_user_data_is_not_escaped():
    payload = slack.build_estimate_submitted_payload(**_example(project_name="A *b* <c> & d"))  # type: ignore[arg-type]

    assert payload["blocks"][0]["text"]["text"].startswith("📋 *A *b* <c> & d* has")  # type: ignore[index]


@pytest.fixture
def webhook(monkeypatch, settings):  # type: ignore[no-untyped-def]
    """Capture webhook requests; ``respond`` decides what the fake Slack returns."""
    state: dict[str, object] = {"requests": [], "respond": lambda r: httpx.Response(200)}

    def handler(request: httpx.Request) -> httpx.Response:
        state["requests"].append(request)  # type: ignore[attr-defined]
        return state["respond"](request)  # type: ignore[operator]

    real_client = httpx.AsyncClient

    def fake_client(*args, **kwargs):  # type: ignore[no-untyped-def]
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(slack.httpx, "AsyncClient", fake_client)
    monkeypatch.setattr(settings, "slack_webhook_url", "https://hooks.slack.test/abc")
    return state


async def test_a_submission_posts_once_as_json(webhook):
    assert await slack.post_estimate_submitted(**_example()) is True  # type: ignore[arg-type]

    [request] = webhook["requests"]
    assert request.method == "POST"
    assert str(request.url) == "https://hooks.slack.test/abc"
    assert request.headers["content-type"] == "application/json"
    assert json.loads(request.content) == json.loads(EXPECTED_BODY)


async def test_nothing_is_sent_without_a_webhook(webhook, monkeypatch, settings):
    monkeypatch.setattr(settings, "slack_webhook_url", None)

    assert await slack.post_estimate_submitted(**_example()) is False  # type: ignore[arg-type]
    assert webhook["requests"] == []


async def test_an_error_response_does_not_raise(webhook):
    webhook["respond"] = lambda r: httpx.Response(410, text="invalid_token")

    assert await slack.post_estimate_submitted(**_example()) is False  # type: ignore[arg-type]


async def test_a_network_failure_does_not_raise(webhook):
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("dns failure", request=request)

    webhook["respond"] = boom

    assert await slack.post_estimate_submitted(**_example()) is False  # type: ignore[arg-type]
