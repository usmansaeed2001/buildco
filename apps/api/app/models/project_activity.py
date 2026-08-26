"""Append-only audit trail for a project.

``user_name`` is denormalised on purpose: the log should still read correctly after a
profile is renamed or deleted, so it captures who the actor was *at the time*.
"""

from __future__ import annotations

# Runtime import: SQLAlchemy resolves Mapped[...] annotations at class-creation
# time, so uuid cannot hide under TYPE_CHECKING.
import uuid
from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, String, Text, Uuid, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKey

if TYPE_CHECKING:
    from app.models.project import Project


class ProjectActivity(Base, UUIDPrimaryKey, TimestampMixin):
    __tablename__ = "project_activity"

    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL")
    )
    #: Snapshot of the actor's display name at the time of the action.
    user_name: Mapped[str] = mapped_column(
        String(200), server_default=text("''"), default="", nullable=False
    )

    action: Mapped[str] = mapped_column(String(200), nullable=False)
    details: Mapped[str] = mapped_column(
        Text, server_default=text("''"), default="", nullable=False
    )

    project: Mapped[Project] = relationship("Project", back_populates="activity")

    def __repr__(self) -> str:
        return f"<ProjectActivity {self.action!r} project={self.project_id}>"
