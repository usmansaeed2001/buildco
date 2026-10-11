"""The suite cannot reach a real service, whatever a developer's ``.env`` holds.

These exist because it once did. A production Slack webhook sat in a local ``.env``,
``conftest`` removed the variable from the environment and took that to mean the
integration was off, and every test that submitted a supplement posted to the real
channel. Each test here fails if one of the layers that now prevents that is removed.
"""

from __future__ import annotations

import re

import httpx
import pytest

from app.config import Settings, get_settings
from tests.conftest import OUTBOUND_SETTINGS

REFUSED = re.escape("real network request to 192.0.2.1")
LIVE_VALUES = "\n".join(f"{variable}=live-value-from-a-dotenv" for variable in OUTBOUND_SETTINGS)


def test_no_integration_is_configured():
    configured = [
        variable
        for variable, attribute in OUTBOUND_SETTINGS.items()
        if getattr(get_settings(), attribute)
    ]

    assert configured == []


def test_every_optional_integration_setting_is_one_the_suite_switches_off():
    """A new integration has to be added to the list, or this fails."""
    names = ("_api_key", "_webhook_url", "_bucket", "_credentials_file")
    in_settings = {name for name in Settings.model_fields if name.endswith(names)}

    assert in_settings == set(OUTBOUND_SETTINGS.values())


def test_a_dotenv_full_of_live_values_configures_nothing(tmp_path):
    dotenv = tmp_path / ".env"
    dotenv.write_text(LIVE_VALUES, encoding="utf-8")

    loaded = Settings(_env_file=dotenv)  # type: ignore[call-arg]

    assert [name for name in OUTBOUND_SETTINGS.values() if getattr(loaded, name)] == []


def test_removing_the_variables_instead_would_let_the_dotenv_through(tmp_path, monkeypatch):
    """What ``conftest`` used to do, kept as proof of why it no longer does."""
    dotenv = tmp_path / ".env"
    dotenv.write_text(LIVE_VALUES, encoding="utf-8")
    for variable in OUTBOUND_SETTINGS:
        monkeypatch.delenv(variable)

    loaded = Settings(_env_file=dotenv)  # type: ignore[call-arg]

    assert loaded.slack_webhook_url == "live-value-from-a-dotenv"


async def test_a_real_request_is_refused_before_it_leaves():
    # 192.0.2.0/24 is reserved for documentation: nothing answers there, so if the guard
    # were missing this would time out rather than reach anyone.
    async with httpx.AsyncClient(timeout=2) as client:
        with pytest.raises(RuntimeError, match=REFUSED):
            await client.post("http://192.0.2.1/hook", json={"text": "should never be sent"})


def test_a_real_blocking_request_is_refused_too():
    with (
        httpx.Client(timeout=2) as client,
        pytest.raises(RuntimeError, match=REFUSED),
    ):
        client.get("http://192.0.2.1/")


async def test_a_faked_third_party_still_works():
    transport = httpx.MockTransport(lambda request: httpx.Response(200, text="ok"))

    async with httpx.AsyncClient(transport=transport) as client:
        response = await client.post("https://hooks.slack.test/abc", json={})

    assert response.text == "ok"
