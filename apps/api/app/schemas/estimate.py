"""Estimate schemas, including the shape of the ``rooms`` JSON document.

Validating ``rooms`` at the boundary is the point of this module. The column is JSONB
and the legacy code wrote whatever the browser sent, so a malformed document only
surfaced much later — usually while rendering a total. Here a bad shape is a 422 on the
write that caused it.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated

from pydantic import EmailStr, Field, field_validator

from app.models.enums import EstimateStatus, ItemCategory, ItemUnit
from app.schemas.common import ActorRef, ORMSchema, Schema

Quantity = Annotated[Decimal, Field(ge=0, max_digits=12, decimal_places=4)]
UnitCost = Annotated[Decimal, Field(ge=0, max_digits=12, decimal_places=2)]


class LineItem(Schema):
    """One row inside a room.

    Field names use the camelCase the stored documents already contain
    (``unitCost``, ``isCustom``, ``catalogueId``) so migrated data validates without a
    rewrite. Aliases let the API accept snake_case too.
    """

    model_config = Schema.model_config | {"populate_by_name": True}

    name: str = Field(min_length=1, max_length=300)
    category: ItemCategory = ItemCategory.OTHER
    unit: ItemUnit = ItemUnit.EA
    quantity: Quantity = Decimal("0")
    unit_cost: UnitCost = Field(default=Decimal("0"), alias="unitCost")
    is_custom: bool = Field(default=False, alias="isCustom")
    catalogue_id: str | None = Field(default=None, alias="catalogueId", max_length=100)
    notes: str = Field(default="", max_length=2000)

    @property
    def total(self) -> Decimal:
        return self.quantity * self.unit_cost


class Room(Schema):
    model_config = Schema.model_config | {"populate_by_name": True}

    name: str = Field(min_length=1, max_length=200)
    items: list[LineItem] = Field(default_factory=list, max_length=500)


class EstimateBase(Schema):
    project_name: str = Field(default="New Estimate", max_length=300)
    client_name: str = Field(default="", max_length=300)
    pm_name: str = Field(default="", max_length=200)
    insurance_carrier: str = Field(default="", max_length=200)
    notes: str = Field(default="", max_length=20_000)
    rooms: list[Room] = Field(default_factory=list, max_length=200)


class EstimateCreate(EstimateBase):
    """The identifier is assigned by the server, never supplied by the client."""


class EstimateUpdate(Schema):
    """A partial update. Omitted fields are left alone.

    ``status``, ``created_by``, and the review-workflow columns are absent on purpose:
    status only ever moves through ``POST /estimates/{id}/transitions``, which enforces
    the state machine. The legacy ``PUT`` handler had to strip those keys defensively
    on every call; here they simply cannot be expressed.
    """

    project_name: str | None = Field(default=None, max_length=300)
    client_name: str | None = Field(default=None, max_length=300)
    pm_name: str | None = Field(default=None, max_length=200)
    insurance_carrier: str | None = Field(default=None, max_length=200)
    notes: str | None = Field(default=None, max_length=20_000)
    rooms: list[Room] | None = Field(default=None, max_length=200)


class RoomTotalOut(ORMSchema):
    name: str
    item_count: int
    total: Decimal


class EstimateTotalsOut(ORMSchema):
    total: Decimal
    room_count: int
    item_count: int
    rooms: list[RoomTotalOut]


class EstimateOut(ORMSchema):
    id: uuid.UUID
    identifier: str
    project_name: str
    client_name: str
    pm_name: str
    insurance_carrier: str
    notes: str
    rooms: list[dict[str, object]]
    status: EstimateStatus

    created_by: uuid.UUID | None = None
    creator: ActorRef | None = None
    created_at: datetime
    updated_at: datetime

    submitted_to: str | None = None
    submitted_at: datetime | None = None
    submitted_by: uuid.UUID | None = None
    reviewed_at: datetime | None = None
    review_note: str | None = None

    deleted_at: datetime | None = None
    deleted_by: uuid.UUID | None = None

    #: Computed, never stored. Present on every read so clients never re-derive it.
    totals: EstimateTotalsOut | None = None

    #: Deliberately absent: ``approval_token``. It is the secret in the reviewer's
    #: link, and staff have no reason to see it.


class TransitionRequest(Schema):
    action: str = Field(
        description=(
            "One of: archive, unarchive, lock, unlock, recall, resubmit_ready, admin_approve."
        )
    )

    @field_validator("action")
    @classmethod
    def _known_action(cls, v: str) -> str:
        from app.services.rules.estimate_rules import TRANSITIONS

        if v not in TRANSITIONS:
            allowed = ", ".join(sorted(TRANSITIONS))
            raise ValueError(f"Unknown action {v!r}. Expected one of: {allowed}")
        return v


class SubmitForReviewRequest(Schema):
    recipient_email: EmailStr
    recipient_name: str | None = Field(default=None, max_length=200)


class SubmitForReviewOut(ORMSchema):
    estimate: EstimateOut
    #: Where the reviewer's link points. Useful for support, and for tests.
    review_url: str
