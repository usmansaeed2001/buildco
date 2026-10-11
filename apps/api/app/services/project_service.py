"""Projects, milestones, supplement links, activity, and closing forms.

Every mutation that could affect a project's derived state funnels through
``_reconcile``, which asks ``project_rules.evaluate`` what the state should be and
applies the answer. No other function in this module decides ``status`` for itself.
That is what keeps the three legacy copies of the same nested ``if`` from drifting
apart again.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import Conflict, Forbidden, NotFound
from app.logging import get_logger
from app.models.enums import ELEVATED_ROLES, ProjectStatus, Role, WorkStatus
from app.models.estimate import Estimate
from app.models.milestone import PaymentMilestone
from app.models.profile import Profile
from app.models.project import Project
from app.models.project_activity import ProjectActivity
from app.models.project_supplement import ProjectSupplement
from app.services.integrations import storage
from app.services.integrations.storage import SignedUpload
from app.services.rules import project_rules
from app.services.rules.project_rules import (
    MilestoneSnapshot,
    NotificationRequest,
    ProjectSnapshot,
)

log = get_logger(__name__)


@dataclass(slots=True)
class MutationResult:
    """What a mutation changed, plus the notifications it owes.

    Routers schedule ``notifications`` on ``BackgroundTasks`` after the response is
    built, so email never sits on the request's critical path.
    """

    project: Project
    notifications: list[NotificationRequest] = field(default_factory=list)


# ── Activity ──────────────────────────────────────────────────────────────────


def log_activity(
    session: AsyncSession,
    project_id: uuid.UUID,
    actor: Profile,
    action: str,
    details: str = "",
) -> ProjectActivity:
    """Append to the project's audit trail.

    Not a coroutine: it only stages a row on the session, and the request's commit
    persists it alongside whatever change it describes. That keeps the log and the
    change it records atomic — one cannot exist without the other.
    """
    entry = ProjectActivity(
        project_id=project_id,
        user_id=actor.id,
        user_name=actor.display_name,
        action=action,
        details=details,
    )
    session.add(entry)
    return entry


# ── The reconciliation step ───────────────────────────────────────────────────


async def _snapshot(session: AsyncSession, project: Project) -> ProjectSnapshot:
    milestones = list(
        await session.scalars(
            select(PaymentMilestone).where(PaymentMilestone.project_id == project.id)
        )
    )
    return ProjectSnapshot(
        work_status=WorkStatus(project.work_status),
        status=ProjectStatus(project.status),
        has_closing_form_1=bool(project.closing_form_1),
        has_closing_form_2=bool(project.closing_form_2),
        milestones=tuple(MilestoneSnapshot(label=m.label, paid=m.paid) for m in milestones),
    )


async def _reconcile(
    session: AsyncSession, project: Project, actor: Profile
) -> list[NotificationRequest]:
    """Bring a project's derived state in line with the facts about it.

    Call after anything that could change the answer: a milestone added, paid,
    un-paid, or removed; a closing form submitted; work status set by hand. It is
    idempotent, so calling it when nothing changed is free.
    """
    snapshot = await _snapshot(session, project)
    decision = project_rules.evaluate(snapshot, project_name=project.owner_name)

    if decision.is_noop:
        return []

    if decision.work_status is not None:
        project.work_status = decision.work_status.value
    if decision.status is not None:
        project.status = decision.status.value

    for entry in decision.activity:
        log_activity(session, project.id, actor, entry.action, entry.details)

    await session.flush()
    log.info(
        "project_reconciled",
        project_id=str(project.id),
        work_status=project.work_status,
        status=project.status,
    )
    return list(decision.notifications)


# ── Reads ─────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class ProjectPage:
    items: list[Project]
    total: int


async def list_projects(
    session: AsyncSession,
    user: Profile,
    *,
    status: ProjectStatus | None = None,
    work_status: WorkStatus | None = None,
    limit: int = 50,
    offset: int = 0,
) -> ProjectPage:
    """List projects, newest first. Members see only what is assigned to them."""
    conditions = []
    if status is not None:
        conditions.append(Project.status == status.value)
    if work_status is not None:
        conditions.append(Project.work_status == work_status.value)
    if Role(user.role) not in ELEVATED_ROLES:
        conditions.append(Project.assigned_to == user.id)

    total = await session.scalar(select(func.count()).select_from(Project).where(*conditions))
    rows = await session.scalars(
        select(Project)
        .where(*conditions)
        .order_by(Project.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    return ProjectPage(items=list(rows), total=total or 0)


async def get_project(session: AsyncSession, actor: Profile, project_id: uuid.UUID) -> Project:
    """Load a project the actor is allowed to see.

    A project they may not see is a **404, not a 403**: a member who is not on a project
    has no business learning that it exists.

    Every read below goes through this, so the rule holds for any caller and not only
    for a request that arrived through ``deps.require_project_access``. When that
    dependency has already loaded the project, the lookup here is answered from the
    session's identity map and costs no query.
    """
    project = await session.get(Project, project_id)
    if project is None or not project_rules.can_view(
        role=Role(actor.role), actor_id=actor.id, assigned_to=project.assigned_to
    ):
        raise NotFound("Project not found.")
    return project


async def list_milestones(
    session: AsyncSession, actor: Profile, project_id: uuid.UUID
) -> list[PaymentMilestone]:
    await get_project(session, actor, project_id)
    return list(
        await session.scalars(
            select(PaymentMilestone)
            .where(PaymentMilestone.project_id == project_id)
            .order_by(PaymentMilestone.created_at)
        )
    )


async def list_supplements(
    session: AsyncSession, actor: Profile, project_id: uuid.UUID
) -> list[ProjectSupplement]:
    await get_project(session, actor, project_id)
    return list(
        await session.scalars(
            select(ProjectSupplement)
            .where(ProjectSupplement.project_id == project_id)
            .order_by(ProjectSupplement.linked_at)
        )
    )


async def list_activity(
    session: AsyncSession,
    actor: Profile,
    project_id: uuid.UUID,
    *,
    limit: int = 50,
    offset: int = 0,
) -> list[ProjectActivity]:
    await get_project(session, actor, project_id)
    return list(
        await session.scalars(
            select(ProjectActivity)
            .where(ProjectActivity.project_id == project_id)
            .order_by(ProjectActivity.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
    )


# ── Writes ────────────────────────────────────────────────────────────────────


async def create_project(
    session: AsyncSession, actor: Profile, data: dict[str, Any]
) -> tuple[Project, Profile | None]:
    """Create a project. Returns it alongside the assignee, if one was named.

    The assignee is returned so the router can email them without loading the profile
    a second time.
    """
    project = Project(
        created_by=actor.id,
        # Set eagerly: a freshly flushed object has never been queried, so its
        # selectin loaders have not run, and serialising it would trigger a lazy
        # load from async context.
        creator=actor,
        work_status=WorkStatus.CONTRACT_SENT.value,
        status=ProjectStatus.ACTIVE.value,
        **data,
    )
    session.add(project)
    await session.flush()

    log_activity(
        session,
        project.id,
        actor,
        "Project created",
        f"Created by {actor.display_name}",
    )

    assignee: Profile | None = None
    if project.assigned_to:
        assignee = await session.get(Profile, project.assigned_to)
        if assignee is None:
            raise NotFound("The assigned user does not exist.")
        project.assignee = assignee

    await session.flush()
    log.info("project_created", project_id=str(project.id), by=str(actor.id))
    return project, assignee


async def update_project(
    session: AsyncSession, actor: Profile, project: Project, changes: dict[str, Any]
) -> MutationResult:
    """Apply a partial update to a project's details.

    Reassignment is called out separately in the audit trail, because "who is on this
    job" is the field people most often need to reconstruct after the fact.
    """
    previous_assignee = project.assigned_to

    for field_name, value in changes.items():
        setattr(project, field_name, value)
    await session.flush()

    log_activity(
        session,
        project.id,
        actor,
        "Project details updated",
        f"Updated by {actor.display_name}",
    )
    if "assigned_to" in changes and changes["assigned_to"] != previous_assignee:
        assignee = await session.get(Profile, project.assigned_to) if project.assigned_to else None
        log_activity(
            session,
            project.id,
            actor,
            "Project reassigned",
            f"Now assigned to {assignee.display_name}" if assignee else "Unassigned",
        )

    # Money changes cannot affect the derived state, but a reconcile here is free and
    # means no future field addition can quietly bypass the rules engine.
    notifications = await _reconcile(session, project, actor)
    return MutationResult(project=project, notifications=notifications)


async def set_work_status(
    session: AsyncSession, actor: Profile, project: Project, work_status: WorkStatus
) -> MutationResult:
    """Set the work status by hand, then let the rules engine derive the rest."""
    if project.work_status == work_status.value:
        return MutationResult(project=project)

    from app.models.enums import WORK_STATUS_LABELS

    project.work_status = work_status.value
    await session.flush()

    log_activity(
        session,
        project.id,
        actor,
        "Work status updated",
        f"Status changed to: {WORK_STATUS_LABELS[work_status]}",
    )

    notifications = await _reconcile(session, project, actor)
    return MutationResult(project=project, notifications=notifications)


async def set_project_status(
    session: AsyncSession, actor: Profile, project: Project, status: ProjectStatus
) -> MutationResult:
    """Manually set project status. Restricted to ``active`` and ``cancelled``.

    Note the asymmetry: setting ``active`` on a project whose facts say otherwise is
    immediately re-derived away by the reconcile below, which is correct — the facts
    win. ``cancelled`` survives, because the rules engine treats it as final.
    """
    project.status = status.value
    await session.flush()
    log_activity(session, project.id, actor, "Project status updated", f"Status: {status.value}")

    notifications = await _reconcile(session, project, actor)
    return MutationResult(project=project, notifications=notifications)


async def delete_project(session: AsyncSession, actor: Profile, project: Project) -> None:
    project_id = project.id
    await session.delete(project)
    await session.flush()
    log.info("project_deleted", project_id=str(project_id), by=str(actor.id))


# ── Milestones ────────────────────────────────────────────────────────────────


async def add_milestone(
    session: AsyncSession, actor: Profile, project: Project, data: dict[str, Any]
) -> tuple[PaymentMilestone, MutationResult]:
    """Add a payment milestone.

    Adding an unpaid milestone to a closed project reopens it to ``pending_payment``
    — the reconcile below sees the new unpaid row and re-derives accordingly.
    """
    milestone = PaymentMilestone(project_id=project.id, **data)
    session.add(milestone)
    await session.flush()

    log_activity(
        session,
        project.id,
        actor,
        "Payment milestone added",
        f"{milestone.label}: ${milestone.amount}",
    )

    notifications = await _reconcile(session, project, actor)
    return milestone, MutationResult(project=project, notifications=notifications)


async def get_milestone(
    session: AsyncSession, project_id: uuid.UUID, milestone_id: uuid.UUID
) -> PaymentMilestone:
    milestone = await session.get(PaymentMilestone, milestone_id)
    if milestone is None or milestone.project_id != project_id:
        raise NotFound("Payment milestone not found.")
    return milestone


async def update_milestone(
    session: AsyncSession,
    actor: Profile,
    project: Project,
    milestone_id: uuid.UUID,
    changes: dict[str, Any],
) -> tuple[PaymentMilestone, MutationResult]:
    """Update a milestone. Toggling ``paid`` re-derives the project's status.

    Un-marking a payment reverses the transition it caused, which the legacy backend
    could not do — it only ever moved projects forward, so a mistaken "paid" click
    left a project permanently closed.
    """
    milestone = await get_milestone(session, project.id, milestone_id)
    paid_changed = "paid" in changes and changes["paid"] != milestone.paid

    for field_name, value in changes.items():
        setattr(milestone, field_name, value)

    if paid_changed:
        if milestone.paid:
            milestone.paid_at = datetime.now(UTC)
            milestone.paid_by = actor.id
        else:
            milestone.paid_at = None
            milestone.paid_by = None

    await session.flush()

    if paid_changed:
        log_activity(
            session,
            project.id,
            actor,
            "Payment received" if milestone.paid else "Payment marked unpaid",
            f"Milestone: {milestone.label} — ${milestone.amount}",
        )
    else:
        log_activity(session, project.id, actor, "Payment milestone updated", milestone.label)

    notifications = await _reconcile(session, project, actor)
    return milestone, MutationResult(project=project, notifications=notifications)


async def delete_milestone(
    session: AsyncSession, actor: Profile, project: Project, milestone_id: uuid.UUID
) -> MutationResult:
    """Delete a milestone.

    Removing the last unpaid milestone from a completed project closes it — correctly,
    since there is then nothing left to collect.
    """
    milestone = await get_milestone(session, project.id, milestone_id)
    label = milestone.label
    await session.delete(milestone)
    await session.flush()

    log_activity(session, project.id, actor, "Payment milestone deleted", label)

    notifications = await _reconcile(session, project, actor)
    return MutationResult(project=project, notifications=notifications)


# ── Supplement links ──────────────────────────────────────────────────────────


async def link_supplement(
    session: AsyncSession, actor: Profile, project: Project, estimate_id: uuid.UUID
) -> ProjectSupplement:
    estimate = await session.get(Estimate, estimate_id)
    if estimate is None:
        raise NotFound("Estimate not found.")

    link = ProjectSupplement(
        project_id=project.id,
        estimate_id=estimate_id,
        linked_by=actor.id,
        # Eager, for the same reason as elsewhere: the response serialises
        # link.estimate, and a flushed-but-unqueried object has no loaded relations.
        estimate=estimate,
    )
    session.add(link)
    try:
        await session.flush()
    except IntegrityError as exc:
        raise Conflict("That estimate is already linked to this project.") from exc

    log_activity(
        session,
        project.id,
        actor,
        "Supplement linked",
        f"{estimate.identifier} — {estimate.project_name}",
    )
    return link


async def unlink_supplement(
    session: AsyncSession, actor: Profile, project: Project, estimate_id: uuid.UUID
) -> None:
    link = await session.scalar(
        select(ProjectSupplement).where(
            ProjectSupplement.project_id == project.id,
            ProjectSupplement.estimate_id == estimate_id,
        )
    )
    if link is None:
        raise NotFound("That estimate is not linked to this project.")

    await session.delete(link)
    await session.flush()
    log_activity(session, project.id, actor, "Supplement unlinked", "")


# ── Closing forms ─────────────────────────────────────────────────────────────

FORM_NAMES = {1: "Material Sign-Off", 2: "Project Sign-Off"}


async def submit_closing_form(
    session: AsyncSession,
    actor: Profile,
    project: Project,
    form_number: int,
    data: dict[str, Any],
) -> tuple[MutationResult, bool]:
    """Record a closing form. Returns the result and whether both are now in.

    Submitting the second form is what completes the work, and completing the work is
    what lets the payment check close the project — the whole chain runs inside
    ``_reconcile`` rather than being re-implemented here.
    """
    if form_number not in FORM_NAMES:
        raise NotFound(f"Unknown closing form {form_number}. Expected 1 or 2.")

    _assert_photo_belongs_to(project, data)

    if form_number == 1:
        project.closing_form_1 = data
    else:
        project.closing_form_2 = data
    project.closing_form_submitted_at = datetime.now(UTC)
    project.closing_form_submitted_by = actor.id
    await session.flush()

    log_activity(
        session,
        project.id,
        actor,
        f"{FORM_NAMES[form_number]} submitted",
        f"Submitted by {actor.display_name}",
    )

    both_submitted = bool(project.closing_form_1) and bool(project.closing_form_2)
    notifications = await _reconcile(session, project, actor)
    return MutationResult(project=project, notifications=notifications), both_submitted


# ── Closing-form photos ───────────────────────────────────────────────────────

#: Key in a closing form's ``data`` holding the uploaded photo's object key. The form
#: body is otherwise opaque, so this is the one field the backend looks at — it has to,
#: because an unvalidated key would let a caller claim any object in the bucket.
PHOTO_PATH_KEY = "material_photo_path"


def closing_form_prefix(project_id: uuid.UUID) -> str:
    return f"projects/{project_id}/closing-forms/"


def _assert_photo_belongs_to(project: Project, data: dict[str, Any]) -> None:
    """Reject a photo key that does not sit under this project's own prefix.

    Same reasoning as ``attachment_service.record_attachment``: the client posts a key
    it claims to have uploaded, and without this check it could name someone else's
    object and have the form render it.
    """
    path = data.get(PHOTO_PATH_KEY)
    if path is None or path == "":
        return
    if not isinstance(path, str):
        raise Forbidden("That storage path is not valid for this project.")
    if not path.startswith(closing_form_prefix(project.id)) or ".." in path:
        raise Forbidden("That storage path does not belong to this project.")


async def create_closing_form_photo_url(
    project: Project, form_number: int, *, file_name: str, content_type: str
) -> SignedUpload:
    """Mint a signed PUT for a closing-form photo.

    Access is already established by ``AccessibleProject`` on the route, and closing
    forms are open to any role assigned to the project — matching the legacy app, where
    members could complete a sign-off.
    """
    if form_number not in FORM_NAMES:
        raise NotFound(f"Unknown closing form {form_number}. Expected 1 or 2.")

    path = storage.closing_form_path(str(project.id), form_number, file_name)
    return await storage.create_upload_url("attachments", path, content_type)
