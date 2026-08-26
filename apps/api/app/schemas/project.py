"""Project, milestone, supplement-link, and activity schemas."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any

from pydantic import Field, model_validator

from app.models.enums import ProjectStatus, WorkStatus
from app.schemas.common import ActorRef, ORMSchema, Schema

Money = Annotated[Decimal, Field(ge=0, max_digits=12, decimal_places=2)]


# ── Projects ──────────────────────────────────────────────────────────────────


class ProjectCreate(Schema):
    owner_name: str = Field(default="", max_length=300)
    address: str = Field(default="", max_length=500)
    work_type: str = Field(default="", max_length=200)
    start_date: date | None = None
    notes: str = Field(default="", max_length=20_000)
    assigned_to: uuid.UUID | None = None
    total_budget: Money = Decimal("0")


class ProjectUpdate(Schema):
    """Partial update of a project's details.

    ``work_status`` and ``status`` are absent: they move through their own endpoints so
    the rules engine runs on every change. Nothing else is permitted to set them.
    """

    owner_name: str | None = Field(default=None, max_length=300)
    address: str | None = Field(default=None, max_length=500)
    work_type: str | None = Field(default=None, max_length=200)
    start_date: date | None = None
    notes: str | None = Field(default=None, max_length=20_000)
    assigned_to: uuid.UUID | None = None
    total_budget: Money | None = None
    labor_cost: Money | None = None
    materials_cost: Money | None = None
    reimbursements: Money | None = None
    amount_collected: Money | None = None


class WorkStatusUpdate(Schema):
    work_status: WorkStatus


class ProjectStatusUpdate(Schema):
    """Manual status override.

    Only ``active`` and ``cancelled`` are settable by hand. ``closed`` and
    ``pending_payment`` are conclusions the rules engine reaches from the facts — being
    able to assert them directly would let the stored status contradict the milestones
    and closing forms that are supposed to determine it.
    """

    status: ProjectStatus

    @model_validator(mode="after")
    def _only_manual_statuses(self) -> ProjectStatusUpdate:
        manual = {ProjectStatus.ACTIVE, ProjectStatus.CANCELLED}
        if self.status not in manual:
            raise ValueError(
                f"{self.status.value!r} is derived from milestones and closing forms "
                "and cannot be set directly. Settable values: "
                + ", ".join(sorted(s.value for s in manual))
            )
        return self


class ProjectOut(ORMSchema):
    id: uuid.UUID
    owner_name: str
    address: str
    work_type: str
    start_date: date | None = None
    notes: str

    work_status: WorkStatus
    status: ProjectStatus

    total_budget: Decimal
    labor_cost: Decimal
    materials_cost: Decimal
    reimbursements: Decimal
    amount_collected: Decimal
    #: Collected minus costs. Derived on read.
    profit: Decimal

    assigned_to: uuid.UUID | None = None
    assignee: ActorRef | None = None
    created_by: uuid.UUID | None = None
    creator: ActorRef | None = None

    closing_form_1: dict[str, Any] | None = None
    closing_form_2: dict[str, Any] | None = None
    closing_form_submitted_at: datetime | None = None

    created_at: datetime
    updated_at: datetime


# ── Milestones ────────────────────────────────────────────────────────────────


class MilestoneCreate(Schema):
    label: str = Field(min_length=1, max_length=300)
    amount: Money = Decimal("0")
    due_date: date | None = None
    notes: str = Field(default="", max_length=2000)


class MilestoneUpdate(Schema):
    """Partial update. Setting ``paid`` in either direction re-runs the rules engine."""

    label: str | None = Field(default=None, min_length=1, max_length=300)
    amount: Money | None = None
    due_date: date | None = None
    notes: str | None = Field(default=None, max_length=2000)
    paid: bool | None = None


class MilestoneOut(ORMSchema):
    id: uuid.UUID
    project_id: uuid.UUID
    label: str
    amount: Decimal
    due_date: date | None = None
    notes: str
    paid: bool
    paid_at: datetime | None = None
    paid_by: uuid.UUID | None = None
    created_at: datetime


# ── Supplement links ──────────────────────────────────────────────────────────


class SupplementLinkCreate(Schema):
    estimate_id: uuid.UUID


class LinkedEstimate(ORMSchema):
    """The estimate summary shown on a project's supplements tab."""

    id: uuid.UUID
    identifier: str
    project_name: str
    client_name: str
    status: str
    total: Decimal


class SupplementLinkOut(ORMSchema):
    id: uuid.UUID
    project_id: uuid.UUID
    estimate_id: uuid.UUID
    linked_by: uuid.UUID | None = None
    linked_at: datetime
    estimate: LinkedEstimate | None = None


# ── Activity ──────────────────────────────────────────────────────────────────


class ActivityOut(ORMSchema):
    id: uuid.UUID
    project_id: uuid.UUID
    user_id: uuid.UUID | None = None
    user_name: str
    action: str
    details: str
    created_at: datetime


# ── Closing forms ─────────────────────────────────────────────────────────────


class ClosingFormSubmit(Schema):
    """Form 1 is the Material Sign-Off, form 2 the Project Sign-Off.

    ``data`` is intentionally free-form: the forms are still evolving and the backend
    treats their contents as an opaque record. What matters structurally is only
    whether each form is present, which is what drives the work-status transition.
    """

    data: dict[str, Any]


class ClosingFormPhotoUploadRequest(Schema):
    """Step 1 of the Material Sign-Off photo upload.

    The returned ``storage_path`` is what belongs in the form's ``material_photo_path``
    field when the form is submitted.
    """

    file_name: str = Field(min_length=1, max_length=500)
    content_type: str = Field(min_length=1, max_length=200)


class ProjectDetailOut(ORMSchema):
    """Composed view for a project detail screen, via ``?include=``.

    Saves a round trip without forcing every caller to pay for relations they do not
    need — the list view, for instance, wants none of these.
    """

    project: ProjectOut
    milestones: list[MilestoneOut] | None = None
    supplements: list[SupplementLinkOut] | None = None
    activity: list[ActivityOut] | None = None
