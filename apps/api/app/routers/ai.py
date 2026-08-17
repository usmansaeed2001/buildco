"""AI-assisted endpoints."""

from __future__ import annotations

from fastapi import APIRouter

from app.deps import CurrentUser
from app.schemas.ai import ParsedEstimate, ParseNotesRequest
from app.services import ai_service

router = APIRouter(prefix="/ai", tags=["ai"])


@router.post("/parse-estimate", response_model=ParsedEstimate)
async def parse_estimate(body: ParseNotesRequest, user: CurrentUser) -> ParsedEstimate:
    """Turn free-form site notes into a draft estimate.

    Nothing is saved. The response is a draft for the editor to load; the user reviews
    it and saves a real estimate if it looks right.

    Returns 422 when the model's output cannot be coerced into a valid estimate, and
    503 when the AI service is unconfigured or unreachable.
    """
    return await ai_service.parse_notes(body.notes)
