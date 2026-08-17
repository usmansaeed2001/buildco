"""Estimate lifecycle: create, edit, trash, transition, and submit for review."""

from __future__ import annotations

import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import ColumnElement, Select, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.errors import Conflict, Forbidden, NotFound
from app.logging import get_logger
from app.models.enums import ELEVATED_ROLES, EstimateStatus, Role
from app.models.estimate import Estimate
from app.models.profile import Profile
from app.services.rules import estimate_rules, estimate_totals
from app.services.rules.estimate_rules import (
    ActorSnapshot,
    EstimateSnapshot,
    Transition,
    TransitionNotPermitted,
    UnknownTransition,
)

log = get_logger(__name__)


def actor_of(profile: Profile) -> ActorSnapshot:
    return ActorSnapshot(id=profile.id, role=Role(profile.role))


def snapshot_of(estimate: Estimate) -> EstimateSnapshot:
    return EstimateSnapshot(
        status=EstimateStatus(estimate.status),
        created_by=estimate.created_by,
        is_trashed=estimate.is_trashed,
    )


def generate_identifier() -> str:
    """A human-quotable claim reference, e.g. ``CLM-482913``.

    Uses ``secrets`` rather than ``Math.random()``: the identifier appears in reviewer
    correspondence, and a predictable sequence would let an outsider guess at volume.
    Collisions are handled by the unique constraint and a retry in ``create``.
    """
    return f"CLM-{secrets.randbelow(900_000) + 100_000}"


def generate_approval_token() -> str:
    """The secret embedded in a reviewer's approve/reject links.

    The legacy implementation concatenated two ``Math.random().toString(36)`` slices
    with a timestamp — roughly 40 bits of guessable entropy protecting the ability to
    approve a construction estimate. This is 256 bits from the system CSPRNG.
    """
    return secrets.token_urlsafe(32)


# ── Reads ─────────────────────────────────────────────────────────────────────


def _visible_to(stmt: Select[Any], user: Profile) -> Select[Any]:
    """Restrict a query to what this user may see.

    Members see only estimates they created. The legacy ``GET /estimates`` applied no
    filter at all and returned every estimate in the business to any signed-in user;
    this is the fix.
    """
    if Role(user.role) in ELEVATED_ROLES:
        return stmt
    return stmt.where(Estimate.created_by == user.id)


@dataclass(frozen=True, slots=True)
class EstimatePage:
    items: list[Estimate]
    total: int


