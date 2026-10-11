"""Estimate endpoints."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Path, Query, status

from app.deps import CurrentUser, DbSession, Elevated
from app.models.enums import EstimateSort, EstimateStatus
from app.models.estimate import Estimate
from app.routers.followups import schedule
from app.schemas.common import Ack, Page
from app.schemas.estimate import (
    EstimateCreate,
    EstimateIdOut,
    EstimateOut,
    EstimateTotalsOut,
    EstimateUpdate,
    SubmitForReviewOut,
    SubmitForReviewRequest,
    TransitionRequest,
)
from app.services import actions, attachment_service, estimate_service
from app.services.rules.estimate_totals import EstimateTotals

router = APIRouter(prefix="/estimates", tags=["estimates"])


def _to_out(estimate: Estimate, totals: EstimateTotals | None = None) -> EstimateOut:
    """Serialise an estimate, attaching its computed totals.

    Totals ride along on every read so no client ever re-derives them — which is how
    the browser and the review email came to disagree in the legacy system.
    """
    computed = totals or estimate_service.totals_for(estimate)
    out = EstimateOut.model_validate(estimate)
    out.totals = EstimateTotalsOut.model_validate(computed)
    return out


@router.get("", response_model=Page[EstimateOut])
async def list_estimates(
    db: DbSession,
    user: CurrentUser,
    trash: Annotated[bool, Query(description="Show soft-deleted estimates instead.")] = False,
    estimate_status: Annotated[EstimateStatus | None, Query(alias="status")] = None,
    q: Annotated[str | None, Query(max_length=200, description="Search text.")] = None,
    created_from: Annotated[datetime | None, Query(description="Created at or after.")] = None,
    created_to: Annotated[datetime | None, Query(description="Created at or before.")] = None,
    sort: Annotated[EstimateSort, Query(description="Ordering.")] = EstimateSort.RECENTLY_CREATED,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Page[EstimateOut]:
    """List estimates, newest first.

    Members see only estimates they created; owners and admins see everything.

    ``created_from`` and ``created_to`` are instants, not dates: only the browser knows
    which zone "the 3rd" means, so it converts before asking.

    ``sort`` defaults to newest-created, which is what this endpoint has always returned.
    Callers who want another order ask for it — see ``EstimateSort``.
    """
    page = await estimate_service.list_estimates(
        db,
        user,
        trash=trash,
        status=estimate_status,
        query=q,
        created_from=created_from,
        created_to=created_to,
        sort=sort,
        limit=limit,
        offset=offset,
    )
    return Page[EstimateOut](
        items=[_to_out(e) for e in page.items],
        total=page.total,
        limit=limit,
        offset=offset,
    )


@router.get("/ids", response_model=list[EstimateIdOut])
async def list_estimate_ids(db: DbSession, user: CurrentUser) -> list[EstimateIdOut]:
    """Every visible estimate as just an id and a status.

    Feeds the unread dots on the list screen's status chips, which have to know what is
    in the statuses you are *not* looking at — so they cannot be derived from the current
    page. Deliberately tiny: two columns, no rooms, no totals, no joins.

    Declared above ``/{estimate_id}`` because FastAPI matches routes in order and
    ``ids`` would otherwise be parsed as a UUID path parameter and 422.
    """
    rows = await estimate_service.list_estimate_ids(db, user)
    return [EstimateIdOut(id=row_id, status=row_status) for row_id, row_status in rows]


@router.post("", response_model=EstimateOut, status_code=status.HTTP_201_CREATED)
async def create_estimate(body: EstimateCreate, db: DbSession, user: CurrentUser) -> EstimateOut:
    """Create an estimate. The claim identifier is assigned by the server."""
    result = await actions.create_estimate(db, user, body)
    return _to_out(result.estimate)


@router.get("/{estimate_id}", response_model=EstimateOut)
async def get_estimate(
    db: DbSession, user: CurrentUser, estimate_id: Annotated[uuid.UUID, Path()]
) -> EstimateOut:
    estimate = await estimate_service.get_estimate(db, user, estimate_id)
    return _to_out(estimate)


@router.patch("/{estimate_id}", response_model=EstimateOut)
async def update_estimate(
    body: EstimateUpdate,
    db: DbSession,
    user: CurrentUser,
    estimate_id: Annotated[uuid.UUID, Path()],
) -> EstimateOut:
    """Update an estimate's contents.

    Status is not reachable from here — use ``POST /estimates/{id}/transitions``, which
    enforces the state machine and its role requirements.
    """
    result = await actions.update_estimate(db, user, estimate_id, body)
    return _to_out(result.estimate)


@router.delete("/{estimate_id}", response_model=EstimateOut)
async def trash_estimate(
    db: DbSession, user: CurrentUser, estimate_id: Annotated[uuid.UUID, Path()]
) -> EstimateOut:
    """Move an estimate to the trash. Recoverable by an owner or admin."""
    estimate = await estimate_service.soft_delete(db, user, estimate_id)
    return _to_out(estimate)


@router.post("/{estimate_id}/restore", response_model=EstimateOut)
async def restore_estimate(
    db: DbSession, actor: Elevated, estimate_id: Annotated[uuid.UUID, Path()]
) -> EstimateOut:
    """Return an estimate from the trash to active."""
    estimate = await estimate_service.restore(db, actor, estimate_id)
    return _to_out(estimate)


@router.delete("/{estimate_id}/permanent", response_model=Ack)
async def permanently_delete_estimate(
    db: DbSession,
    background: BackgroundTasks,
    actor: Elevated,
    estimate_id: Annotated[uuid.UUID, Path()],
) -> Ack:
    """Destroy an estimate and its attachments irrecoverably.

    The database rows go in this request; the storage objects are purged in the
    background, since a slow bucket should not hold the response open.
    """
    orphaned = await estimate_service.permanently_delete(db, actor, estimate_id)
    if orphaned:
        background.add_task(attachment_service.purge_objects, orphaned)
    return Ack()


@router.post("/{estimate_id}/transitions", response_model=EstimateOut)
async def transition_estimate(
    body: TransitionRequest,
    db: DbSession,
    background: BackgroundTasks,
    user: CurrentUser,
    estimate_id: Annotated[uuid.UUID, Path()],
) -> EstimateOut:
    """Move an estimate through its status state machine.

    Actions: ``archive``, ``unarchive``, ``lock``, ``unlock``, ``recall``,
    ``resubmit_ready``, ``admin_approve``. Which roles may perform each, and from which
    statuses, is declared in ``estimate_rules.TRANSITIONS``. An action the role may not
    perform is a 403; one that is not available from the current status is a 409.
    """
    result = await actions.transition_estimate(db, user, estimate_id, body.action)
    schedule(background, result.follow_ups)
    return _to_out(result.estimate)


@router.post("/{estimate_id}/submit", response_model=SubmitForReviewOut)
async def submit_for_review(
    body: SubmitForReviewRequest,
    db: DbSession,
    background: BackgroundTasks,
    user: CurrentUser,
    estimate_id: Annotated[uuid.UUID, Path()],
) -> SubmitForReviewOut:
    """Send an estimate to the configured reviewer for approval.

    The recipient is the single user chosen in Settings, not something the caller
    supplies — see ``SubmitForReviewRequest``. Submitting with no reviewer configured is
    a 409 that names the fix, not a silent success.

    Mints a single-use approval token and emails the reviewer a link to the review
    page. The email and the Slack post both run in the background, so a slow provider
    cannot fail a submission that has already been recorded.
    """
    result = await actions.submit_estimate_for_review(db, user, estimate_id)
    schedule(background, result.follow_ups)
    return SubmitForReviewOut(
        estimate=_to_out(result.submission.estimate, result.totals),
        review_url=result.submission.review_url,
    )
