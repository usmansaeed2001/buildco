"""AI-assisted parsing of site notes into a draft estimate."""

from __future__ import annotations

from pydantic import ValidationError

from app.errors import ValidationFailed
from app.logging import get_logger
from app.schemas.ai import ParsedEstimate
from app.services.integrations import groq

log = get_logger(__name__)


async def parse_notes(notes: str) -> ParsedEstimate:
    """Turn free-form notes into a validated draft estimate.

    Nothing is persisted. The client reviews the draft in the editor and saves it as a
    normal estimate if it looks right, which keeps a bad parse from ever becoming a
    stored document.

    Validation is the substance of this function. The model is asked for a specific
    shape and usually obliges, but "usually" is not a contract — so the response is
    parsed into ``ParsedEstimate`` and a failure becomes a 422 the client can show,
    rather than a malformed ``rooms`` array landing in the editor.
    """
    raw = await groq.parse_notes(notes)

    try:
        return ParsedEstimate.model_validate(raw)
    except ValidationError as exc:
        log.warning(
            "ai_output_failed_validation",
            error_count=exc.error_count(),
            first_error=str(exc.errors()[0]) if exc.errors() else "",
        )
        raise ValidationFailed(
            "The AI could not produce a usable estimate from these notes. "
            "Try describing the rooms and items more explicitly.",
            details={"issues": [e.get("msg", "") for e in exc.errors()[:5]]},
        ) from exc
