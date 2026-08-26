"""Projects — a signed job, tracked from contract through to closure.

Two independent status axes, both preserved from the legacy implementation:

* ``work_status`` — where the physical work stands (contract sent → … → completed).
* ``status`` — where the engagement stands (active / pending_payment / closed).

They interact through the rules engine in ``app.services.rules.project_rules``: work
reaching ``completed`` plus fully-paid milestones is what closes a project. Nothing
outside that module is allowed to decide ``status``.
"""

from __future__ import annotations

# Runtime import: SQLAlchemy resolves Mapped[...] annotations at class-creation
# time, so uuid cannot hide under TYPE_CHECKING.
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Numeric,
    String,
    Text,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, JSONBType, TimestampMixin, UUIDPrimaryKey
from app.models.enums import ProjectStatus, WorkStatus, values

if TYPE_CHECKING:
    from app.models.milestone import PaymentMilestone
    from app.models.profile import Profile
    from app.models.project_activity import ProjectActivity
    from app.models.project_supplement import ProjectSupplement

_MONEY = Numeric(12, 2)


class Project(Base, UUIDPrimaryKey, TimestampMixin):
    __tablename__ = "projects"
    __table_args__ = (
        CheckConstraint(
            "work_status in ('" + "','".join(values(WorkStatus)) + "')",
            name="work_status_valid",
        ),
        CheckConstraint(
            "status in ('" + "','".join(values(ProjectStatus)) + "')",
            name="status_valid",
        ),
    )

    created_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL")
    )
    assigned_to: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL"), index=True
    )

    owner_name: Mapped[str] = mapped_column(
        String(300), server_default=text("''"), default="", nullable=False
    )
    address: Mapped[str] = mapped_column(
        String(500), server_default=text("''"), default="", nullable=False
    )
    work_type: Mapped[str] = mapped_column(
        String(200), server_default=text("''"), default="", nullable=False
    )
    start_date: Mapped[date | None] = mapped_column(Date)
    notes: Mapped[str] = mapped_column(Text, server_default=text("''"), default="", nullable=False)

    work_status: Mapped[str] = mapped_column(
        String(30),
        server_default=text("'contract_sent'"),
        default=WorkStatus.CONTRACT_SENT,
        nullable=False,
        index=True,
    )
    status: Mapped[str] = mapped_column(
        String(30),
        server_default=text("'active'"),
        default=ProjectStatus.ACTIVE,
        nullable=False,
        index=True,
    )

    # ── Money ─────────────────────────────────────────────────────────────────
    # Numeric, never float: these are dollars and they get summed.
    total_budget: Mapped[Decimal] = mapped_column(
        _MONEY, server_default=text("0"), default=Decimal("0"), nullable=False
    )
    labor_cost: Mapped[Decimal] = mapped_column(
        _MONEY, server_default=text("0"), default=Decimal("0"), nullable=False
    )
    materials_cost: Mapped[Decimal] = mapped_column(
        _MONEY, server_default=text("0"), default=Decimal("0"), nullable=False
    )
    reimbursements: Mapped[Decimal] = mapped_column(
        _MONEY, server_default=text("0"), default=Decimal("0"), nullable=False
    )
    amount_collected: Mapped[Decimal] = mapped_column(
        _MONEY, server_default=text("0"), default=Decimal("0"), nullable=False
    )

    # ── Closing forms ─────────────────────────────────────────────────────────
    #: Form 1 is the Material Sign-Off, form 2 the Project Sign-Off. Both present is
    #: what drives ``work_status`` to completed.
    closing_form_1: Mapped[dict[str, Any] | None] = mapped_column(JSONBType)
    closing_form_2: Mapped[dict[str, Any] | None] = mapped_column(JSONBType)
    closing_form_submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closing_form_submitted_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL")
    )

    creator: Mapped[Profile | None] = relationship(
        "Profile", foreign_keys=[created_by], lazy="selectin"
    )
    assignee: Mapped[Profile | None] = relationship(
        "Profile", foreign_keys=[assigned_to], lazy="selectin"
    )
    milestones: Mapped[list[PaymentMilestone]] = relationship(
        "PaymentMilestone",
        back_populates="project",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="PaymentMilestone.created_at",
    )
    supplements: Mapped[list[ProjectSupplement]] = relationship(
        "ProjectSupplement",
        back_populates="project",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    activity: Mapped[list[ProjectActivity]] = relationship(
        "ProjectActivity",
        back_populates="project",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="ProjectActivity.created_at.desc()",
    )

    @property
    def profit(self) -> Decimal:
        """Collected minus what the job cost. Derived, never stored."""
        return self.amount_collected - (self.labor_cost + self.materials_cost + self.reimbursements)

    def __repr__(self) -> str:
        return f"<Project {self.owner_name} work={self.work_status} status={self.status}>"
