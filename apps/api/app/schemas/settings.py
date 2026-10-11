"""Catalogue and team-settings contracts."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated

from pydantic import Field, field_validator

from app.schemas.common import ActorRef, ORMSchema, Schema

Money = Annotated[Decimal, Field(ge=0, max_digits=12, decimal_places=2)]

#: The admin notifications a team may switch off.
#:
#: Deliberately not every notification the system sends. A removed user attempting to
#: sign in is a security signal, not a routine update, and letting it be silenced from a
#: settings screen would make the one message nobody should miss the easiest to lose.
#: Reviewer decisions go to the person who submitted the estimate and are not admin
#: broadcasts, so they are not here either.
NOTIFICATION_KEYS: frozenset[str] = frozenset(
    {
        "estimate_locked",
        "member_joined",
        "member_removed",
    }
)


class CatalogueItemCreate(Schema):
    name: str = Field(min_length=1, max_length=300)
    category: str = Field(default="", max_length=100)
    unit: str = Field(default="", max_length=50)
    unit_cost: Money = Decimal("0")
    notes: str = Field(default="", max_length=2000)


class CatalogueItemUpdate(Schema):
    name: str | None = Field(default=None, min_length=1, max_length=300)
    category: str | None = Field(default=None, max_length=100)
    unit: str | None = Field(default=None, max_length=50)
    unit_cost: Money | None = None
    notes: str | None = Field(default=None, max_length=2000)


class CatalogueItemOut(ORMSchema):
    id: uuid.UUID
    name: str
    category: str
    unit: str
    unit_cost: Decimal
    notes: str
    created_by: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime


class TeamSettingsUpdate(Schema):
    """Partial update. Every field replaces its stored value wholesale."""

    custom_units: list[str] | None = Field(default=None, max_length=100)
    custom_categories: list[str] | None = Field(default=None, max_length=100)
    notification_prefs: dict[str, bool] | None = None
    #: Who every estimate sent for review goes to. ``None`` in a payload means "leave
    #: unchanged"; clearing it is deliberately not offered, because an unset reviewer
    #: makes submission fail and there is no reason to want that state on purpose.
    default_reviewer_id: uuid.UUID | None = None
    #: Minutes of live conversation with BuildCo Assistant each person gets per day.
    #: **Zero switches the assistant off for the whole team**, conversations in progress
    #: included, within a few seconds and without a deploy.
    agent_daily_minutes: int | None = Field(default=None, ge=0, le=1440)

    @field_validator("custom_units", "custom_categories")
    @classmethod
    def _clean(cls, values: list[str] | None) -> list[str] | None:
        """Trim, drop blanks, and de-duplicate case-insensitively.

        A list that can contain "SF", "sf" and " SF " is three entries in a dropdown
        that all mean the same thing, and whichever one is stored on a line item then
        fails to match the others.
        """
        if values is None:
            return None

        seen: set[str] = set()
        cleaned: list[str] = []
        for value in values:
            trimmed = value.strip()
            if not trimmed or len(trimmed) > 50:
                continue
            if trimmed.casefold() in seen:
                continue
            seen.add(trimmed.casefold())
            cleaned.append(trimmed)
        return cleaned

    @field_validator("notification_prefs")
    @classmethod
    def _known_keys(cls, prefs: dict[str, bool] | None) -> dict[str, bool] | None:
        """Reject an unrecognised key rather than storing a toggle that gates nothing.

        The stored value is opaque JSONB, so a typo would be accepted and then be
        invisible: the switch would appear to work and the email would keep arriving.
        """
        if prefs is None:
            return None

        unknown = sorted(set(prefs) - NOTIFICATION_KEYS)
        if unknown:
            raise ValueError(
                f"Unknown notification setting(s): {', '.join(unknown)}. "
                f"Known: {', '.join(sorted(NOTIFICATION_KEYS))}"
            )
        return prefs


class TeamSettingsOut(ORMSchema):
    custom_units: list[str] = Field(default_factory=list)
    custom_categories: list[str] = Field(default_factory=list)
    #: Every known key, with absent ones defaulted to enabled — so the client renders a
    #: complete set of switches without having to know the list itself.
    notification_prefs: dict[str, bool] = Field(default_factory=dict)
    #: Resolved rather than a bare id, so the settings screen and the submit modal can
    #: both name the reviewer without a second request.
    default_reviewer: ActorRef | None = None
    #: The allowance in force: the team's own figure, or the default until one is set.
    agent_daily_minutes: int = 0
    updated_at: datetime
    updated_by: uuid.UUID | None = None
