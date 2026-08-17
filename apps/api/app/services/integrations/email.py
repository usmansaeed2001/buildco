"""Outbound email via Resend.

Replaces four copy-pasted ``sendEmail`` / ``emailWrap`` pairs from the legacy
functions with one sender and one Jinja2 template inheritance chain.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass

import httpx

from app.config import get_settings
from app.logging import get_logger
from app.services.templates import render_email

log = get_logger(__name__)

RESEND_ENDPOINT = "https://api.resend.com/emails"


@dataclass(frozen=True, slots=True)
class EmailAttachment:
    filename: str
    content: bytes
    content_type: str = "text/calendar"


async def send_email(
    to: str | list[str],
    subject: str,
    html: str,
    *,
    attachments: list[EmailAttachment] | None = None,
) -> bool:
    """Send one message. Returns whether it was actually dispatched.

    Never raises. Email is always sent from a background task after the response has
    been committed, so a failure here must not surface as a request error — it is
    logged and reported through the return value instead.
    """
    settings = get_settings()
    recipients = [to] if isinstance(to, str) else list(to)
    recipients = [r for r in recipients if r]

    if not recipients:
        return False

    if not settings.resend_api_key:
        log.warning(
            "email_skipped_no_api_key",
            subject=subject,
            recipients=len(recipients),
            hint="Set RESEND_API_KEY to enable outbound email.",
        )
        return False

    payload: dict[str, object] = {
        "from": settings.notify_from_email,
        "to": recipients,
        "subject": subject,
        "html": html,
    }

    if attachments:
        payload["attachments"] = [
            {
                "filename": a.filename,
                "content": base64.b64encode(a.content).decode("ascii"),
                "content_type": a.content_type,
            }
            for a in attachments
        ]

    try:
        async with httpx.AsyncClient(timeout=settings.http_timeout_seconds) as client:
            response = await client.post(
                RESEND_ENDPOINT,
                headers={"Authorization": f"Bearer {settings.resend_api_key}"},
                json=payload,
            )
        if response.status_code >= 400:
            log.error(
                "email_send_failed",
                subject=subject,
                status=response.status_code,
                body=response.text[:500],
            )
            return False
    except httpx.HTTPError as exc:
        log.error("email_send_error", subject=subject, error=str(exc))
        return False

    log.info("email_sent", subject=subject, recipients=len(recipients))
    return True


async def send_template_email(
    to: str | list[str],
    subject: str,
    template: str,
    context: dict[str, object] | None = None,
    *,
    attachments: list[EmailAttachment] | None = None,
) -> bool:
    """Render a template under ``templates/email/`` and send it."""
    html = render_email(template, context or {})
    return await send_email(to, subject, html, attachments=attachments)
