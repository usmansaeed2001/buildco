"""Public reviewer schemas.

These are the only responses an unauthenticated caller can obtain, so they are written
from the reviewer's point of view and expose nothing about the internal team: no user
ids, no author, no activity history, no other estimates.

The legacy ``submit.js`` served hand-built HTML pages from these routes. They now
return JSON and the reviewer page is rendered by the frontend, which is what lets the
approval experience be designed rather than assembled from template literals.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from pydantic import Field

from app.models.enums import EstimateStatus
from app.schemas.common import ORMSchema, Schema


class ReviewLineItem(ORMSchema):
    name: str
    category: str = ""
    unit: str = ""
    quantity: Decimal = Decimal("0")
    unit_cost: Decimal = Decimal("0")
    total: Decimal = Decimal("0")
    notes: str = ""


class ReviewRoom(ORMSchema):
    name: str
    total: Decimal
    items: list[ReviewLineItem] = Field(default_factory=list)


class ReviewEstimateOut(ORMSchema):
    """What the reviewer sees before deciding."""

    project_name: str
    identifier: str
    client_name: str = ""
    insurance_carrier: str = ""
    pm_name: str = ""
    submitted_by: str = Field(default="", description="Display name of the submitter.")
    submitted_at: datetime | None = None
    status: EstimateStatus

    rooms: list[ReviewRoom] = Field(default_factory=list)
    total: Decimal = Decimal("0")
    room_count: int = 0
    item_count: int = 0

    #: False once a decision has been recorded, so the frontend can render a
    #: read-only receipt rather than live buttons.
    decision_pending: bool = True
    review_note: str | None = None


class RequestChangesRequest(Schema):
    notes: str = Field(
        min_length=1,
        max_length=10_000,
        description="What the submitter needs to change before this can be approved.",
    )


class ReviewDecisionOut(ORMSchema):
    status: EstimateStatus
    project_name: str
    identifier: str
    reviewed_at: datetime
    message: str
