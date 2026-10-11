"""The project auto-transition rules.

These are the scenarios the migration notes flag as the highest business risk in the
whole port, so they are pinned here exhaustively. Everything runs in memory: no
database, no HTTP, no mocks.
"""

from __future__ import annotations

import uuid

import pytest

from app.models.enums import ProjectStatus, Role, WorkStatus
from app.services.rules.project_rules import (
    MilestoneSnapshot,
    ProjectSnapshot,
    can_view,
    evaluate,
)


def snapshot(
    *,
    work_status: WorkStatus = WorkStatus.IN_PROGRESS,
    status: ProjectStatus = ProjectStatus.ACTIVE,
    form_1: bool = False,
    form_2: bool = False,
    milestones: tuple[bool, ...] = (),
) -> ProjectSnapshot:
    return ProjectSnapshot(
        work_status=work_status,
        status=status,
        has_closing_form_1=form_1,
        has_closing_form_2=form_2,
        milestones=tuple(
            MilestoneSnapshot(label=f"Milestone {i + 1}", paid=paid)
            for i, paid in enumerate(milestones)
        ),
    )


# ── Rule 1: both closing forms complete the work ──────────────────────────────


def test_both_closing_forms_complete_the_work():
    decision = evaluate(snapshot(form_1=True, form_2=True, milestones=(True,)))

    assert decision.work_status == WorkStatus.COMPLETED
    assert any("Work status auto-updated" in e.action for e in decision.activity)


def test_one_closing_form_does_not_complete_the_work():
    decision = evaluate(snapshot(form_1=True, form_2=False, milestones=(True,)))

    assert decision.work_status is None
    assert decision.status is None


# ── Rule 2: completed work + all paid ⇒ closed ────────────────────────────────


def test_last_payment_on_completed_work_closes_the_project():
    decision = evaluate(snapshot(work_status=WorkStatus.COMPLETED, milestones=(True, True)))

    assert decision.status == ProjectStatus.CLOSED
    assert any(e.action == "Project closed" for e in decision.activity)
    assert [n.template for n in decision.notifications] == ["project_closed.html"]


def test_a_project_with_no_milestones_counts_as_fully_paid():
    """No payment schedule recorded must not hold a finished job open forever."""
    decision = evaluate(snapshot(work_status=WorkStatus.COMPLETED, milestones=()))

    assert decision.status == ProjectStatus.CLOSED


def test_both_forms_and_all_paid_closes_in_one_evaluation():
    decision = evaluate(snapshot(form_1=True, form_2=True, milestones=(True, True)))

    assert decision.work_status == WorkStatus.COMPLETED
    assert decision.status == ProjectStatus.CLOSED


# ── Rule 3: completed work + outstanding payment ⇒ pending_payment ────────────


def test_completed_work_with_outstanding_payment_is_pending_payment():
    decision = evaluate(snapshot(work_status=WorkStatus.COMPLETED, milestones=(True, False)))

    assert decision.status == ProjectStatus.PENDING_PAYMENT
    assert [n.template for n in decision.notifications] == ["project_pending_payment.html"]


def test_pending_payment_message_counts_the_outstanding_milestones():
    decision = evaluate(snapshot(work_status=WorkStatus.COMPLETED, milestones=(False, False, True)))

    assert "2 payment milestones" in decision.activity[0].details


def test_singular_wording_for_a_single_outstanding_milestone():
    decision = evaluate(snapshot(work_status=WorkStatus.COMPLETED, milestones=(True, False)))

    assert "1 payment milestone is" in decision.activity[0].details


def test_both_forms_with_outstanding_payment_completes_work_but_does_not_close():
    decision = evaluate(snapshot(form_1=True, form_2=True, milestones=(False,)))

    assert decision.work_status == WorkStatus.COMPLETED
    assert decision.status == ProjectStatus.PENDING_PAYMENT


# ── Reversibility — the deliberate change from the legacy behaviour ───────────


