"""Attachment endpoints.

Two routers live here: the estimate-scoped collection, and a top-level one for
deleting a single attachment by its own id (which the client already holds, so making
it re-supply the estimate id would be noise).
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Path, status

from app.deps import CurrentUser, DbSession
from app.schemas.attachment import (
    AttachmentCreate,
    AttachmentOut,
    UploadUrlOut,
    UploadUrlRequest,
)
from app.schemas.common import Ack
from app.services import attachment_service
from app.services.integrations import storage

router = APIRouter(prefix="/estimates/{estimate_id}/attachments", tags=["attachments"])
standalone_router = APIRouter(prefix="/attachments", tags=["attachments"])


@router.get("", response_model=list[AttachmentOut])
async def list_attachments(
    db: DbSession, user: CurrentUser, estimate_id: Annotated[uuid.UUID, Path()]
) -> list[AttachmentOut]:
    """Attachments for an estimate, each with a freshly-signed download URL.

    ``url`` is ``null`` when storage is unconfigured; the rest of the row still
    renders, so the UI degrades to a file list rather than an error.
    """
    rows = await attachment_service.list_for_estimate(db, user, estimate_id)
    out: list[AttachmentOut] = []
    for attachment, url in rows:
        item = AttachmentOut.model_validate(attachment)
        item.url = url
        out.append(item)
    return out


@router.post("/upload-url", response_model=UploadUrlOut)
async def create_upload_url(
    body: UploadUrlRequest,
    db: DbSession,
    user: CurrentUser,
    estimate_id: Annotated[uuid.UUID, Path()],
) -> UploadUrlOut:
    """Step 1 of an upload: get a signed URL to PUT the file straight to storage.

    Send the returned ``required_headers`` verbatim on the PUT — the content type is
    part of the signature, and a mismatch is rejected by Cloud Storage.
    """
    signed = await attachment_service.create_upload_url(
        db,
        user,
        estimate_id,
        file_name=body.file_name,
        content_type=body.content_type,
        room_index=body.room_index,
        item_index=body.item_index,
    )
    return UploadUrlOut(
        upload_url=signed.upload_url,
        storage_path=signed.storage_path,
        required_headers=signed.required_headers,
        expires_in=signed.expires_in,
    )


@router.post("", response_model=AttachmentOut, status_code=status.HTTP_201_CREATED)
async def create_attachment(
    body: AttachmentCreate,
    db: DbSession,
    user: CurrentUser,
    estimate_id: Annotated[uuid.UUID, Path()],
) -> AttachmentOut:
    """Step 2 of an upload: record the file once the PUT has succeeded."""
    attachment = await attachment_service.record_attachment(
        db,
        user,
        estimate_id,
        storage_path=body.storage_path,
        file_name=body.file_name,
        content_type=body.content_type,
        room_index=body.room_index,
        item_index=body.item_index,
    )
    out = AttachmentOut.model_validate(attachment)
    out.url = await storage.create_download_url("attachments", attachment.storage_path)
    return out


@standalone_router.delete("/{attachment_id}", response_model=Ack)
async def delete_attachment(
    db: DbSession,
    background: BackgroundTasks,
    user: CurrentUser,
    attachment_id: Annotated[uuid.UUID, Path()],
) -> Ack:
    """Delete an attachment. The stored object is removed in the background."""
    path = await attachment_service.delete_attachment(db, user, attachment_id)
    background.add_task(storage.delete_object, "attachments", path)
    return Ack()
