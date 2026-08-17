"""Notification fan-out.

Everything outbound goes through here, and everything here is meant to be scheduled on
``BackgroundTasks`` rather than awaited inside a handler. In the legacy backend these
calls ran inline as ``await Promise.all(...)``, so a slow Resend response added its
latency to a user's request and a Resend outage failed a write that had already
committed.

The rule is: commit the database work, then hand the notification to the background.
Nothing in this module raises.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session_factory
from app.logging import get_logger
from app.models.enums import ELEVATED_ROLES, UserStatus
from app.models.profile import Profile
from app.services.integrations import email as email_integration
from app.services.integrations.email import EmailAttachment

log = get_logger(__name__)


async def admin_recipients(
    session: AsyncSession, *, exclude_id: uuid.UUID | None = None
) -> list[str]:
    """Active owners and admins, optionally excluding the person who acted.

    Excluding the actor is right for "someone did something you should know about"
    messages and wrong for "the system changed state" ones — the caller decides.
    """
    stmt = select(Profile.id, Profile.email).where(
        Profile.role.in_([r.value for r in ELEVATED_ROLES]),
        Profile.status == UserStatus.ACTIVE,
    )
    rows = (await session.execute(stmt)).all()
    return [
        email
        for profile_id, email in rows
        if email and (exclude_id is None or profile_id != exclude_id)
    ]


async def notify_admins(
    subject: str,
    template: str,
    context: dict[str, object],
    *,
    exclude_id: uuid.UUID | None = None,
) -> None:
    """Email every active owner and admin.

    Opens its own session. Background tasks run after the request's session has been
    committed and closed, so they cannot borrow it.
    """
    try:
        async with get_session_factory()() as session:
            recipients = await admin_recipients(session, exclude_id=exclude_id)
        if not recipients:
            log.info("notify_admins_no_recipients", subject=subject)
            return
        await email_integration.send_template_email(recipients, subject, template, context)
    except Exception as exc:
        log.error("notify_admins_failed", subject=subject, error=str(exc))


async def notify_many(
    recipients: Sequence[str],
    subject: str,
    template: str,
    context: dict[str, object],
    *,
    attachments: list[EmailAttachment] | None = None,
) -> None:
    """Send the same message to a list of addresses.

    One Resend call with several recipients rather than one per person: the legacy code
    fanned out with ``Promise.all`` and burned a request per recipient.
    """
    addresses = [r for r in recipients if r]
    if not addresses:
        return
    try:
        await email_integration.send_template_email(
            addresses, subject, template, context, attachments=attachments
        )
    except Exception as exc:
        log.error("notify_many_failed", subject=subject, error=str(exc))


async def notify_one(
    recipient: str | None,
    subject: str,
    template: str,
    context: dict[str, object],
    *,
    attachments: list[EmailAttachment] | None = None,
) -> None:
    """Send to a single address, tolerating ``None`` so callers need no guard."""
    if not recipient:
        return
    await notify_many([recipient], subject, template, context, attachments=attachments)
