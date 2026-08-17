"""Slack notifications via an incoming webhook.

Unchanged in substance from ``submit.js`` — a single POST of Block Kit JSON. The
webhook feeds a Zapier automation on the other side, so the block structure is part of
the contract with that workflow and should not be reshaped casually.
"""

from __future__ import annotations

import httpx

from app.config import get_settings
from app.logging import get_logger

log = get_logger(__name__)


async def post_message(text: str, blocks: list[dict[str, object]] | None = None) -> bool:
    """Post to the configured webhook. Never raises.

    ``text`` is the notification fallback shown in the sidebar and on mobile; it is
    required even when blocks are supplied.
    """
    settings = get_settings()
    if not settings.slack_webhook_url:
        log.info("slack_skipped_no_webhook", text=text[:120])
        return False

    payload: dict[str, object] = {"text": text}
    if blocks:
        payload["blocks"] = blocks

    try:
        async with httpx.AsyncClient(timeout=settings.http_timeout_seconds) as client:
            response = await client.post(settings.slack_webhook_url, json=payload)
        if response.status_code >= 400:
            log.error("slack_post_failed", status=response.status_code, body=response.text[:300])
            return False
    except httpx.HTTPError as exc:
        log.error("slack_post_error", error=str(exc))
        return False

    log.info("slack_posted")
    return True


async def post_estimate_submitted(
    *,
    project_name: str,
    identifier: str,
    client_name: str,
    submitted_by: str,
    recipient_email: str,
) -> bool:
    """The one Slack message the system currently sends."""
    return await post_message(
        text=f"📋 New supplement estimate submitted for review: {project_name}",
        blocks=[
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": (
                        f"📋 *{project_name}* has been submitted for approval.\n"
                        f"*Claim ID:* {identifier}\n"
                        f"*Client:* {client_name or '—'}\n"
                        f"*Submitted by:* {submitted_by}\n"
                        f"*Sent to:* {recipient_email}"
                    ),
                },
            }
        ],
    )