async def list_estimates(
    session: AsyncSession,
    user: Profile,
    *,
    trash: bool = False,
    status: EstimateStatus | None = None,
    query: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> EstimatePage:
    """List estimates, newest first.

    ``trash=True`` shows only soft-deleted rows; otherwise they are excluded. The two
    views never mix, which is what keeps a deleted estimate from reappearing in a
    filtered search.
    """
    conditions: list[ColumnElement[bool]] = [
        Estimate.deleted_at.is_not(None) if trash else Estimate.deleted_at.is_(None)
    ]
    if status is not None:
        conditions.append(Estimate.status == status.value)
    if query:
        like = f"%{query.strip()}%"
        conditions.append(
            or_(
                Estimate.project_name.ilike(like),
                Estimate.client_name.ilike(like),
                Estimate.identifier.ilike(like),
                Estimate.insurance_carrier.ilike(like),
            )
        )

    base = select(Estimate).where(*conditions)
    base = _visible_to(base, user)

    total = await session.scalar(
        _visible_to(select(func.count()).select_from(Estimate).where(*conditions), user)
    )

    rows = await session.scalars(
        base.order_by(Estimate.created_at.desc()).limit(limit).offset(offset)
    )
    return EstimatePage(items=list(rows), total=total or 0)


async def get_estimate(session: AsyncSession, user: Profile, estimate_id: uuid.UUID) -> Estimate:
    """Fetch one estimate the user is allowed to see.

    A member requesting someone else's estimate gets 404, not 403 — the existence of
    another team member's work is itself not theirs to learn.
    """
    estimate = await session.get(Estimate, estimate_id)
    if estimate is None:
        raise NotFound("Estimate not found.")
    if not estimate_rules.can_view(actor_of(user), snapshot_of(estimate)):
        raise NotFound("Estimate not found.")
    return estimate


# ── Writes ────────────────────────────────────────────────────────────────────


async def create_estimate(session: AsyncSession, user: Profile, data: dict[str, Any]) -> Estimate:
    """Create an estimate owned by the caller.

    The identifier is random and only six digits wide, so a collision — while
    unlikely — is not impossible once a few thousand estimates exist. Each attempt
    runs inside a SAVEPOINT so a unique violation rolls back only the failed INSERT,
    leaving the surrounding request transaction intact for the retry.
    """
    for attempt in range(5):
        savepoint = await session.begin_nested()
        estimate = Estimate(
            created_by=user.id,
            # Assigned directly rather than left to the selectin loader: eager
            # loaders populate on a *query*, and a freshly flushed object has not
            # been queried. Without this, serialising the response would trigger a
            # lazy load from async context and raise MissingGreenlet.
            creator=user,
            identifier=generate_identifier(),
            status=EstimateStatus.ACTIVE.value,
            **data,
        )
        session.add(estimate)
        try:
            await session.flush()
        except IntegrityError:
            await savepoint.rollback()
            if attempt == 4:
                raise Conflict(
                    "Could not allocate a unique estimate identifier. Please retry."
                ) from None
            continue

        log.info("estimate_created", estimate_id=str(estimate.id), by=str(user.id))
        return estimate

    raise Conflict("Could not allocate a unique estimate identifier.")


async def update_estimate(
    session: AsyncSession, user: Profile, estimate_id: uuid.UUID, changes: dict[str, Any]
) -> Estimate:
    """Apply a partial update to an estimate's contents.

    Status is not reachable from here — see ``EstimateUpdate``, which has no such
    field, and ``apply_transition`` below.
    """
    estimate = await get_estimate(session, user, estimate_id)

    if estimate.is_trashed:
        raise Conflict("This estimate is in the trash. Restore it before editing.")

    if not estimate_rules.can_edit(actor_of(user), snapshot_of(estimate)):
        if estimate.status == EstimateStatus.LOCKED.value:
            raise Forbidden("This estimate is locked. Only the owner can edit it.")
        raise Forbidden("You can only edit estimates you created.")

    for field, value in changes.items():
        setattr(estimate, field, value)
    await session.flush()
    return estimate


async def soft_delete(session: AsyncSession, user: Profile, estimate_id: uuid.UUID) -> Estimate:
    """Move an estimate to the trash. Recoverable by an owner or admin."""
    estimate = await get_estimate(session, user, estimate_id)
    if not estimate_rules.can_soft_delete(actor_of(user), snapshot_of(estimate)):
        raise Forbidden("You can only delete estimates you created.")
    if estimate.is_trashed:
        return estimate

    estimate.deleted_at = datetime.now(UTC)
    estimate.deleted_by = user.id
    await session.flush()
    log.info("estimate_trashed", estimate_id=str(estimate.id), by=str(user.id))
    return estimate


async def restore(session: AsyncSession, user: Profile, estimate_id: uuid.UUID) -> Estimate:
    """Pull an estimate back out of the trash, returning it to ``active``."""
    if not estimate_rules.can_restore(actor_of(user)):
        raise Forbidden("Only owners and admins can restore estimates.")

    estimate = await session.get(Estimate, estimate_id)
    if estimate is None:
        raise NotFound("Estimate not found.")
    if not estimate.is_trashed:
        raise Conflict("This estimate is not in the trash.")

    estimate.deleted_at = None
    estimate.deleted_by = None
    estimate.status = EstimateStatus.ACTIVE.value
    await session.flush()
    log.info("estimate_restored", estimate_id=str(estimate.id), by=str(user.id))
    return estimate


async def permanently_delete(
    session: AsyncSession, user: Profile, estimate_id: uuid.UUID
) -> list[str]:
    """Destroy an estimate irrecoverably.

    Returns the storage paths of its attachments so the caller can purge the objects
    in the background — the rows cascade away with the estimate, but the blobs in
    Cloud Storage do not.
    """
    if not estimate_rules.can_permanently_delete(actor_of(user)):
        raise Forbidden("Only owners and admins can permanently delete estimates.")

    estimate = await session.get(Estimate, estimate_id)
    if estimate is None:
        raise NotFound("Estimate not found.")

    from app.models.attachment import Attachment

    paths = list(
        await session.scalars(
            select(Attachment.storage_path).where(Attachment.estimate_id == estimate_id)
        )
    )

    await session.delete(estimate)
    await session.flush()
    log.info(
        "estimate_deleted_permanently",
        estimate_id=str(estimate_id),
        by=str(user.id),
        orphaned_objects=len(paths),
    )
    return paths


# ── Transitions ───────────────────────────────────────────────────────────────


async def apply_transition(
    session: AsyncSession, user: Profile, estimate_id: uuid.UUID, action: str
) -> tuple[Estimate, Transition]:
    """Move an estimate through its status state machine.

    The permitted actions and the roles that may perform them are declared once, as
    data, in ``estimate_rules.TRANSITIONS``. Returning the ``Transition`` lets the
    router decide on side effects — only ``lock`` currently notifies anyone.
    """
    estimate = await get_estimate(session, user, estimate_id)
    if estimate.is_trashed:
        raise Conflict("This estimate is in the trash. Restore it first.")

    try:
        transition = estimate_rules.resolve_transition(action, actor_of(user))
    except UnknownTransition as exc:
        raise NotFound(str(exc)) from exc
    except TransitionNotPermitted as exc:
        raise Forbidden(str(exc)) from exc

    estimate.status = transition.target.value
    if transition.clears_approval_token:
        # Withdrawing an estimate must invalidate the reviewer's outstanding link,
        # otherwise an old email could still approve a document that has since moved on.
        estimate.approval_token = None
    await session.flush()

    log.info(
        "estimate_transition",
        estimate_id=str(estimate.id),
        action=action,
        status=estimate.status,
        by=str(user.id),
    )
    return estimate, transition


# ── External review ───────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class SubmissionResult:
    estimate: Estimate
    token: str
    review_url: str
    approve_url: str
    reject_url: str
    changes_url: str


def review_urls(token: str) -> tuple[str, str, str, str]:
    """Build the reviewer-facing links for a token.

    These point at the frontend, not the API. The reviewer opens a real page which
    then calls the public endpoints — unlike the legacy flow, where the links hit a
    serverless function that returned hand-assembled HTML, and where a link-scanning
    email client could approve an estimate simply by following a GET.
    """
    base = f"{get_settings().site_url}/review/{token}"
    return base, f"{base}?action=approve", f"{base}?action=reject", f"{base}?action=changes"


async def submit_for_review(
    session: AsyncSession, user: Profile, estimate_id: uuid.UUID, *, recipient_email: str
) -> SubmissionResult:
    """Mint an approval token and mark the estimate as awaiting a decision.

    Sending the email is the caller's job, from a background task, so a slow mail
    provider does not hold the request open.
    """
    estimate = await get_estimate(session, user, estimate_id)

    if estimate.is_trashed:
        raise Conflict("This estimate is in the trash.")
    if not estimate_rules.can_submit_for_review(actor_of(user), snapshot_of(estimate)):
        raise Forbidden("You can only submit estimates you created.")
    if not estimate_rules.can_be_submitted(snapshot_of(estimate)):
        raise Conflict(
            f"An estimate with status {estimate.status!r} cannot be sent for review. "
            "Recall it first if it is already awaiting a decision."
        )

    token = generate_approval_token()
    estimate.status = EstimateStatus.SUBMITTED.value
    estimate.approval_token = token
    estimate.submitted_to = recipient_email
    estimate.submitted_at = datetime.now(UTC)
    estimate.submitted_by = user.id
    estimate.reviewed_at = None
    estimate.review_note = None
    await session.flush()

    review_url, approve_url, reject_url, changes_url = review_urls(token)
    log.info("estimate_submitted", estimate_id=str(estimate.id), by=str(user.id))

    return SubmissionResult(
        estimate=estimate,
        token=token,
        review_url=review_url,
        approve_url=approve_url,
        reject_url=reject_url,
        changes_url=changes_url,
    )


# ── Presentation helpers ──────────────────────────────────────────────────────


def totals_for(estimate: Estimate) -> estimate_totals.EstimateTotals:
    return estimate_totals.compute(estimate.rooms)
