"""Join table linking a project to the supplement estimates raised against it."""

from __future__ import annotations

# Runtime import: SQLAlchemy resolves Mapped[...] annotations at class-creation
# time, so uuid cannot hide under TYPE_CHECKING.
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, UniqueConstraint, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, UUIDPrimaryKey, utcnow

if TYPE_CHECKING:
    from app.models.estimate import Estimate
    from app.models.project import Project


class ProjectSupplement(Base, UUIDPrimaryKey):
    __tablename__ = "project_supplements"
    __table_args__ = (
        # The legacy code had no such constraint and would happily insert the same
        # link twice. Linking an estimate to a project is idempotent by nature, so
        # the database now enforces it.
        UniqueConstraint("project_id", "estimate_id", name="uq_project_supplement"),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    estimate_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("estimates.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    linked_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL")
    )
    #: Named ``linked_at`` rather than inheriting ``TimestampMixin.created_at``,
    #: because that is the column name the live database uses. A link row is also
    #: never updated — it is created and deleted — so there is no ``updated_at``.
    linked_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), default=utcnow, nullable=False
    )

    project: Mapped[Project] = relationship("Project", back_populates="supplements")
    estimate: Mapped[Estimate] = relationship("Estimate", lazy="selectin")

    def __repr__(self) -> str:
        return f"<ProjectSupplement project={self.project_id} estimate={self.estimate_id}>"