def test_unmarking_a_payment_reopens_a_closed_project():
    """The legacy backend could not do this: a mistaken 'paid' click closed a project
    permanently, because it only ever transitioned forward."""
    decision = evaluate(
        snapshot(
            work_status=WorkStatus.COMPLETED,
            status=ProjectStatus.CLOSED,
            milestones=(True, False),
        )
    )

    assert decision.status == ProjectStatus.PENDING_PAYMENT


def test_reverting_work_status_returns_a_closed_project_to_active():
    decision = evaluate(
        snapshot(
            work_status=WorkStatus.IN_PROGRESS,
            status=ProjectStatus.CLOSED,
            milestones=(True,),
        )
    )

    assert decision.status == ProjectStatus.ACTIVE
    assert any(e.action == "Project reopened" for e in decision.activity)


def test_reopening_is_not_announced_by_email():
    """Reopening is nearly always a correction of a misclick — not news."""
    decision = evaluate(
        snapshot(
            work_status=WorkStatus.IN_PROGRESS,
            status=ProjectStatus.PENDING_PAYMENT,
            milestones=(False,),
        )
    )

    assert decision.status == ProjectStatus.ACTIVE
    assert decision.notifications == ()


# ── Rule 5: cancellation is final ─────────────────────────────────────────────


@pytest.mark.parametrize(
    "work_status", [WorkStatus.COMPLETED, WorkStatus.IN_PROGRESS, WorkStatus.ON_HOLD]
)
def test_a_cancelled_project_is_never_touched(work_status):
    decision = evaluate(
        snapshot(
            work_status=work_status,
            status=ProjectStatus.CANCELLED,
            form_1=True,
            form_2=True,
            milestones=(True,),
        )
    )

    assert decision.is_noop


# ── Idempotence ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("work_status", "status", "milestones"),
    [
        (WorkStatus.COMPLETED, ProjectStatus.CLOSED, (True,)),
        (WorkStatus.COMPLETED, ProjectStatus.PENDING_PAYMENT, (False,)),
        (WorkStatus.IN_PROGRESS, ProjectStatus.ACTIVE, (False,)),
        (WorkStatus.CONTRACT_SENT, ProjectStatus.ACTIVE, ()),
    ],
)
def test_evaluating_an_already_correct_project_changes_nothing(work_status, status, milestones):
    """Services call this after every mutation, so a no-op must genuinely be free."""
    decision = evaluate(snapshot(work_status=work_status, status=status, milestones=milestones))

    assert decision.is_noop


def test_applying_a_decision_twice_is_stable():
    first = evaluate(snapshot(form_1=True, form_2=True, milestones=(True,)))
    settled = snapshot(
        work_status=first.work_status or WorkStatus.IN_PROGRESS,
        status=first.status or ProjectStatus.ACTIVE,
        form_1=True,
        form_2=True,
        milestones=(True,),
    )

    assert evaluate(settled).is_noop


# ── Who may see a project ─────────────────────────────────────────────────────

ME = uuid.uuid4()
SOMEONE_ELSE = uuid.uuid4()


@pytest.mark.parametrize("role", [Role.OWNER, Role.ADMIN])
@pytest.mark.parametrize("assigned_to", [ME, SOMEONE_ELSE, None])
def test_owners_and_admins_see_every_project(role, assigned_to):
    assert can_view(role=role, actor_id=ME, assigned_to=assigned_to)


def test_a_member_sees_a_project_assigned_to_them():
    assert can_view(role=Role.MEMBER, actor_id=ME, assigned_to=ME)


def test_a_member_does_not_see_a_project_assigned_to_someone_else():
    assert not can_view(role=Role.MEMBER, actor_id=ME, assigned_to=SOMEONE_ELSE)


def test_a_member_does_not_see_an_unassigned_project():
    assert not can_view(role=Role.MEMBER, actor_id=ME, assigned_to=None)
