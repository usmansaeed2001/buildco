"""Photos and videos attached to a specific line item of an estimate.

``room_index`` / ``item_index`` position the file inside the estimate's ``rooms`` JSON
document. They are plain integers rather than FKs because line items have no rows of
their own — reordering rooms in the editor is the caller's problem to keep consistent,
exactly as it was in the legacy implementation.
"""

from __future__ import annotations

# Runtime import: SQLAlchemy resolves Mapped[...] annotations at class-creation
# time, so uuid cannot hide under TYPE_CHECKING.
import uuid
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, ForeignKey, Integer, String, Uuid, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKey

if TYPE_CHECKING:
    from app.models.estimate import Estimate


class Attachment(Base, UUIDPrimaryKey, TimestampMixin):
    __tablename__ = "attachments"

    estimate_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("estimates.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    room_index: Mapped[int] = mapped_column(
        Integer, server_default=text("0"), default=0, nullable=False
    )
    item_index: Mapped[int] = mapped_column(
        Integer, server_default=text("0"), default=0, nullable=False
    )

    file_name: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    file_type: Mapped[str] = mapped_column(String(200), default="", nullable=False)
    #: Object key within the attachments bucket. The legacy path scheme is preserved
    #: verbatim — ``{estimate_id}/{room_index}_{item_index}_{epoch_ms}.{ext}`` — so
    #: objects copied over from Supabase Storage stay addressable.
    storage_path: Mapped[str] = mapped_column(String(1000), nullable=False)
    is_video: Mapped[bool] = mapped_column(
        Boolean, server_default=text("false"), default=False, nullable=False
    )

    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL")
    )

    estimate: Mapped[Estimate] = relationship("Estimate", back_populates="attachments")

    def __repr__(self) -> str:
        return f"<Attachment {self.file_name} estimate={self.estimate_id}>"
