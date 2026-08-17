"""Attachment schemas — the two-step direct-to-storage upload."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import Field

from app.schemas.common import ORMSchema, Schema


class AttachmentOut(ORMSchema):
    id: uuid.UUID
    estimate_id: uuid.UUID
    room_index: int | None = None
    item_index: int | None = None
    file_name: str
    file_type: str
    storage_path: str
    is_video: bool
    uploaded_by: uuid.UUID | None = None
    created_at: datetime
    #: Freshly-signed download URL. ``None`` when storage is not configured, so the
    #: row still renders with its metadata intact.
    url: str | None = None


class UploadUrlRequest(Schema):
    file_name: str = Field(min_length=1, max_length=500)
    content_type: str = Field(min_length=1, max_length=200)
    room_index: int | None = Field(default=None, ge=0)
    item_index: int | None = Field(default=None, ge=0)


class UploadUrlOut(ORMSchema):
    upload_url: str
    #: Echo this back when creating the attachment record after the PUT succeeds.
    storage_path: str
    #: Headers the browser must send on the PUT for the signature to validate.
    required_headers: dict[str, str]
    expires_in: int


class AttachmentCreate(Schema):
    """Recorded after the browser's direct upload to storage has succeeded."""

    storage_path: str = Field(min_length=1, max_length=1000)
    file_name: str = Field(min_length=1, max_length=500)
    content_type: str = Field(default="", max_length=200)
    room_index: int | None = Field(default=None, ge=0)
    item_index: int | None = Field(default=None, ge=0)
