"""Estimate permissions and the status transition matrix."""

from __future__ import annotations

import uuid

import pytest

from app.models.enums import EstimateStatus, Role
from app.services.rules import estimate_rules
from app.services.rules.estimate_rules import (
    ActorSnapshot,
    EstimateSnapshot,
    TransitionNotAvailable,
    TransitionNotPermitted,
    UnknownTransition,
)

OWNER_ID = uuid.uuid4()
ADMIN_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
OTHER_ID = uuid.uuid4()

OWNER = ActorSnapshot(id=OWNER_ID, role=Role.OWNER)
ADMIN = ActorSnapshot(id=ADMIN_ID, role=Role.ADMIN)
MEMBER = ActorSnapshot(id=MEMBER_ID, role=Role.MEMBER)


def est(
    *, status: EstimateStatus = EstimateStatus.ACTIVE, created_by: uuid.UUID = MEMBER_ID
) -> EstimateSnapshot:
    return EstimateSnapshot(status=status, created_by=created_by)


def resolve(action: str, actor: ActorSnapshot) -> estimate_rules.Transition:
    """Resolve from a status the action is offered from, for tests about roles."""
    transition = estimate_rules.TRANSITIONS.get(action)
    status = min(transition.allowed_from) if transition else EstimateStatus.ACTIVE
    return estimate_rules.resolve_transition(action, actor, status)


# ── Visibility ────────────────────────────────────────────────────────────────


def test_elevated_roles_see_every_estimate():
    assert estimate_rules.can_view(OWNER, est(created_by=OTHER_ID))
    assert estimate_rules.can_view(ADMIN, est(created_by=OTHER_ID))


def test_a_member_sees_only_their_own_estimates():
    """The legacy GET /estimates returned every estimate to any signed-in user."""
    assert estimate_rules.can_view(MEMBER, est(created_by=MEMBER_ID))
    assert not estimate_rules.can_view(MEMBER, est(created_by=OTHER_ID))


# ── Editing ───────────────────────────────────────────────────────────────────


def test_a_locked_estimate_is_editable_only_by_the_owner():
    locked = est(status=EstimateStatus.LOCKED, created_by=MEMBER_ID)

    assert estimate_rules.can_edit(OWNER, locked)
    assert not estimate_rules.can_edit(ADMIN, locked)
    assert not estimate_rules.can_edit(MEMBER, locked)


def test_locking_outranks_authorship():
    """Even the author cannot edit their own estimate once it is locked."""
    assert not estimate_rules.can_edit(
        MEMBER, est(status=EstimateStatus.LOCKED, created_by=MEMBER_ID)
    )


def test_a_member_can_edit_only_their_own_estimates():
    assert estimate_rules.can_edit(MEMBER, est(created_by=MEMBER_ID))
    assert not estimate_rules.can_edit(MEMBER, est(created_by=OTHER_ID))


# ── Deletion ──────────────────────────────────────────────────────────────────


def test_authors_and_elevated_roles_can_trash_an_estimate():
    assert estimate_rules.can_soft_delete(MEMBER, est(created_by=MEMBER_ID))
    assert estimate_rules.can_soft_delete(ADMIN, est(created_by=OTHER_ID))
    assert not estimate_rules.can_soft_delete(MEMBER, est(created_by=OTHER_ID))


def test_permanent_deletion_is_never_available_to_a_member():
    """Not even for an estimate they created — the trash is the member's recourse."""
    assert not estimate_rules.can_permanently_delete(MEMBER)
    assert estimate_rules.can_permanently_delete(ADMIN)
    assert estimate_rules.can_permanently_delete(OWNER)


def test_only_elevated_roles_restore_from_the_trash():
    assert estimate_rules.can_restore(OWNER)
    assert not estimate_rules.can_restore(MEMBER)


# ── Transition matrix ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("action", "target"),
    [
        ("archive", EstimateStatus.ARCHIVED),
        ("unarchive", EstimateStatus.ACTIVE),
        ("lock", EstimateStatus.LOCKED),
        ("unlock", EstimateStatus.ACTIVE),
        ("recall", EstimateStatus.ACTIVE),
        ("resubmit_ready", EstimateStatus.ACTIVE),
        ("admin_approve", EstimateStatus.APPROVED),
    ],
)
def test_each_action_moves_to_its_declared_status(action, target):
    """From a status the action is offered from; the status matrix is pinned below."""
    assert resolve(action, OWNER).target == target


@pytest.mark.parametrize("action", ["lock", "unlock"])
def test_only_the_owner_may_lock_or_unlock(action):
    assert resolve(action, OWNER)

    for actor in (ADMIN, MEMBER):
        with pytest.raises(TransitionNotPermitted):
            resolve(action, actor)


