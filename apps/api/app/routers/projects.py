"""Project endpoints, including milestones, supplements, activity, and closing forms.

``AccessibleProject`` loads the project and enforces row-level access in one step, so
no handler here repeats that check.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Path, Query, status

from app.config import get_settings
from app.deps import AccessibleProject, CurrentUser, DbSession, Elevated
from app.errors import NotFound
from app.models.enums import ProjectStatus, WorkStatus
from app.models.project import Project
from app.models.project_supplement import ProjectSupplement
from app.schemas.common import Ack, Page
from app.schemas.project import (
    ActivityOut,
    ClosingFormSubmit,
    LinkedEstimate,
    MilestoneCreate,
    MilestoneOut,
    MilestoneUpdate,
    ProjectCreate,
    ProjectDetailOut,
    ProjectOut,
    ProjectStatusUpdate,
    ProjectUpdate,
    SupplementLinkCreate,
    SupplementLinkOut,
    WorkStatusUpdate,
)
from app.services import notifications, project_service
from app.services.project_service import MutationResult
from app.services.rules.estimate_totals import compute

router = APIRouter(prefix="/projects", tags=["projects"])


def _schedule(background: BackgroundTasks, result: MutationResult) -> None:
    """Queue whatever notifications the rules engine decided were warranted.

    Centralised so a new endpoint cannot forget to dispatch them — every mutating
    handler ends with this one call.
    """
    for note in result.notifications:
        background.add_task(
            notifications.notify_admins, note.subject, note.template, dict(note.context)
        )


# ── Projects ──────────────────────────────────────────────────────────────────


@router.get("", response_model=Page[ProjectOut])
async def list_projects(
    db: DbSession,
    user: CurrentUser,
    project_status: Annotated[ProjectStatus | None, Query(alias="status")] = None,
    work_status: Annotated[WorkStatus | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> Page[ProjectOut]:
    """List projects, newest first. Members see only projects assigned to them."""
    page = await project_service.list_projects(
        db, user, status=project_status, work_status=work_status, limit=limit, offset=offset
    )
    return Page[ProjectOut](
        items=[ProjectOut.model_validate(p) for p in page.items],
        total=page.total,
        limit=limit,
        offset=offset,
    )


@router.post("", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
async def create_project(
    body: ProjectCreate, db: DbSession, background: BackgroundTasks, actor: Elevated
) -> ProjectOut:
    """Create a project, notifying the assignee if one was named."""
    project, assignee = await project_service.create_project(db, actor, body.model_dump())

    if assignee is not None:
        background.add_task(
            notifications.notify_one,
            assignee.email,
            f"📋 You've been assigned a project — {project.owner_name}",
            "notice.html",
            {
                "badge": "New Project Assigned",
                "tone": "blue",
                "headline": project.owner_name or "New project",
                "body": f"{actor.display_name} has assigned you a new project.",
                "rows": [
                    ("Address", project.address),
                    ("Work Type", project.work_type),
                    ("Budget", f"${project.total_budget:,.2f}"),
                ],
                "cta_url": f"{get_settings().site_url}/projects/{project.id}",
                "cta_label": "Open project",
            },
        )

    return ProjectOut.model_validate(project)


@router.get("/{project_id}", response_model=ProjectDetailOut)
async def get_project(
    db: DbSession,
    project: AccessibleProject,
    include: Annotated[
        str | None,
        Query(
            description=(
                "Comma-separated relations to embed: milestones, supplements, activity. "
                "Omit for the project alone."
            )
        ),
    ] = None,
) -> ProjectDetailOut:
    """Fetch a project, optionally composing related collections in one round trip.

    The detail screen wants all three; the list does not. ``?include=`` lets each
    caller pay only for what it renders, instead of the legacy endpoint's fixed blob
    of project + milestones + supplements + activity on every read.
    """
    wanted = {part.strip() for part in (include or "").split(",") if part.strip()}
    out = ProjectDetailOut(project=ProjectOut.model_validate(project))

    if "milestones" in wanted:
        milestones = await project_service.list_milestones(db, project.id)
        out.milestones = [MilestoneOut.model_validate(m) for m in milestones]

    if "supplements" in wanted:
        links = await project_service.list_supplements(db, project.id)
        out.supplements = [_link_out(link) for link in links]

    if "activity" in wanted:
        entries = await project_service.list_activity(db, project.id)
        out.activity = [ActivityOut.model_validate(a) for a in entries]

    return out


@router.patch("/{project_id}", response_model=ProjectOut)
async def update_project(
    body: ProjectUpdate,
    db: DbSession,
    background: BackgroundTasks,
    actor: Elevated,
    project_id: Annotated[uuid.UUID, Path()],
) -> ProjectOut:
    """Update a project's details, budget, and costs."""
    project = await _load_for_write(db, project_id)
    result = await project_service.update_project(
        db, actor, project, body.model_dump(exclude_unset=True)
    )
    _schedule(background, result)
    return ProjectOut.model_validate(result.project)


