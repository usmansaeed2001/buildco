"""Meetings and their attendees.

Attendee ``email`` and ``name`` are snapshotted alongside the ``user_id`` FK because
the ICS file and the invite email are addressed to whatever the values were when the
invite went out; re-deriving them later would misrepresent what was actually sent.
"""

from __future__ import annotations

# Runtime import: SQLAlchemy resolves Mapped[...] annotations at class-creation
# time, so uuid cannot hide under TYPE_CHECKING.
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint, Uuid, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKey

if TYPE_CHECKING:
    from app.models.profile import Profile
    from app.models.project import Project


class Meeting(Base, UUIDPrimaryKey, TimestampMixin):
    __tablename__ = "meetings"

    created_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL")
    )
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("projects.id", ondelete="SET NULL"), index=True
    )

    title: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str] = mapped_column(
        Text, server_default=text("''"), default="", nullable=False
    )
    location: Mapped[str] = mapped_column(
        String(500), server_default=text("''"), default="", nullable=False
    )

    start_time: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    end_time: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    #: Hex colour used by the calendar UI.
    color: Mapped[str] = mapped_column(
        String(20), server_default=text("'#3B82F6'"), default="#3B82F6", nullable=False
    )

    meet_link: Mapped[str | None] = mapped_column(String(1000))
    google_event_id: Mapped[str | None] = mapped_column(String(200))

    creator: Mapped[Profile | None] = relationship(
        "Profile", foreign_keys=[created_by], lazy="selectin"
    )
    project: Mapped[Project | None] = relationship("Project", foreign_keys=[project_id])
    attendees: Mapped[list[MeetingAttendee]] = relationship(
        "MeetingAttendee",
        back_populates="meeting",
        cascade="all, delete-orphan",
        passive_deletes=True,
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return f"<Meeting {self.title!r} at {self.start_time}>"


class MeetingAttendee(Base, UUIDPrimaryKey, TimestampMixin):
    __tablename__ = "meeting_attendees"
    __table_args__ = (UniqueConstraint("meeting_id", "user_id", name="uq_meeting_attendee"),)

    meeting_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("meetings.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )

    email: Mapped[str] = mapped_column(String(320), nullable=False)
    name: Mapped[str] = mapped_column(
        String(200), server_default=text("''"), default="", nullable=False
    )

    meeting: Mapped[Meeting] = relationship("Meeting", back_populates="attendees")
    profile: Mapped[Profile | None] = relationship("Profile", lazy="selectin")

    def __repr__(self) -> str:
        return f"<MeetingAttendee {self.email} meeting={self.meeting_id}>"