@pytest.mark.parametrize("action", ["archive", "unarchive", "admin_approve"])
def test_members_cannot_archive_or_approve(action):
    with pytest.raises(TransitionNotPermitted):
        resolve(action, MEMBER)


@pytest.mark.parametrize("action", ["recall", "resubmit_ready"])
def test_any_role_may_recall_or_resubmit(action):
    for actor in (OWNER, ADMIN, MEMBER):
        assert resolve(action, actor)


@pytest.mark.parametrize("action", ["recall", "resubmit_ready"])
def test_withdrawing_invalidates_the_reviewers_link(action):
    """Otherwise an old email could still approve a document that has moved on."""
    assert resolve(action, OWNER).clears_approval_token


@pytest.mark.parametrize("action", ["archive", "lock", "admin_approve"])
def test_other_actions_leave_the_approval_token_alone(action):
    assert not resolve(action, OWNER).clears_approval_token


def test_an_unknown_action_is_rejected():
    with pytest.raises(UnknownTransition):
        resolve("delete_everything", OWNER)


def test_locking_notifies_admins_and_nothing_else_does():
    notifying = [name for name, t in estimate_rules.TRANSITIONS.items() if t.notifies_admins]
    assert notifying == ["lock"]


# ── Which status each action may be taken from ────────────────────────────────

#: Written out by hand, not derived from ``TRANSITIONS``, so that a change to the table
#: has to be made twice to pass. It is the same matrix the browser draws its buttons
#: from: ``availableTransitions`` in ``staff-web/src/domain/estimateRules.ts``.
OFFERED_FROM: dict[str, set[EstimateStatus]] = {
    "archive": {EstimateStatus.ACTIVE, EstimateStatus.REJECTED, EstimateStatus.APPROVED},
    "unarchive": {EstimateStatus.ARCHIVED},
    "lock": {EstimateStatus.ACTIVE},
    "unlock": {EstimateStatus.LOCKED},
    "recall": {EstimateStatus.SUBMITTED},
    "resubmit_ready": {EstimateStatus.CHANGES_REQUESTED},
    "admin_approve": {
        EstimateStatus.ACTIVE,
        EstimateStatus.SUBMITTED,
        EstimateStatus.CHANGES_REQUESTED,
        EstimateStatus.REJECTED,
    },
}


def test_the_status_matrix_covers_every_action():
    assert set(OFFERED_FROM) == set(estimate_rules.TRANSITIONS)


@pytest.mark.parametrize("action", sorted(OFFERED_FROM))
@pytest.mark.parametrize("status", list(EstimateStatus))
def test_an_action_is_available_only_from_the_statuses_it_is_offered_from(action, status):
    """The API used to accept any action from any status; only the browser held this."""
    if status in OFFERED_FROM[action]:
        assert estimate_rules.resolve_transition(action, OWNER, status).action == action
    else:
        with pytest.raises(TransitionNotAvailable):
            estimate_rules.resolve_transition(action, OWNER, status)


def test_an_admin_cannot_unarchive_a_locked_estimate():
    """This was a way round the owner-only lock: unarchive moves to active."""
    with pytest.raises(TransitionNotAvailable):
        estimate_rules.resolve_transition("unarchive", ADMIN, EstimateStatus.LOCKED)


def test_an_admin_cannot_archive_a_locked_estimate():
    """The other half of the same way round: archive it, then unarchive it."""
    with pytest.raises(TransitionNotAvailable):
        estimate_rules.resolve_transition("archive", ADMIN, EstimateStatus.LOCKED)


def test_a_member_cannot_recall_an_approved_estimate():
    """Recall is open to every role, so the status is the only thing guarding it."""
    with pytest.raises(TransitionNotAvailable):
        estimate_rules.resolve_transition("recall", MEMBER, EstimateStatus.APPROVED)


def test_the_role_is_refused_before_the_status_is_considered():
    """Someone who can never lock is told so, not told to try from another status."""
    with pytest.raises(TransitionNotPermitted):
        estimate_rules.resolve_transition("lock", MEMBER, EstimateStatus.ARCHIVED)


# ── Submission eligibility ────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "status",
    [
        EstimateStatus.ACTIVE,
        EstimateStatus.CHANGES_REQUESTED,
        EstimateStatus.REJECTED,
    ],
)
def test_these_statuses_can_be_sent_for_review(status):
    assert estimate_rules.can_be_submitted(est(status=status))


@pytest.mark.parametrize(
    "status",
    [
        EstimateStatus.SUBMITTED,
        EstimateStatus.APPROVED,
        EstimateStatus.LOCKED,
        EstimateStatus.ARCHIVED,
    ],
)
def test_these_statuses_cannot_be_sent_for_review(status):
    """Re-submitting while awaiting a decision would orphan the first reviewer's link,
    which the legacy code did silently."""
    assert not estimate_rules.can_be_submitted(est(status=status))
