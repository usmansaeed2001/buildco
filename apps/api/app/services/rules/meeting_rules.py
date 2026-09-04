"""Who may see and change a meeting.

Until now the calendar was shared: ``GET /meetings`` was not filtered at all, and
creating, editing and cancelling were flatly elevated-only. Both halves have changed —
a meeting is now visible to its creator, its attendees, and any owner or admin, and
anyone may schedule one but only its creator (or an elevated user) may change it.

That is a matrix over *(actor role, actor identity, meeting creator, attendee list)*
rather than a single condition, which is why it is here rather than inline in the
service — see DEVELOPMENT_GUIDELINES §1. Pure functions over snapshots, so the whole
matrix is testable in milliseconds with no database.

The list query is the deliberate exception. Filtering a `SELECT` by scope is one
condition appended to a `where`, and expressing it as a rule would mean the rule
returning SQL — so it stays in ``meeting_service.list_meetings``, exactly as
``project_service.list_projects`` already scopes a member to their own projects.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from app.models.enums import ELEVATED_ROLES, Role

# ── Snapshots ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class ActorSnapshot:
    id: uuid.UUID
    role: Role

    @property
    def is_elevated(self) -> bool:
        return self.role in ELEVATED_ROLES


@dataclass(frozen=True, slots=True)
class MeetingSnapshot:
    #: ``None`` when the creator's profile has been deleted — the FK is SET NULL, so an
    #: orphaned meeting is a real state and must not be treated as "created by nobody,
    #: therefore mine".
    created_by: uuid.UUID | None
    attendee_ids: frozenset[uuid.UUID] = field(default_factory=frozenset)


# ── Rules ─────────────────────────────────────────────────────────────────────


def can_view(actor: ActorSnapshot, meeting: MeetingSnapshot) -> bool:
    """Whether this meeting should appear to this person at all.

    Owners and admins see everything: they schedule on behalf of the team and answer for
    the calendar when something is double-booked.

    Everyone else sees what they created and what they were invited to. An attendee must
    see the meeting — they were emailed an invite for it, so hiding it in the app would
    only make the app the least useful place to look.
    """
    if actor.is_elevated:
        return True
    if meeting.created_by is not None and meeting.created_by == actor.id:
        return True
    return actor.id in meeting.attendee_ids


def can_manage(actor: ActorSnapshot, meeting: MeetingSnapshot) -> bool:
    """Whether this person may edit or cancel it.

    Narrower than ``can_view`` on purpose: being invited to a meeting does not make it
    yours to move. An attendee who could change the time could re-invite everyone else
    from an account nobody expected it from.
    """
    if actor.is_elevated:
        return True
    return meeting.created_by is not None and meeting.created_by == actor.id
