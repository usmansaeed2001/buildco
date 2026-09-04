"""Note parsing with a hosted LLM.

The same OpenAI-compatible Chat Completions endpoint the legacy ``parse.js`` called. The
difference is what happens to the response: the old code did ``JSON.parse`` and handed
the result straight back to the browser, so a hallucinated category or a missing price
reached the estimate editor untouched. Here the payload is validated against a Pydantic
schema before it leaves the service, and anything that fails validation is a 422 rather
than a mysteriously broken estimate later on.

**Why this moved off Groq.** Groq retires hosted models without aliasing the old id
forward, and a retired id fails *every* call with a 400 saying only that the model does
not exist. That happened twice: ``llama-3.3-70b-versatile`` was already dead when the
environment was first provisioned, and it was still the configured value in ``.env``
when note parsing was reported broken. OpenAI keeps dated aliases working, so the same
class of silent rot is much less likely.

Groq stays wired as a fallback for one release, because deploying this code and setting
``OPEN_AI_API_KEY`` are separate acts and a hard cutover would leave the parser dead in
between. ``_provider()`` is the whole of that transition and is meant to be deleted.

Both providers speak the same wire format, which is why this is a base URL and a key
rather than an SDK: adding the ``openai`` package would pull a dependency to send the
request ``httpx`` already sends.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import httpx

from app.config import get_settings
from app.errors import IntegrationUnavailable, ValidationFailed
from app.logging import get_logger

log = get_logger(__name__)

SYSTEM_PROMPT = """\
You are an expert construction estimator. Parse the user's notes into a structured \
JSON estimate.

Extract rooms and items from ANY kind of notes, formal or casual. Even a simple note \
like "2 rooms, each with 2 paint buckets at $2 each" must produce 2 rooms, each with \
one paint-bucket line item.

Rules:
- Always create at least one room.
- Always create at least one item per room.
- Extract quantities and prices exactly as stated.
- If no price is mentioned, use a reasonable industry default.
- "category" must be one of: drywall, flooring, trim, painting, custom, other.
- "unit" must be one of: LF, SF, Ea, Qty, Sq.

Return ONLY valid JSON in exactly this shape, with no markdown and no commentary:
{
  "project_name": "string",
  "client_name": "string",
  "pm_name": "string",
  "insurance_carrier": "string",
  "notes": "brief summary",
  "rooms": [
    {
      "name": "Room name",
      "items": [
        {
          "name": "Item name",
          "category": "painting",
          "unit": "Ea",
          "quantity": 2,
          "unitCost": 2.00,
          "isCustom": true,
          "notes": ""
        }
      ]
    }
  ]
}
"""


@dataclass(frozen=True, slots=True)
class Provider:
    """Which service to call, resolved once per request."""

    name: str
    api_key: str
    model: str
    base_url: str


def _provider() -> Provider:
    """OpenAI when it is configured, Groq while it still is, otherwise 503.

    Transitional. Delete the Groq branch once every environment carries
    ``OPEN_AI_API_KEY``.
    """
    settings = get_settings()
    if settings.open_ai_api_key:
        return Provider(
            name="openai",
            api_key=settings.open_ai_api_key,
            model=settings.openai_model,
            base_url=settings.openai_base_url,
        )
    if settings.groq_api_key:
        log.warning("ai_provider_fallback_to_groq", model=settings.groq_model)
        return Provider(
            name="groq",
            api_key=settings.groq_api_key,
            model=settings.groq_model,
            base_url=settings.groq_base_url,
        )
    raise IntegrationUnavailable(
        "AI note parsing is unavailable: OPEN_AI_API_KEY is not configured."
    )


async def parse_notes(notes: str) -> dict[str, Any]:
    """Send notes to the model and return the raw parsed JSON object.

    Raises ``IntegrationUnavailable`` when no provider is configured or the call fails,
    and ``ValidationFailed`` when the model returns something that is not a JSON object.
    Schema-level validation of the contents happens in ``ai_service``.
    """
    settings = get_settings()
    provider = _provider()

    payload = {
        "model": provider.model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": notes},
        ],
        # Near-zero temperature: this is extraction, not composition.
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
    }

    try:
        async with httpx.AsyncClient(timeout=settings.http_timeout_seconds * 3) as client:
            response = await client.post(
                f"{provider.base_url}/chat/completions",
                headers={"Authorization": f"Bearer {provider.api_key}"},
                json=payload,
            )
    except httpx.HTTPError as exc:
        log.error("ai_request_error", provider=provider.name, error=str(exc))
        raise IntegrationUnavailable("The AI service could not be reached.") from exc

    if response.status_code >= 400:
        # The model id is logged deliberately. A retired or misspelled model is the most
        # common way this breaks, and the provider's 400 says only "the model does not
        # exist" — without the id in our own logs, diagnosing it means guessing which
        # environment variable the running process actually read.
        log.error(
            "ai_error_response",
            provider=provider.name,
            model=provider.model,
            status=response.status_code,
            body=response.text[:500],
        )
        raise IntegrationUnavailable("The AI service returned an error.")

    body = response.json()
    content = body.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
    if not content:
        raise ValidationFailed("The AI service returned an empty response.")

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as exc:
        log.error("ai_invalid_json", provider=provider.name, snippet=content[:300])
        raise ValidationFailed("The AI service returned malformed JSON.") from exc

    if not isinstance(parsed, dict):
        raise ValidationFailed("The AI service returned an unexpected structure.")

    return parsed
