"""Team-management permission rules.

Role assignment and member removal carry a surprising number of edge cases — the
legacy ``users.js`` accumulated eight separate guards inline. They are gathered here so
the whole matrix is visible in one place and testable without a database.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from app.models.enums import ELEVATED_ROLES, Role

#: How long the link in an invitation email stays usable. Long enough to survive a
#: weekend in someone's inbox, short enough that a forwarded or leaked email goes stale.
INVITATION_TTL = timedelta(days=7)

# ── Snapshot ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class UserSnapshot:
    id: uuid.UUID
    role: Role

    @property
    def is_owner(self) -> bool:
        return self.role == Role.OWNER

    @property
    def is_elevated(self) -> bool:
        return self.role in ELEVATED_ROLES


# ── Results ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Decision:
    """Allowed, or refused with a reason the API can show the user verbatim."""

    allowed: bool
    reason: str = ""

    def __bool__(self) -> bool:
        return self.allowed


ALLOWED = Decision(allowed=True)


def _refuse(reason: str) -> Decision:
    return Decision(allowed=False, reason=reason)


# ── Rules ─────────────────────────────────────────────────────────────────────


def can_assign_role(actor: UserSnapshot, target: UserSnapshot, new_role: Role) -> Decision:
    """Whether ``actor`` may set ``target``'s role to ``new_role``.

    The constraints, in the order they are checked:

    * Only owners and admins manage roles at all.
    * Nobody changes their own role — that is the guard against an admin
      self-promoting to owner, and against the last owner accidentally demoting
      themselves and locking the team out.
    * Only an owner may grant the owner role.
    * Only an owner may change the role of an existing owner.
    """
    if not actor.is_elevated:
        return _refuse("Only owners and admins can change roles.")
    if actor.id == target.id:
        return _refuse("You cannot change your own role.")
    if new_role == Role.OWNER and not actor.is_owner:
        return _refuse("Only owners can assign the owner role.")
    if target.is_owner and not actor.is_owner:
        return _refuse("Only owners can change another owner's role.")
    return ALLOWED


def can_remove_user(actor: UserSnapshot, target: UserSnapshot) -> Decision:
    """Whether ``actor`` may remove (ban) ``target``.

    Owners are unremovable through the API. Demote first, deliberately, and only an
    owner can do that — which makes locking the team out of its own account a
    two-step, owner-only act rather than one click.
    """
    if not actor.is_elevated:
        return _refuse("Only owners and admins can remove members.")
    if actor.id == target.id:
        return _refuse("You cannot remove yourself.")
    if target.is_owner:
        return _refuse("The owner cannot be removed.")
    if actor.role == Role.ADMIN and target.role != Role.MEMBER:
        return _refuse("Admins can only remove members.")
    return ALLOWED


def can_invite_user(actor: UserSnapshot, role: Role) -> Decision:
    """Whether ``actor`` may add someone to the team with ``role``.

    The same ceiling as ``can_assign_role``, for the same reason: inviting someone as an
    owner *is* granting ownership, so it must not be a way round the rule that only an
    owner does that. Resending and revoking an invitation are checked against the
    invitation's own role, so an admin cannot manage an owner invitation either.
    """
    if not actor.is_elevated:
        return _refuse("Only owners and admins can add people to the team.")
    if role == Role.OWNER and not actor.is_owner:
        return _refuse("Only owners can invite another owner.")
    return ALLOWED


def invitation_is_live(invited_at: datetime | None, now: datetime) -> bool:
    """Whether an invitation sent at ``invited_at`` can still be accepted by its link.

    Both arguments must be timezone-aware; the caller owns the clock.
    """
    if invited_at is None:
        return False
    return now - invited_at <= INVITATION_TTL


def can_review_approval_requests(actor: UserSnapshot) -> Decision:
    """Whether ``actor`` may approve or deny a removed user's request to return."""
    if not actor.is_elevated:
        return _refuse("Only owners and admins can review access requests.")
    return ALLOWED


def initial_role_for_new_user(*, is_first_user: bool) -> Role:
    """The role a brand-new profile gets.

    The very first person to sign in owns the workspace; everyone after them starts as
    a member. Under Supabase this lived in the ``handle_new_user()`` database trigger,
    which does not survive the move to Firebase Auth — the logic moves here, into the
    sign-in provisioning path.
    """
    return Role.OWNER if is_first_user else Role.MEMBER
