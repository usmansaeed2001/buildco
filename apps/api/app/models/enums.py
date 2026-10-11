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


class MeetingScope(StrEnum):
    """Whose meetings a calendar request is asking for.

    Not persisted — a request-time filter. It lives here because this module is where
    every enum in the backend lives, and splitting "enums we store" from "enums we
    validate" would mean looking in two places to answer the same question.
    """

    MINE = "mine"
    INVITED = "invited"
    ALL = "all"


class EstimateSort(StrEnum):
    """How to order a page of estimates.

    Not persisted — a request-time parameter, living here because this module is where
    every enum lives. The API's first sort parameter: until now every list endpoint
    hardcoded its own order.
    """

    RECENTLY_CREATED = "recently_created"
    RECENTLY_EDITED = "recently_edited"
    HIGHEST_TOTAL = "highest_total"
    CLIENT_NAME = "client_name"


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


# ── BuildCo Assistant ─────────────────────────────────────────────────────────


class AgentConversationStatus(StrEnum):
    #: Created, ticket issued, socket not yet connected.
    PENDING = "pending"
    ACTIVE = "active"
    ENDED = "ended"


class AgentEndReason(StrEnum):
    USER_CLOSED = "user_closed"
    IDLE_TIMEOUT = "idle_timeout"
    TIME_LIMIT = "time_limit"
    DISCONNECTED = "disconnected"
    #: The same person started another conversation, for instance in a second tab.
    SUPERSEDED = "superseded"
    ERROR = "error"


class AgentMessageRole(StrEnum):
    USER = "user"
    ASSISTANT = "assistant"


class AgentMessageSource(StrEnum):
    VOICE = "voice"
    TEXT = "text"


class AgentActionStatus(StrEnum):
    #: Staged on screen and waiting for the user's answer.
    PROPOSED = "proposed"
    COMMITTED = "committed"
    #: The user said no.
    CANCELLED = "cancelled"
    #: Replaced by a corrected proposal before it was answered.
    SUPERSEDED = "superseded"
    EXPIRED = "expired"
    #: The user pressed Stop and carried on with the form by hand.
    HANDED_OVER = "handed_over"
    FAILED = "failed"


class AgentApprovalPolicy(StrEnum):
    VOICE_OR_CLICK = "voice_or_click"
    #: Outward-facing, or its read-back could not be verified: only the button counts.
    CLICK = "click"


class AgentApprovedVia(StrEnum):
    VOICE = "voice"
    CLICK = "click"


class AgentMemoryCategory(StrEnum):
    IDENTITY = "identity"
    PREFERENCE = "preference"
    WORK_HABIT = "work_habit"


class AgentMemorySource(StrEnum):
    #: The user asked for it to be remembered.
    EXPLICIT = "explicit"
    #: The assistant noticed it.
    INFERRED = "inferred"


def values(enum_cls: type[StrEnum]) -> list[str]:
    """The raw string values of an enum — for CHECK constraints and Alembic."""
    return [member.value for member in enum_cls]
