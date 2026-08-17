"""The project auto-transition engine.

This is the single most business-visible piece of logic in the system. In the legacy
Node backend it was spread across three copies of the same nested ``if`` inside
``projects.js`` (``mark_milestone_paid`` and ``submit_closing_form``), which is why the
migration notes call it out as the thing to pin with tests before porting.

Here it is one pure function. Callers hand it a snapshot of the project and get back a
decision describing what should change; applying that decision is the service's job.

The rules
---------
1. Both closing forms submitted ⇒ work is ``completed``.
2. Work ``completed`` and every milestone paid (or there are none) ⇒ project ``closed``.
3. Work ``completed`` and any milestone unpaid ⇒ project ``pending_payment``.
4. Work not ``completed`` ⇒ project ``active``.
5. A ``cancelled`` project is never touched. Cancellation is a human decision and no
   automatic rule may override it.

Rules 3 and 4 are reversible, which is a deliberate change from the legacy behaviour.
The old code only ever moved a project *forward*: marking a milestone unpaid after a
project had closed left it closed, and there was no path back to ``active`` at all.
Because the same evaluation now runs after every relevant mutation, un-paying a
milestone reopens the project to ``pending_payment``, and reverting work status away
from ``completed`` returns it to ``active``. See the README's "Deliberate changes"
section.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.models.enums import ProjectStatus, WorkStatus

# ── Inputs ────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class MilestoneSnapshot:
    label: str
    paid: bool


@dataclass(frozen=True, slots=True)
class ProjectSnapshot:
    """Everything the rules need, and nothing else."""

    work_status: WorkStatus
    status: ProjectStatus
    has_closing_form_1: bool
    has_closing_form_2: bool
    milestones: tuple[MilestoneSnapshot, ...] = ()

    @property
    def both_closing_forms_submitted(self) -> bool:
        return self.has_closing_form_1 and self.has_closing_form_2

    @property
    def all_milestones_paid(self) -> bool:
        """A project with no milestones counts as fully paid.

        This matches the legacy ``!milestones?.length || milestones.every(m => m.paid)``
        check: a job with no payment schedule recorded should not be held open forever
        waiting for payments that were never scheduled.
        """
        return all(m.paid for m in self.milestones)


# ── Outputs ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class ActivityEntry:
    """A line to append to the project's audit trail."""

    action: str
    details: str = ""


@dataclass(frozen=True, slots=True)
class NotificationRequest:
    """A notification the service should dispatch in the background.

    ``template`` names a file under ``app/services/templates/email/``; ``context`` is
    merged into it. Rendering and sending happen elsewhere — the rules only decide
    *that* something should be sent.
    """

    template: str
    subject: str
    context: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ProjectDecision:
    """What should change. ``None`` on a status field means "leave it alone"."""

    work_status: WorkStatus | None = None
    status: ProjectStatus | None = None
    activity: tuple[ActivityEntry, ...] = ()
    notifications: tuple[NotificationRequest, ...] = ()

    @property
    def is_noop(self) -> bool:
        return (
            self.work_status is None
            and self.status is None
            and not self.activity
            and not self.notifications
        )


# ── The rule ──────────────────────────────────────────────────────────────────


def evaluate(snapshot: ProjectSnapshot, *, project_name: str = "") -> ProjectDecision:
    """Derive the project's correct state from the facts about it.

    Call this after *any* mutation that could affect the outcome — a milestone being
    added, paid, un-paid, or deleted; a closing form being submitted; work status
    being set by hand. It is idempotent: evaluating an already-correct project returns
    a no-op decision, so calling it more often than strictly necessary is safe and is
    the recommended default.
    """
    # Rule 5: cancellation is final until a human undoes it.
    if snapshot.status == ProjectStatus.CANCELLED:
        return ProjectDecision()

    activity: list[ActivityEntry] = []
    notifications: list[NotificationRequest] = []

    # ── Rule 1: both forms in ⇒ work complete ─────────────────────────────────
    effective_work_status = snapshot.work_status
    new_work_status: WorkStatus | None = None

    if snapshot.both_closing_forms_submitted and snapshot.work_status != WorkStatus.COMPLETED:
        effective_work_status = WorkStatus.COMPLETED
        new_work_status = WorkStatus.COMPLETED
        activity.append(
            ActivityEntry(
                action="Work status auto-updated",
                details="Both closing forms submitted — work marked as Completed",
            )
        )

    # ── Rules 2-4: derive the engagement status from the work status ──────────
    if effective_work_status == WorkStatus.COMPLETED:
        target_status = (
            ProjectStatus.CLOSED if snapshot.all_milestones_paid else ProjectStatus.PENDING_PAYMENT
        )
    else:
        target_status = ProjectStatus.ACTIVE

    new_status: ProjectStatus | None = None
    if target_status != snapshot.status:
        new_status = target_status
        activity.append(_activity_for(target_status, snapshot))
        notification = _notification_for(target_status, snapshot, project_name)
        if notification is not None:
            notifications.append(notification)

    return ProjectDecision(
        work_status=new_work_status,
        status=new_status,
        activity=tuple(activity),
        notifications=tuple(notifications),
    )


# ── Narration ─────────────────────────────────────────────────────────────────


def _activity_for(target: ProjectStatus, snapshot: ProjectSnapshot) -> ActivityEntry:
    if target == ProjectStatus.CLOSED:
        return ActivityEntry(
            action="Project closed",
            details="Work completed and all payments received",
        )
    if target == ProjectStatus.PENDING_PAYMENT:
        unpaid = sum(1 for m in snapshot.milestones if not m.paid)
        return ActivityEntry(
            action="Project moved to Pending Payment",
            details=(
                f"Work is complete but {unpaid} payment milestone"
                f"{'s are' if unpaid != 1 else ' is'} still outstanding"
            ),
        )
    return ActivityEntry(
        action="Project reopened",
        details="Work is no longer complete — project returned to Active",
    )


def _notification_for(
    target: ProjectStatus, snapshot: ProjectSnapshot, project_name: str
) -> NotificationRequest | None:
    """Which status changes are worth emailing the admins about.

    Reopening is intentionally silent. It is nearly always a correction of a mistaken
    click, and the legacy system sent nothing in that situation because it could not
    reach it at all.
    """
    name = project_name or "Project"

    if target == ProjectStatus.CLOSED:
        return NotificationRequest(
            template="project_closed.html",
            subject=f"✅ Project Closed — {name}",
            context={
                "project_name": name,
                "headline": "All payments received",
                "body": (
                    "Work is complete and every payment milestone has been settled. "
                    "The project has been closed automatically."
                ),
            },
        )

    if target == ProjectStatus.PENDING_PAYMENT:
        outstanding = sum(1 for m in snapshot.milestones if not m.paid)
        return NotificationRequest(
            template="project_pending_payment.html",
            subject=f"⏳ Pending Payment — {name}",
            context={
                "project_name": name,
                "headline": "Work complete, payment outstanding",
                "body": (
                    f"Work on this project is complete, but {outstanding} payment "
                    f"milestone{'s remain' if outstanding != 1 else ' remains'} unpaid."
                ),
            },
        )

    return None
