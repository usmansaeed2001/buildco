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
    except Exception as exc:  # "never raises" covers bad URLs, not just transport errors
        log.error("slack_post_error", error=str(exc))
        return False

    log.info("slack_posted")
    return True


#: Static on purpose: the legacy app sent this exact string, and the Zap and anyone
#: pattern-matching the channel see both apps' messages side by side.
ESTIMATE_SUBMITTED_TEXT = "📋 *New Supplement Estimate Submitted for Review*"


def build_estimate_submitted_payload(
    *,
    project_name: str,
    identifier: str,
    client_name: str | None,
    submitted_by: str,
    recipient_email: str,
) -> dict[str, object]:
    """The webhook body, byte-for-byte what ``submit.js`` sends.

    User data is deliberately not mrkdwn-escaped, matching the legacy message.
    """
    return {
        "text": ESTIMATE_SUBMITTED_TEXT,
        "blocks": [
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
    }


async def post_estimate_submitted(
    *,
    project_name: str,
    identifier: str,
    client_name: str | None,
    submitted_by: str,
    recipient_email: str,
) -> bool:
    """The one Slack message the system currently sends."""
    payload = build_estimate_submitted_payload(
        project_name=project_name,
        identifier=identifier,
        client_name=client_name,
        submitted_by=submitted_by,
        recipient_email=recipient_email,
    )
    return await post_message(text=payload["text"], blocks=payload["blocks"])  # type: ignore[arg-type]
