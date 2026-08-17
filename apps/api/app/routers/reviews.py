"""Public estimate-review endpoints. **No authentication — the token is the credential.**

Two things differ from the legacy ``submit.js`` these replace:

* They return JSON. The old handlers built HTML pages by string concatenation,
  including one with an inline ``<script>`` that POSTed back to itself. The reviewer
  page is now a real frontend route that calls these.
* Approve and reject are POST. As GET links they mutated state on any prefetch, so an
  email client or security scanner that followed the URL approved the estimate on the
  reviewer's behalf.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Path

from app.deps import DbSession
from app.models.estimate import Estimate
from app.schemas.review import (
    RequestChangesRequest,
    ReviewDecisionOut,
    ReviewEstimateOut,
    ReviewLineItem,
    ReviewRoom,
)
from app.services import notifications, review_service
from app.services.rules.estimate_totals import EstimateTotals, line_total

router = APIRouter(prefix="/public/reviews", tags=["public review"])

TokenPath = Annotated[
    str, Path(max_length=128, description="Approval token from the emailed link.")
]


def _build_rooms(estimate: Estimate, totals: EstimateTotals) -> list[ReviewRoom]:
    rooms: list[ReviewRoom] = []
    for index, raw_room in enumerate(estimate.rooms or []):
        if not isinstance(raw_room, dict):
            continue
        items: list[ReviewLineItem] = []
        for raw_item in raw_room.get("items") or []:
            if not isinstance(raw_item, dict):
                continue
            quantity = raw_item.get("quantity", 0)
            unit_cost = raw_item.get("unitCost", raw_item.get("unit_cost", 0))
            items.append(
                ReviewLineItem(
                    name=str(raw_item.get("name", "")),
                    category=str(raw_item.get("category", "")),
                    unit=str(raw_item.get("unit", "")),
                    quantity=quantity,
                    unit_cost=unit_cost,
                    total=line_total(quantity, unit_cost),
                    notes=str(raw_item.get("notes", "")),
                )
            )
        rooms.append(
            ReviewRoom(
                name=str(raw_room.get("name", "Untitled room")),
                total=totals.rooms[index].total if index < len(totals.rooms) else 0,
                items=items,
            )
        )
    return rooms


@router.get("/{token}", response_model=ReviewEstimateOut)
async def get_review(db: DbSession, token: TokenPath) -> ReviewEstimateOut:
    """Fetch the estimate behind a review link. **Public.**

    Returns 404 for a token that was never valid and 410 for one whose estimate has
    already been decided, so the page can tell "this link is wrong" apart from "you
    already answered this".
    """
    context = await review_service.load_by_token(db, token)
    estimate = context.estimate
    totals = context.totals

    from app.models.enums import EstimateStatus
    from app.services.rules import estimate_rules

    return ReviewEstimateOut(
        project_name=estimate.project_name,
        identifier=estimate.identifier,
        client_name=estimate.client_name,
        insurance_carrier=estimate.insurance_carrier,
        pm_name=estimate.pm_name,
        submitted_by=context.submitter.display_name if context.submitter else "",
        submitted_at=estimate.submitted_at,
        status=EstimateStatus(estimate.status),
        rooms=_build_rooms(estimate, totals),
        total=totals.total,
        room_count=totals.room_count,
        item_count=totals.item_count,
        decision_pending=(
            EstimateStatus(estimate.status) not in estimate_rules.TERMINAL_REVIEW_STATUSES
        ),
        review_note=estimate.review_note,
    )


@router.post("/{token}/approve", response_model=ReviewDecisionOut)
async def approve(
    db: DbSession, background: BackgroundTasks, token: TokenPath
) -> ReviewDecisionOut:
    """Approve the estimate. **Public.** The link is spent afterwards."""
    return await _record(db, background, token, approve=True)


@router.post("/{token}/reject", response_model=ReviewDecisionOut)
async def reject(db: DbSession, background: BackgroundTasks, token: TokenPath) -> ReviewDecisionOut:
    """Reject the estimate. **Public.** The link is spent afterwards."""
    return await _record(db, background, token, approve=False)


async def _record(
    db: DbSession, background: BackgroundTasks, token: str, *, approve: bool
) -> ReviewDecisionOut:
    result = await review_service.record_decision(db, token, approve=approve)
    estimate = result.estimate
    verb = "approved" if approve else "rejected"
    icon = "✅" if approve else "❌"

    context = {
        "badge": f"Estimate {verb}",
        "tone": "green" if approve else "red",
        "headline": estimate.project_name,
        "body": f"The reviewer has {verb} this estimate.",
        "rows": [
            ("Claim ID", estimate.identifier),
            ("Reviewed by", estimate.submitted_to or "—"),
            ("Reviewed at", result.reviewed_at.strftime("%d %b %Y, %H:%M UTC")),
        ],
    }
    subject = f"{icon} {verb.title()} — {estimate.project_name} ({estimate.identifier})"

    background.add_task(notifications.notify_admins, subject, "notice.html", dict(context))
    if result.submitter is not None:
        background.add_task(
            notifications.notify_one,
            result.submitter.email,
            subject,
            "notice.html",
            dict(context),
        )

    return ReviewDecisionOut(
        status=result.status,
        project_name=estimate.project_name,
        identifier=estimate.identifier,
        reviewed_at=result.reviewed_at,
        message=f"Thank you. This estimate has been {verb} and the team has been notified.",
    )


@router.post("/{token}/request-changes", response_model=ReviewDecisionOut)
async def request_changes(
    body: RequestChangesRequest,
    db: DbSession,
    background: BackgroundTasks,
    token: TokenPath,
) -> ReviewDecisionOut:
    """Ask the submitter for changes before approving. **Public.**

    The link stays live, unlike approve and reject: the submitter is expected to revise
    the estimate and the reviewer returns to the same URL to see the update.
    """
    result = await review_service.request_changes(db, token, body.notes)
    estimate = result.estimate

    if result.submitter is not None:
        background.add_task(
            notifications.notify_one,
            result.submitter.email,
            f"✎ Changes requested — {estimate.project_name} ({estimate.identifier})",
            "notice.html",
            {
                "badge": "Changes Requested",
                "tone": "amber",
                "headline": estimate.project_name,
                "body": (
                    "The reviewer has requested changes before this estimate can be approved."
                ),
                "callout_title": "Requested changes",
                "callout_body": body.notes,
                "rows": [
                    ("Claim ID", estimate.identifier),
                    ("Sent to", estimate.submitted_to or "—"),
                ],
                "footer_note": (
                    "Make the requested changes, then resubmit the estimate for approval."
                ),
            },
        )

    return ReviewDecisionOut(
        status=result.status,
        project_name=estimate.project_name,
        identifier=estimate.identifier,
        reviewed_at=result.reviewed_at,
        message="Thank you. Your notes have been sent to the submitter.",
    )
