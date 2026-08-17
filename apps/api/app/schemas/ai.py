"""AI note-parsing schemas.

The output schema is the guardrail. The model returns free-form JSON; validating it
against ``ParsedEstimate`` before returning means a hallucinated category, a negative
quantity, or a missing room never reaches the estimate editor.
"""

from __future__ import annotations

from decimal import Decimal

from pydantic import Field, field_validator

from app.models.enums import ItemCategory, ItemUnit
from app.schemas.common import ORMSchema, Schema


class ParseNotesRequest(Schema):
    notes: str = Field(
        min_length=1,
        max_length=50_000,
        description="Free-form site notes, formal or casual.",
    )

    @field_validator("notes")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("notes cannot be blank")
        return v


class ParsedLineItem(ORMSchema):
    model_config = ORMSchema.model_config | {"populate_by_name": True}

    name: str = Field(min_length=1, max_length=300)
    category: ItemCategory = ItemCategory.OTHER
    unit: ItemUnit = ItemUnit.EA
    quantity: Decimal = Field(default=Decimal("0"), ge=0)
    unit_cost: Decimal = Field(default=Decimal("0"), ge=0, alias="unitCost")
    is_custom: bool = Field(default=True, alias="isCustom")
    catalogue_id: str | None = Field(default=None, alias="catalogueId")
    notes: str = ""

    @field_validator("category", mode="before")
    @classmethod
    def _coerce_category(cls, v: object) -> object:
        """Fall back to ``other`` for an unrecognised category.

        Preferred over rejecting the whole document: the model occasionally invents a
        plausible-sounding category, and losing that one classification is a far better
        outcome for the user than losing the entire parse.
        """
        if isinstance(v, str):
            lowered = v.strip().lower()
            if lowered in {c.value for c in ItemCategory}:
                return lowered
            return ItemCategory.OTHER.value
        return v

    @field_validator("unit", mode="before")
    @classmethod
    def _coerce_unit(cls, v: object) -> object:
        """Match units case-insensitively; ``ea``/``EA`` both mean ``Ea``."""
        if isinstance(v, str):
            for unit in ItemUnit:
                if unit.value.lower() == v.strip().lower():
                    return unit.value
            return ItemUnit.EA.value
        return v


class ParsedRoom(ORMSchema):
    name: str = Field(min_length=1, max_length=200)
    items: list[ParsedLineItem] = Field(default_factory=list)


class ParsedEstimate(ORMSchema):
    """A draft estimate. Nothing is persisted — the client reviews it, then saves."""

    project_name: str = ""
    client_name: str = ""
    pm_name: str = ""
    insurance_carrier: str = ""
    notes: str = ""
    rooms: list[ParsedRoom] = Field(min_length=1)

    @field_validator("rooms")
    @classmethod
    def _rooms_present(cls, v: list[ParsedRoom]) -> list[ParsedRoom]:
        if not v:
            raise ValueError("Could not extract any rooms from these notes.")
        return v