@router.patch("/{project_id}/work-status", response_model=ProjectOut)
async def update_work_status(
    body: WorkStatusUpdate,
    db: DbSession,
    background: BackgroundTasks,
    actor: CurrentUser,
    project: AccessibleProject,
) -> ProjectOut:
    """Set where the physical work stands.

    Anyone on the project may do this — it is the field the person actually doing the
    work updates. Moving to ``completed`` may close the project, depending on the
    payment milestones; the rules engine decides.
    """
    result = await project_service.set_work_status(db, actor, project, body.work_status)
    _schedule(background, result)
    return ProjectOut.model_validate(result.project)


@router.patch("/{project_id}/status", response_model=ProjectOut)
async def update_project_status(
    body: ProjectStatusUpdate,
    db: DbSession,
    background: BackgroundTasks,
    actor: Elevated,
    project_id: Annotated[uuid.UUID, Path()],
) -> ProjectOut:
    """Manually set project status. Only ``active`` and ``cancelled`` are settable.

    ``closed`` and ``pending_payment`` are conclusions drawn from the milestones and
    closing forms, so asserting them directly is rejected — see ``ProjectStatusUpdate``.
    """
    project = await _load_for_write(db, project_id)
    result = await project_service.set_project_status(db, actor, project, body.status)
    _schedule(background, result)
    return ProjectOut.model_validate(result.project)


@router.delete("/{project_id}", response_model=Ack)
async def delete_project(
    db: DbSession, actor: Elevated, project_id: Annotated[uuid.UUID, Path()]
) -> Ack:
    """Delete a project and everything hanging off it. Not recoverable."""
    project = await _load_for_write(db, project_id)
    await project_service.delete_project(db, actor, project)
    return Ack()


