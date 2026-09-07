"""Supplement estimates — the core document of the app.

``rooms`` is a JSONB array of ``{name, items: [{name, category, unit, quantity,
unitCost, ...}]}``. It stays denormalised because the editor loads and saves the whole
document at once and nothing queries across line items. The shape is validated by
``app.schemas.estimate.Room`` at the API boundary, so a malformed payload is rejected
on write rather than crashing a later read.
"""

from __future__ import annotations

# Runtime import: SQLAlchemy resolves Mapped[...] annotations at class-creation
# time, so uuid cannot hide under TYPE_CHECKING.
import uuid
from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Numeric, String, Text, Uuid, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, JSONBType, TimestampMixin, UUIDPrimaryKey
from app.models.enums import EstimateStatus, values

if TYPE_CHECKING:
    from app.models.attachment import Attachment
    from app.models.profile import Profile


class Estimate(Base, UUIDPrimaryKey, TimestampMixin):
    __tablename__ = "estimates"
    __table_args__ = (
        CheckConstraint(
            "status in ('" + "','".join(values(EstimateStatus)) + "')",
            name="status_valid",
        ),
    )

    created_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL"), index=True
    )

    #: Blank means unnamed, and the UI says so.
    #:
    #: This used to default to the literal string "New Estimate", which meant an estimate
    #: created without one was not unnamed — it was named the same thing as every other
    #: one, so a list of them was a wall of identical rows with no way to tell them apart.
    project_name: Mapped[str] = mapped_column(
        String(300), server_default=text("''"), default="", nullable=False
    )
    client_name: Mapped[str] = mapped_column(
        String(300), server_default=text("''"), default="", nullable=False
    )
    #: Human-facing claim reference, e.g. ``CLM-482913``. Indexed but **not unique**:
    #: an original estimate and a supplement filed against the same insurance claim
    #: legitimately share one, and plenty of rows carry no claim number at all. See
    #: revision ``c8d5f3a1e207`` for what the live data showed.
    identifier: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    pm_name: Mapped[str] = mapped_column(
        String(200), server_default=text("''"), default="", nullable=False
    )
    insurance_carrier: Mapped[str] = mapped_column(
        String(200), server_default=text("''"), default="", nullable=False
    )

    #: The estimate's grand total, denormalised from ``rooms`` so the database can sort
    #: by it. ``rooms`` is JSONB, so the total is otherwise only knowable in Python, and
    #: sorting a paginated list in the browser sorts one page rather than the list.
    #:
    #: **Not the source of truth for the response.** ``estimate_service.totals_for()``
    #: still recomputes on every read, so if this column ever drifts the number on screen
    #: stays correct and only the sort position is stale. Do not "optimise" the response
    #: to read from here — that trades a wrong ordering for a wrong number.
    total_amount: Mapped[Decimal] = mapped_column(
        Numeric(12, 2), server_default=text("0"), default=Decimal("0"), nullable=False
    )

    rooms: Mapped[list[Any]] = mapped_column(
        JSONBType, server_default=text("'[]'"), default=list, nullable=False
    )
    notes: Mapped[str] = mapped_column(Text, server_default=text("''"), default="", nullable=False)

    status: Mapped[str] = mapped_column(
        String(30),
        server_default=text("'active'"),
        default=EstimateStatus.ACTIVE,
        nullable=False,
        index=True,
    )

    # ── External review workflow ──────────────────────────────────────────────
    #: Single-use secret embedded in the reviewer's email links. Cleared once the
    #: estimate reaches a terminal decision, or when the submitter recalls it.
    approval_token: Mapped[str | None] = mapped_column(String(128), unique=True, index=True)
    submitted_to: Mapped[str | None] = mapped_column(String(320))
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    submitted_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL")
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    #: Free text the reviewer supplied when requesting changes.
    review_note: Mapped[str | None] = mapped_column(Text)

    # ── Soft delete (the "trash" view) ────────────────────────────────────────
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    deleted_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL")
    )

    creator: Mapped[Profile | None] = relationship(
        "Profile", foreign_keys=[created_by], lazy="selectin"
    )
    submitter: Mapped[Profile | None] = relationship("Profile", foreign_keys=[submitted_by])
    attachments: Mapped[list[Attachment]] = relationship(
        "Attachment",
        back_populates="estimate",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    @property
    def is_trashed(self) -> bool:
        return self.deleted_at is not None

    def __repr__(self) -> str:
        return f"<Estimate {self.identifier} status={self.status}>"
