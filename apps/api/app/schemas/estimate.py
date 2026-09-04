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

from pydantic import Field, field_validator

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

    #: Free text, not the ``ItemCategory`` / ``ItemUnit`` enums, for two reasons.
    #:
    #: A team can define its own units and categories in Settings (``team_settings``),
    #: and a value you can define but not use is not a setting — with the enums here,
    #: choosing "Roll" on a line was a 422 for the whole estimate.
    #:
    #: And documents written by the legacy app already contain categories the enums do
    #: not know (``electrical``, ``plumbing``). Under the enum the only way to keep such
    #: an estimate saveable was to rewrite those rows to ``other`` on every save, which
    #: silently destroyed the classification someone had chosen.
    #:
    #: Nothing computes on either field — totals use ``quantity * unitCost``, and the
    #: category only picks a swatch colour — so the enums remain what the UI *offers*
    #: rather than what the column *permits*.
    category: str = Field(default=ItemCategory.OTHER.value, max_length=100)
    unit: str = Field(default=ItemUnit.EA.value, max_length=50)
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
    #: Blank means unnamed. It used to default to the literal "New Estimate", which is
    #: why an unnamed estimate was indistinguishable from every other unnamed one.
    project_name: str = Field(default="", max_length=300)
    client_name: str = Field(default="", max_length=300)
    pm_name: str = Field(default="", max_length=200)
    insurance_carrier: str = Field(default="", max_length=200)
    notes: str = Field(default="", max_length=20_000)
    rooms: list[Room] = Field(default_factory=list, max_length=200)


class EstimateCreate(EstimateBase):
    """A new estimate. The identifier is generated when one is not supplied."""

    #: A claim reference the team can recognise.
    #:
    #: Deliberately unvalidated beyond trimming and length. The obvious instinct is a
    #: character whitelist, and it is wrong here: real identifiers in this business
    #: include "Self Pay", "Self pay proposal" and "SELF PAY the Difference". Spaces and
    #: mixed case are values people actually use, and a tidy pattern would reject the
    #: data already in the database.
    #:
    #: Absent or blank means "generate one", which is what keeps every existing caller —
    #: including a bare ``POST`` with an empty body — working unchanged.
    identifier: str | None = Field(default=None, max_length=40)

    @field_validator("identifier")
    @classmethod
    def _blank_means_generate(cls, value: str | None) -> str | None:
        if value is None:
            return None
        trimmed = value.strip()
        return trimmed or None


class EstimateUpdate(Schema):
    """A partial update. Omitted fields are left alone.

    ``status``, ``created_by``, and the review-workflow columns are absent on purpose:
    status only ever moves through ``POST /estimates/{id}/transitions``, which enforces
    the state machine. The legacy ``PUT`` handler had to strip those keys defensively
    on every call; here they simply cannot be expressed.
    """

    project_name: str | None = Field(default=None, max_length=300)
    client_name: str | None = Field(default=None, max_length=300)
    #: ``None`` means "leave it alone", as every field here does. An explicitly blank
    #: value is refused rather than regenerating: silently reassigning a claim ID during
    #: an edit is a surprise nobody asked for, and the reviewer's paperwork already has
    #: the old one on it.
    identifier: str | None = Field(default=None, max_length=40)

    @field_validator("identifier")
    @classmethod
    def _reject_blank(cls, value: str | None) -> str | None:
        if value is None:
            return None
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("Claim ID cannot be blank. Omit the field to leave it unchanged.")
        return trimmed

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


class EstimateIdOut(Schema):
    """An estimate reduced to what the unread dots need, and nothing else.

    Not ``EstimateOut`` with fields stripped: this is fetched for every estimate the user
    can see, so it has to stay two columns wide however large the list gets.
    """

    id: uuid.UUID
    status: str


class SubmitForReviewRequest(Schema):
    """Deliberately empty.

    The reviewer used to be typed into this payload. It is now the single user chosen in
    Settings, resolved server-side, because a hand-typed address is a delivery failure
    that leaves no trace anywhere: a typo means no send is ever attempted, so nothing
    appears in the mail provider's dashboard to explain the estimate nobody reviewed.

    Per DEVELOPMENT_GUIDELINES §2, a field a client must never set does not appear on the
    request model — so the recipient is absent rather than accepted and ignored. The
    schema stays as a type so the route keeps its shape and can grow options later.
    """


class SubmitForReviewOut(ORMSchema):
    estimate: EstimateOut
    #: Where the reviewer's link points. Useful for support, and for tests.
    review_url: str
