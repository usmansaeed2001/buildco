"""Staff user profiles.

``profiles.id`` stays the application's internal user id, exactly as it was under
Supabase — every FK in the system (``estimates.created_by``, ``projects.assigned_to``,
``meeting_attendees.user_id``, …) points at it, so it must not change during the
migration.

``firebase_uid`` is the new column that links a profile to its Firebase Auth user. It
is nullable because it is backfilled by email after the user import, and because a
straggler gets matched and backfilled on first login instead.
"""

from __future__ import annotations

# Runtime import: SQLAlchemy resolves Mapped[...] annotations at class-creation
# time, so uuid cannot hide under TYPE_CHECKING.
import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, Text, Uuid, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKey
from app.models.enums import Role, UserStatus, values


class Profile(Base, UUIDPrimaryKey, TimestampMixin):
    __tablename__ = "profiles"
    __table_args__ = (
        CheckConstraint("role in ('" + "','".join(values(Role)) + "')", name="role_valid"),
        CheckConstraint(
            "status in ('" + "','".join(values(UserStatus)) + "')", name="status_valid"
        ),
    )

    firebase_uid: Mapped[str | None] = mapped_column(String(128), unique=True, index=True)
    email: Mapped[str] = mapped_column(String(320), nullable=False, unique=True, index=True)
    full_name: Mapped[str] = mapped_column(
        String(200), server_default=text("''"), default="", nullable=False
    )
    phone: Mapped[str | None] = mapped_column(String(40))
    #: Unbounded: a Google signed photo URL (``a-/ALV-...``) has no documented
    #: length limit and has been seen past 1200 characters.
    avatar_url: Mapped[str | None] = mapped_column(Text)

    role: Mapped[str] = mapped_column(
        String(20), server_default=text("'member'"), default=Role.MEMBER, nullable=False
    )
    status: Mapped[str] = mapped_column(
        String(20), server_default=text("'active'"), default=UserStatus.ACTIVE, nullable=False
    )

    removed_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL")
    )
    removed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # ── Invitation ────────────────────────────────────────────────────────────
    #: Set when an owner or admin added this person before they had an account. Kept
    #: after they join, as the record of how they arrived.
    invited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    invited_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL")
    )
    #: SHA-256 of the token in the invitation email, never the token itself — it is a
    #: credential for a role, so a read of this table must not be enough to use it.
    #: Cleared when the invitation is accepted, which is what makes the link single-use.
    invite_token_hash: Mapped[str | None] = mapped_column(String(64))

    remover: Mapped[Profile | None] = relationship(
        "Profile", remote_side="Profile.id", foreign_keys=[removed_by]
    )

    # ── Convenience ───────────────────────────────────────────────────────────
    @property
    def display_name(self) -> str:
        """What to show in activity logs and emails. Mirrors ``full_name || email``."""
        return self.full_name or self.email

    @property
    def is_elevated(self) -> bool:
        return self.role in (Role.OWNER, Role.ADMIN)

    @property
    def is_banned(self) -> bool:
        return self.status == UserStatus.BANNED

    @property
    def invite_pending(self) -> bool:
        """Invited, and has not signed in yet.

        Keyed on ``invited_at`` rather than on a missing ``firebase_uid`` alone: a user
        migrated from Supabase who has not signed in since also has no uid, and they are
        a long-standing member with history, not an invitation that can be revoked.
        """
        return self.invited_at is not None and self.firebase_uid is None

    def __repr__(self) -> str:
        return f"<Profile {self.email} role={self.role}>"
