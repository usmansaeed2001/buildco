"""Team-wide settings: the rate catalogue and the shared preferences row.

These replace behaviour that lived in ``localStorage`` in the legacy app. That made the
universal rate list per-browser and per-device: two estimators on the same job saw
different prices, nothing survived clearing site data, and the "notification" toggles
gated nothing at all because the emails were sent server-side and the browser was never
consulted.

Both are deliberately team-wide rather than per-user. A rate list that differs between
people is not a rate list, and a notification preference that differs between admins
means an email that some of them get and others do not, with no way to tell which.
"""

from __future__ import annotations

# Runtime import: SQLAlchemy resolves Mapped[...] annotations at class-creation time,
# so uuid cannot hide under TYPE_CHECKING.
import uuid
from decimal import Decimal
from typing import Any

from sqlalchemy import ForeignKey, Numeric, String, Text, Uuid, text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, JSONBType, TimestampMixin, UUIDPrimaryKey

#: The single row's primary key.
#:
#: A settings table with one row needs a way to guarantee it stays one row. A fixed key
#: does that without a partial index or a check constraint: every writer targets the
#: same id, so a race produces a duplicate-key error the service can recover from
#: rather than a second row nobody notices.
SETTINGS_ROW_ID = uuid.UUID("00000000-0000-4000-8000-000000000001")


class CatalogueItem(Base, UUIDPrimaryKey, TimestampMixin):
    """A line in the universal rate list, used to add a priced item in one click."""

    __tablename__ = "catalogue_items"

    name: Mapped[str] = mapped_column(String(300), nullable=False)
    #: Free text rather than an enum column: `custom_categories` on the settings row can
    #: introduce values `ItemCategory` does not know, and a catalogue entry has to be
    #: able to use them. What is *written to an estimate* is still normalised.
    category: Mapped[str] = mapped_column(String(100), server_default=text("''"), default="")
    unit: Mapped[str] = mapped_column(String(50), server_default=text("''"), default="")
    unit_cost: Mapped[Decimal] = mapped_column(
        Numeric(12, 2), server_default=text("0"), default=Decimal("0"), nullable=False
    )
    notes: Mapped[str] = mapped_column(Text, server_default=text("''"), default="", nullable=False)

    created_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL")
    )


class TeamSettings(Base, TimestampMixin):
    """The one row of shared preferences.

    Everything here is JSONB rather than columns, because all three are lists or maps
    that the UI owns and that will grow: a new notification toggle should not be a
    migration.
    """

    __tablename__ = "team_settings"

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True)

    #: Units beyond the built-in `ItemUnit` values, e.g. "Roll", "Bundle".
    custom_units: Mapped[list[Any]] = mapped_column(
        JSONBType, server_default=text("'[]'"), default=list, nullable=False
    )
    #: Categories beyond the built-in `ItemCategory` values.
    custom_categories: Mapped[list[Any]] = mapped_column(
        JSONBType, server_default=text("'[]'"), default=list, nullable=False
    )
    #: Which admin notifications are sent. Absent keys mean enabled — a preference
    #: nobody has expressed is not a preference to suppress mail.
    notification_prefs: Mapped[dict[str, Any]] = mapped_column(
        JSONBType, server_default=text("'{}'"), default=dict, nullable=False
    )

    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL")
    )
