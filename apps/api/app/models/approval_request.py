"""Re-approval requests filed when a removed (banned) user tries to sign in.

The user is blocked at the auth dependency, but the attempt itself is recorded here so
an owner or admin can restore access without the user having to reach them out of band.
"""

from __future__ import annotations

# Runtime import: SQLAlchemy resolves Mapped[...] annotations at class-creation
# time, so uuid cannot hide under TYPE_CHECKING.
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, Uuid, func, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKey, utcnow
from app.models.enums import ApprovalRequestStatus, values

if TYPE_CHECKING:
    from app.models.profile import Profile


class ApprovalRequest(Base, UUIDPrimaryKey, TimestampMixin):
    __tablename__ = "approval_requests"
    __table_args__ = (
        CheckConstraint(
            "status in ('" + "','".join(values(ApprovalRequestStatus)) + "')",
            name="status_valid",
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    #: Snapshotted so the request is still readable if the profile is later purged.
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    full_name: Mapped[str] = mapped_column(
        String(200), server_default=text("''"), default="", nullable=False
    )

    status: Mapped[str] = mapped_column(
        String(20),
        server_default=text("'pending'"),
        default=ApprovalRequestStatus.PENDING,
        nullable=False,
        index=True,
    )
    requested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        default=utcnow,
        nullable=False,
        index=True,
    )
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL")
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user: Mapped[Profile] = relationship("Profile", foreign_keys=[user_id], lazy="selectin")
    reviewer: Mapped[Profile | None] = relationship("Profile", foreign_keys=[reviewed_by])

    def __repr__(self) -> str:
        return f"<ApprovalRequest {self.email} status={self.status}>"