@router.get("/{project_id}/activity", response_model=list[ActivityOut])
async def list_activity(
    db: DbSession,
    project: AccessibleProject,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[ActivityOut]:
    """The project's audit trail, newest first."""
    rows = await project_service.list_activity(db, project.id, limit=limit, offset=offset)
    return [ActivityOut.model_validate(a) for a in rows]


# ── Milestones ────────────────────────────────────────────────────────────────


@router.get("/{project_id}/milestones", response_model=list[MilestoneOut])
async def list_milestones(db: DbSession, project: AccessibleProject) -> list[MilestoneOut]:
    rows = await project_service.list_milestones(db, project.id)
    return [MilestoneOut.model_validate(m) for m in rows]


@router.post(
    "/{project_id}/milestones",
    response_model=MilestoneOut,
    status_code=status.HTTP_201_CREATED,
)
async def add_milestone(
    body: MilestoneCreate,
    db: DbSession,
    background: BackgroundTasks,
    actor: CurrentUser,
    project: AccessibleProject,
) -> MilestoneOut:
    """Add a payment milestone.

    Adding an unpaid milestone to a closed project reopens it to ``pending_payment``.
    """
    milestone, result = await project_service.add_milestone(db, actor, project, body.model_dump())
    _schedule(background, result)
    return MilestoneOut.model_validate(milestone)


@router.patch("/{project_id}/milestones/{milestone_id}", response_model=MilestoneOut)
async def update_milestone(
    body: MilestoneUpdate,
    db: DbSession,
    background: BackgroundTasks,
    actor: CurrentUser,
    project: AccessibleProject,
    milestone_id: Annotated[uuid.UUID, Path()],
) -> MilestoneOut:
    """Update a milestone, or mark it paid or unpaid.

    Toggling ``paid`` re-derives the project's status in both directions — marking the
    last outstanding payment received can close the project, and un-marking one
    reopens it.
    """
    milestone, result = await project_service.update_milestone(
        db, actor, project, milestone_id, body.model_dump(exclude_unset=True)
    )
    _schedule(background, result)
    return MilestoneOut.model_validate(milestone)


@router.delete("/{project_id}/milestones/{milestone_id}", response_model=Ack)
async def delete_milestone(
    db: DbSession,
    background: BackgroundTasks,
    actor: Elevated,
    project: AccessibleProject,
    milestone_id: Annotated[uuid.UUID, Path()],
) -> Ack:
    result = await project_service.delete_milestone(db, actor, project, milestone_id)
    _schedule(background, result)
    return Ack()


# ── Supplement links ──────────────────────────────────────────────────────────


def _link_out(link: ProjectSupplement) -> SupplementLinkOut:
    """Serialise a link, summarising its estimate with a computed total.

    Built field by field rather than with ``model_validate`` on the whole link: the
    nested ``LinkedEstimate`` carries a computed ``total`` that has no counterpart on
    the ORM object, so validating the relationship directly fails on the missing
    field before there is any chance to supply it.
    """
    estimate = link.estimate
    return SupplementLinkOut(
        id=link.id,
        project_id=link.project_id,
        estimate_id=link.estimate_id,
        linked_by=link.linked_by,
        created_at=link.created_at,
        estimate=(
            LinkedEstimate(
                id=estimate.id,
                identifier=estimate.identifier,
                project_name=estimate.project_name,
                client_name=estimate.client_name,
                status=estimate.status,
                total=compute(estimate.rooms).total,
            )
            if estimate is not None
            else None
        ),
    )


@router.get("/{project_id}/supplements", response_model=list[SupplementLinkOut])
async def list_supplements(db: DbSession, project: AccessibleProject) -> list[SupplementLinkOut]:
    """Estimates raised against this project."""
    links = await project_service.list_supplements(db, project.id)
    return [_link_out(link) for link in links]


@router.post(
    "/{project_id}/supplements",
    response_model=SupplementLinkOut,
    status_code=status.HTTP_201_CREATED,
)
async def link_supplement(
    body: SupplementLinkCreate,
    db: DbSession,
    actor: CurrentUser,
    project: AccessibleProject,
) -> SupplementLinkOut:
    """Link an existing estimate to this project."""
    link = await project_service.link_supplement(db, actor, project, body.estimate_id)
    return _link_out(link)


@router.delete("/{project_id}/supplements/{estimate_id}", response_model=Ack)
async def unlink_supplement(
    db: DbSession,
    actor: CurrentUser,
    project: AccessibleProject,
    estimate_id: Annotated[uuid.UUID, Path()],
) -> Ack:
    await project_service.unlink_supplement(db, actor, project, estimate_id)
    return Ack()


# ── Closing forms ─────────────────────────────────────────────────────────────


@router.put("/{project_id}/closing-forms/{form_number}", response_model=ProjectOut)
async def submit_closing_form(
    body: ClosingFormSubmit,
    db: DbSession,
    background: BackgroundTasks,
    actor: CurrentUser,
    project: AccessibleProject,
    form_number: Annotated[
        int,
        Path(ge=1, le=2, description="1 = Material Sign-Off, 2 = Project Sign-Off"),
    ],
) -> ProjectOut:
    """Submit a closing form.

    Once both forms are in, work is marked complete — and if every payment milestone
    is settled, the project closes. Both consequences are decided by the rules engine,
    not here.
    """
    result, both_submitted = await project_service.submit_closing_form(
        db, actor, project, form_number, body.data
    )

    form_name = project_service.FORM_NAMES[form_number]
    background.add_task(
        notifications.notify_admins,
        f"📋 {form_name} submitted — {project.owner_name}",
        "notice.html",
        {
            "badge": "Closing Form",
            "tone": "amber" if not both_submitted else "green",
            "headline": f"{form_name} submitted",
            "body": (
                f"Submitted by {actor.display_name}. Both closing forms are now complete."
                if both_submitted
                else f"Submitted by {actor.display_name}. The second closing form is still pending."
            ),
            "rows": [
                ("Project", project.owner_name),
                ("Address", project.address),
                ("Work Status", project.work_status),
            ],
        },
    )
    _schedule(background, result)

    return ProjectOut.model_validate(result.project)


# ── Helpers ───────────────────────────────────────────────────────────────────


async def _load_for_write(db: DbSession, project_id: uuid.UUID) -> Project:
    """Load a project for an owner/admin-only write.

    ``AccessibleProject`` cannot be used on these routes: it depends on
    ``CurrentUser``, which would admit members. The elevated guard on the handler has
    already run, so only existence needs checking here.
    """
    project = await db.get(Project, project_id)
    if project is None:
        raise NotFound("Project not found.")
    return project
