"""The public, token-authenticated estimate review flow.

Everything here is reachable without a signed-in user, which shapes the whole module:

* The approval token *is* the credential. It is compared in constant time, cleared once
  a terminal decision is recorded, and never returned in any staff-facing response.
* Responses expose only what the reviewer needs — no user ids, no author, no other
  estimates.
* Approve and reject are POST, not GET. In the legacy implementation they were links
  that mutated state on GET, so any email client or security scanner that prefetched
  the URL silently approved the estimate.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import Gone, NotFound
from app.logging import get_logger
from app.models.enums import EstimateStatus
from app.models.estimate import Estimate
from app.models.profile import Profile
from app.services.rules import estimate_rules
from app.services.rules.estimate_totals import EstimateTotals, compute

log = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class ReviewContext:
    estimate: Estimate
    totals: EstimateTotals
    submitter: Profile | None


async def load_by_token(session: AsyncSession, token: str) -> ReviewContext:
    """Resolve an approval token to its estimate.

    A token that does not match anything yields 404; one whose estimate has already
    been decided yields 410 Gone, which lets the reviewer's page distinguish "this
    link was never valid" from "you already answered this" without a second call.
    """
    if not token or len(token) > 128:
        raise NotFound("This review link is not valid.")

    # Fetch candidates by exact match, then re-compare in constant time. Postgres
    # comparison on an indexed column is not timing-safe, but the index is what makes
    # the lookup practical; the second check is what makes a byte-by-byte oracle
    # useless.
    estimate = await session.scalar(
        select(Estimate).where(Estimate.approval_token == token, Estimate.deleted_at.is_(None))
    )
    if estimate is None or not secrets.compare_digest(estimate.approval_token or "", token):
        raise NotFound("This review link is not valid or has expired.")

    submitter = await session.get(Profile, estimate.submitted_by) if estimate.submitted_by else None
    return ReviewContext(estimate=estimate, totals=compute(estimate.rooms), submitter=submitter)


def _assert_pending(estimate: Estimate) -> None:
    if EstimateStatus(estimate.status) in estimate_rules.TERMINAL_REVIEW_STATUSES:
        raise Gone(
            f"This estimate has already been {estimate.status}. The link is no longer active."
        )


@dataclass(frozen=True, slots=True)
class DecisionResult:
    estimate: Estimate
    submitter: Profile | None
    status: EstimateStatus
    reviewed_at: datetime


async def record_decision(session: AsyncSession, token: str, *, approve: bool) -> DecisionResult:
    """Record the reviewer's approval or rejection.

    The token is cleared on the way out. A decision is final from the reviewer's side;
    reopening requires a staff member to recall or resubmit the estimate, which mints
    a fresh token.
    """
    context = await load_by_token(session, token)
    estimate = context.estimate
    _assert_pending(estimate)

    status = EstimateStatus.APPROVED if approve else EstimateStatus.REJECTED
    reviewed_at = datetime.now(UTC)

    estimate.status = status.value
    estimate.reviewed_at = reviewed_at
    estimate.approval_token = None
    await session.flush()

    log.info(
        "review_decision_recorded",
        estimate_id=str(estimate.id),
        status=status.value,
    )
    return DecisionResult(
        estimate=estimate,
        submitter=context.submitter,
        status=status,
        reviewed_at=reviewed_at,
    )


async def request_changes(session: AsyncSession, token: str, notes: str) -> DecisionResult:
    """Record a request for changes, with the reviewer's notes.

    Unlike approve and reject, this leaves the token intact. The submitter is expected
    to fix the estimate and resubmit, and the reviewer will follow the same link back
    to the updated document — invalidating it here would strand them.
    """
    context = await load_by_token(session, token)
    estimate = context.estimate
    _assert_pending(estimate)

    reviewed_at = datetime.now(UTC)
    estimate.status = EstimateStatus.CHANGES_REQUESTED.value
    estimate.review_note = notes
    estimate.reviewed_at = reviewed_at
    await session.flush()

    log.info("review_changes_requested", estimate_id=str(estimate.id))
    return DecisionResult(
        estimate=estimate,
        submitter=context.submitter,
        status=EstimateStatus.CHANGES_REQUESTED,
        reviewed_at=reviewed_at,
    )
