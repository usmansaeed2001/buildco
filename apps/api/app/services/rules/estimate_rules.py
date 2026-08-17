"""Estimate permissions and the status state machine.

The legacy implementation scattered these decisions through ``estimates.js`` as inline
role checks and a literal ``actionMap`` object. They are gathered here as data plus
pure predicates so the router can stay declarative and the matrix can be tested
exhaustively.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from app.models.enums import ELEVATED_ROLES, EstimateStatus, Role

# ── Snapshot ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class ActorSnapshot:
    """The acting user, reduced to what permission decisions actually depend on."""

    id: uuid.UUID
    role: Role

    @property
    def is_owner(self) -> bool:
        return self.role == Role.OWNER

    @property
    def is_elevated(self) -> bool:
        return self.role in ELEVATED_ROLES


@dataclass(frozen=True, slots=True)
class EstimateSnapshot:
    status: EstimateStatus
    created_by: uuid.UUID | None
    is_trashed: bool = False


# ── Transition table ──────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Transition:
    action: str
    target: EstimateStatus
    allowed_roles: frozenset[Role]
    #: Whether performing this action invalidates any outstanding approval link.
    clears_approval_token: bool = False
    #: Whether admins should be emailed when this happens.
    notifies_admins: bool = False
    description: str = ""


TRANSITIONS: dict[str, Transition] = {
    "archive": Transition(
        action="archive",
        target=EstimateStatus.ARCHIVED,
        allowed_roles=frozenset(ELEVATED_ROLES),
        description="Move the estimate out of the active list.",
    ),
    "unarchive": Transition(
        action="unarchive",
        target=EstimateStatus.ACTIVE,
        allowed_roles=frozenset(ELEVATED_ROLES),
        description="Return an archived estimate to the active list.",
    ),
    "lock": Transition(
        action="lock",
        target=EstimateStatus.LOCKED,
        allowed_roles=frozenset({Role.OWNER}),
        notifies_admins=True,
        description="Freeze the estimate. Only the owner can lock or unlock.",
    ),
    "unlock": Transition(
        action="unlock",
        target=EstimateStatus.ACTIVE,
        allowed_roles=frozenset({Role.OWNER}),
        description="Release a locked estimate for editing.",
    ),
    "recall": Transition(
        action="recall",
        target=EstimateStatus.ACTIVE,
        allowed_roles=frozenset({Role.OWNER, Role.ADMIN, Role.MEMBER}),
        clears_approval_token=True,
        description="Withdraw a submitted estimate and invalidate the reviewer's link.",
    ),
    "resubmit_ready": Transition(
        action="resubmit_ready",
        target=EstimateStatus.ACTIVE,
        allowed_roles=frozenset({Role.OWNER, Role.ADMIN, Role.MEMBER}),
        clears_approval_token=True,
        description="Reopen an estimate that came back with requested changes.",
    ),
    "admin_approve": Transition(
        action="admin_approve",
        target=EstimateStatus.APPROVED,
        allowed_roles=frozenset(ELEVATED_ROLES),
        description="Approve internally, without waiting on the external reviewer.",
    ),
}

#: Statuses from which an estimate may be sent out for external review.
SUBMITTABLE_FROM: frozenset[EstimateStatus] = frozenset(
    {
        EstimateStatus.ACTIVE,
        EstimateStatus.CHANGES_REQUESTED,
        EstimateStatus.REJECTED,
    }
)

#: Statuses a reviewer has already decided on. Reaching one burns the approval token.
TERMINAL_REVIEW_STATUSES: frozenset[EstimateStatus] = frozenset(
    {EstimateStatus.APPROVED, EstimateStatus.REJECTED}
)


# ── Predicates ────────────────────────────────────────────────────────────────


def can_view(actor: ActorSnapshot, estimate: EstimateSnapshot) -> bool:
    """Who may read an estimate.

    Members see only their own. This closes the gap flagged in the migration notes:
    the legacy ``GET /estimates`` returned every estimate to any authenticated user,
    while the equivalent projects endpoint already filtered by role.
    """
    if actor.is_elevated:
        return True
    return estimate.created_by == actor.id


def can_edit(actor: ActorSnapshot, estimate: EstimateSnapshot) -> bool:
    """Who may change an estimate's contents.

    A locked estimate is editable by the owner alone; that outranks every other rule.
    Beyond that, members may edit only what they created.
    """
    if estimate.status == EstimateStatus.LOCKED:
        return actor.is_owner
    return can_view(actor, estimate)


def can_soft_delete(actor: ActorSnapshot, estimate: EstimateSnapshot) -> bool:
    """Who may move an estimate to the trash: elevated roles, or its author."""
    return actor.is_elevated or estimate.created_by == actor.id


def can_permanently_delete(actor: ActorSnapshot) -> bool:
    """Who may destroy an estimate irrecoverably. Never a member, even their own."""
    return actor.is_elevated


def can_restore(actor: ActorSnapshot) -> bool:
    """Who may pull an estimate back out of the trash."""
    return actor.is_elevated


def can_submit_for_review(actor: ActorSnapshot, estimate: EstimateSnapshot) -> bool:
    """Who may email an estimate to an external reviewer.

    Submitting freezes the document behind an approval link, so it follows the same
    permission as editing it.
    """
    return can_edit(actor, estimate)


# ── Transition resolution ─────────────────────────────────────────────────────


class UnknownTransition(ValueError):
    """The requested action is not in the transition table."""


class TransitionNotPermitted(PermissionError):
    """The actor's role may not perform this transition."""

    def __init__(self, transition: Transition, actor_role: Role) -> None:
        roles = "/".join(sorted(r.value for r in transition.allowed_roles))
        super().__init__(f"Only {roles} can {transition.action}")
        self.transition = transition
        self.actor_role = actor_role


def resolve_transition(action: str, actor: ActorSnapshot) -> Transition:
    """Look up an action and confirm the actor is allowed to perform it.

    Raises ``UnknownTransition`` for an action that does not exist and
    ``TransitionNotPermitted`` for one the actor's role cannot perform. Services
    translate those into the API's 400 and 403.
    """
    transition = TRANSITIONS.get(action)
    if transition is None:
        raise UnknownTransition(f"Unknown action: {action}")
    if actor.role not in transition.allowed_roles:
        raise TransitionNotPermitted(transition, actor.role)
    return transition


def can_be_submitted(estimate: EstimateSnapshot) -> bool:
    """Whether the estimate's current status permits sending it for review.

    Blocks re-sending something already awaiting a decision, or an archived or locked
    document. The legacy code performed no such check and would happily mint a second
    approval token, silently orphaning the first reviewer's link.
    """
    return estimate.status in SUBMITTABLE_FROM
