"""Note parsing with a Groq-hosted LLM.

Same OpenAI-compatible endpoint the legacy ``parse.js`` called. The difference is what
happens to the response: the old code did ``JSON.parse`` and handed the result straight
back to the browser, so a hallucinated category or a missing price reached the estimate
editor untouched. Here the payload is validated against a Pydantic schema before it
leaves the service, and anything that fails validation is a 422 rather than a
mysteriously broken estimate later on.
"""

from __future__ import annotations

import json
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


async def parse_notes(notes: str) -> dict[str, Any]:
    """Send notes to the model and return the raw parsed JSON object.

    Raises ``IntegrationUnavailable`` when Groq is unconfigured or unreachable, and
    ``ValidationFailed`` when the model returns something that is not a JSON object.
    Schema-level validation of the contents happens in ``ai_service``.
    """
    settings = get_settings()
    if not settings.groq_api_key:
        raise IntegrationUnavailable(
            "AI note parsing is unavailable: GROQ_API_KEY is not configured."
        )

    payload = {
        "model": settings.groq_model,
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
                f"{settings.groq_base_url}/chat/completions",
                headers={"Authorization": f"Bearer {settings.groq_api_key}"},
                json=payload,
            )
    except httpx.HTTPError as exc:
        log.error("groq_request_error", error=str(exc))
        raise IntegrationUnavailable("The AI service could not be reached.") from exc

    if response.status_code >= 400:
        log.error("groq_error_response", status=response.status_code, body=response.text[:500])
        raise IntegrationUnavailable("The AI service returned an error.")

    body = response.json()
    content = body.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
    if not content:
        raise ValidationFailed("The AI service returned an empty response.")

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as exc:
        log.error("groq_invalid_json", snippet=content[:300])
        raise ValidationFailed("The AI service returned malformed JSON.") from exc

    if not isinstance(parsed, dict):
        raise ValidationFailed("The AI service returned an unexpected structure.")

    return parsed
