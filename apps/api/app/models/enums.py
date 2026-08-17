"""Domain enumerations.

These are stored as plain ``text`` columns with a CHECK constraint rather than
Postgres ``ENUM`` types. Adding a value to a Postgres enum inside a transaction is
awkward and the legacy schema already used text + CHECK, so this keeps migrations
simple and the data identical to what transfers over from Supabase.
"""

from __future__ import annotations

from enum import StrEnum


class Role(StrEnum):
    OWNER = "owner"
    ADMIN = "admin"
    MEMBER = "member"


#: Roles with team-wide authority. Used pervasively by the guards.
ELEVATED_ROLES: frozenset[Role] = frozenset({Role.OWNER, Role.ADMIN})


class UserStatus(StrEnum):
    ACTIVE = "active"
    BANNED = "banned"


class EstimateStatus(StrEnum):
    ACTIVE = "active"
    ARCHIVED = "archived"
    LOCKED = "locked"
    SUBMITTED = "submitted"
    APPROVED = "approved"
    REJECTED = "rejected"
    CHANGES_REQUESTED = "changes_requested"


class WorkStatus(StrEnum):
    """Where the physical work stands. Ordered roughly as the job progresses."""

    CONTRACT_SENT = "contract_sent"
    CONTRACT_NOT_SIGNED = "contract_not_signed"
    CONTRACT_SIGNED = "contract_signed"
    START_DATE = "start_date"
    IN_PROGRESS = "in_progress"
    ON_HOLD = "on_hold"
    COMPLETED = "completed"


WORK_STATUS_LABELS: dict[WorkStatus, str] = {
    WorkStatus.CONTRACT_SENT: "Contract Sent",
    WorkStatus.CONTRACT_NOT_SIGNED: "Contract Not Signed",
    WorkStatus.CONTRACT_SIGNED: "Contract Signed",
    WorkStatus.START_DATE: "Start Date Set",
    WorkStatus.IN_PROGRESS: "In Progress",
    WorkStatus.ON_HOLD: "On Hold",
    WorkStatus.COMPLETED: "Completed",
}


class ProjectStatus(StrEnum):
    """Where the *engagement* stands — distinct from the work itself."""

    ACTIVE = "active"
    PENDING_PAYMENT = "pending_payment"
    CLOSED = "closed"
    CANCELLED = "cancelled"


class ApprovalRequestStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    DENIED = "denied"


class ItemCategory(StrEnum):
    DRYWALL = "drywall"
    FLOORING = "flooring"
    TRIM = "trim"
    PAINTING = "painting"
    CUSTOM = "custom"
    OTHER = "other"


class ItemUnit(StrEnum):
    LF = "LF"
    SF = "SF"
    EA = "Ea"
    QTY = "Qty"
    SQ = "Sq"


def values(enum_cls: type[StrEnum]) -> list[str]:
    """The raw string values of an enum — for CHECK constraints and Alembic."""
    return [member.value for member in enum_cls]
