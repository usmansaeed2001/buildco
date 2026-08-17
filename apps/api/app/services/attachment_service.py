"""Estimate attachments and the two-step direct-to-storage upload.

The flow is:

1. Client asks for an upload URL. The API mints a V4 signed PUT and returns the object
   key it signed for.
2. Client PUTs the bytes straight to Cloud Storage. Nothing passes through the API.
3. Client posts the key back, and the API records the row.

Step 3 being separate is what makes an interrupted upload harmless: no row is written,
and the orphaned object costs a few cents until a lifecycle rule reaps it.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import Forbidden, NotFound
from app.logging import get_logger
from app.models.attachment import Attachment
from app.models.estimate import Estimate
from app.models.profile import Profile
from app.services import estimate_service
from app.services.integrations import storage
from app.services.integrations.storage import SignedUpload
from app.services.rules import estimate_rules

log = get_logger(__name__)

VIDEO_PREFIX = "video/"


async def list_for_estimate(
    session: AsyncSession, user: Profile, estimate_id: uuid.UUID
) -> list[tuple[Attachment, str | None]]:
    """Attachments for an estimate, each paired with a freshly-signed download URL.

    The URL is minted per read rather than stored, so its lifetime is bounded by the
    configured TTL and revoking bucket access takes effect immediately.
    """
    await estimate_service.get_estimate(session, user, estimate_id)

    rows = list(
        await session.scalars(
            select(Attachment)
            .where(Attachment.estimate_id == estimate_id)
            .order_by(Attachment.created_at)
        )
    )

    return [
        (row, await storage.create_download_url("attachments", row.storage_path)) for row in rows
    ]


async def create_upload_url(
    session: AsyncSession,
    user: Profile,
    estimate_id: uuid.UUID,
    *,
    file_name: str,
    content_type: str,
    room_index: int | None,
    item_index: int | None,
) -> SignedUpload:
    """Mint a signed PUT URL for a new attachment.

    Requires edit permission on the estimate, not merely read: adding a photo to
    someone else's locked estimate would be a write to a document they have frozen.
    """
    estimate = await estimate_service.get_estimate(session, user, estimate_id)
    if not estimate_rules.can_edit(
        estimate_service.actor_of(user), estimate_service.snapshot_of(estimate)
    ):
        raise Forbidden("You cannot add attachments to this estimate.")

    path = storage.attachment_path(str(estimate_id), room_index, item_index, file_name)
    return await storage.create_upload_url("attachments", path, content_type)


async def record_attachment(
    session: AsyncSession,
    user: Profile,
    estimate_id: uuid.UUID,
    *,
    storage_path: str,
    file_name: str,
    content_type: str,
    room_index: int | None,
    item_index: int | None,
) -> Attachment:
    """Record an attachment after its upload has completed.

    The path is validated to sit under this estimate's prefix. Without that check a
    caller could claim any object in the bucket — including one belonging to an
    estimate they cannot read — simply by posting its key.
    """
    estimate = await estimate_service.get_estimate(session, user, estimate_id)
    if not estimate_rules.can_edit(
        estimate_service.actor_of(user), estimate_service.snapshot_of(estimate)
    ):
        raise Forbidden("You cannot add attachments to this estimate.")

    expected_prefix = f"{estimate_id}/"
    if not storage_path.startswith(expected_prefix) or ".." in storage_path:
        raise Forbidden("That storage path does not belong to this estimate.")

    attachment = Attachment(
        estimate_id=estimate.id,
        room_index=room_index,
        item_index=item_index,
        file_name=file_name,
        file_type=content_type,
        storage_path=storage_path,
        is_video=content_type.startswith(VIDEO_PREFIX),
        uploaded_by=user.id,
    )
    session.add(attachment)
    await session.flush()

    log.info(
        "attachment_recorded",
        attachment_id=str(attachment.id),
        estimate_id=str(estimate_id),
    )
    return attachment


async def delete_attachment(session: AsyncSession, user: Profile, attachment_id: uuid.UUID) -> str:
    """Delete an attachment row and return its storage path for background cleanup.

    The row goes first. If the object deletion then fails, the result is an orphaned
    blob rather than a database row pointing at nothing — the harmless direction to
    fail in.
    """
    attachment = await session.get(Attachment, attachment_id)
    if attachment is None:
        raise NotFound("Attachment not found.")

    estimate = await session.get(Estimate, attachment.estimate_id)
    if estimate is None:
        raise NotFound("Attachment not found.")

    if not estimate_rules.can_edit(
        estimate_service.actor_of(user), estimate_service.snapshot_of(estimate)
    ):
        raise Forbidden("You cannot remove attachments from this estimate.")

    path = attachment.storage_path
    await session.delete(attachment)
    await session.flush()
    log.info("attachment_deleted", attachment_id=str(attachment_id))
    return path


async def purge_objects(paths: list[str]) -> None:
    """Delete storage objects. For background use after a permanent delete."""
    for path in paths:
        await storage.delete_object("attachments", path)
