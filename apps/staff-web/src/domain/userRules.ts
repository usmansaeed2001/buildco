/**
 * Who may change whose role, and who may be removed.
 *
 * A port of `apps/api/app/services/rules/user_rules.py`, kept structurally identical so
 * the two read side by side. **This gates UI affordances only** — the backend re-decides
 * every one of these and is the sole authority. Its job is to avoid offering a control
 * that comes back 403, which is a worse experience than not offering it.
 *
 * The refusal reasons are carried through rather than discarded: on a team screen the
 * useful thing is not a hidden button but a disabled one that says why.
 */
import { ROLES, isElevated, type Role } from "./enums";

export interface UserSnapshot {
  id: string;
  role: Role;
}

export interface Decision {
  allowed: boolean;
  /** Empty when allowed. */
  reason: string;
}

const ALLOWED: Decision = { allowed: true, reason: "" };

function refuse(reason: string): Decision {
  return { allowed: false, reason };
}

function isOwner(user: UserSnapshot): boolean {
  return user.role === "owner";
}

/**
 * Whether `actor` may set `target`'s role to `newRole`.
 *
 * The constraints, in the order the backend checks them:
 *
 * - Only owners and admins manage roles at all.
 * - Nobody changes their own role — the guard against an admin self-promoting, and
 *   against the last owner demoting themselves and locking the team out.
 * - Only an owner may grant the owner role.
 * - Only an owner may change an existing owner's role.
 */
export function canAssignRole(
  actor: UserSnapshot,
  target: UserSnapshot,
  newRole: Role,
): Decision {
  if (!isElevated(actor.role)) return refuse("Only owners and admins can change roles.");
  if (actor.id === target.id) return refuse("You cannot change your own role.");
  if (newRole === "owner" && !isOwner(actor)) {
    return refuse("Only owners can assign the owner role.");
  }
  if (isOwner(target) && !isOwner(actor)) {
    return refuse("Only owners can change another owner's role.");
  }
  return ALLOWED;
}

/**
 * Whether `actor` may remove `target`.
 *
 * Owners are unremovable through the API: demote first, deliberately, and only an owner
 * can do that — which makes locking the team out of its own account a two-step,
 * owner-only act rather than one click.
 */
export function canRemoveUser(actor: UserSnapshot, target: UserSnapshot): Decision {
  if (!isElevated(actor.role)) return refuse("Only owners and admins can remove members.");
  if (actor.id === target.id) return refuse("You cannot remove yourself.");
  if (isOwner(target)) return refuse("The owner cannot be removed.");
  if (actor.role === "admin" && target.role !== "member") {
    return refuse("Admins can only remove members.");
  }
  return ALLOWED;
}

export function canReviewApprovalRequests(actor: UserSnapshot): Decision {
  if (!isElevated(actor.role)) {
    return refuse("Only owners and admins can review access requests.");
  }
  return ALLOWED;
}

/** The roles `actor` may assign to `target`, for building a dropdown that cannot 403. */
export function assignableRoles(actor: UserSnapshot, target: UserSnapshot): Role[] {
  return ROLES.filter((role) => canAssignRole(actor, target, role).allowed);
}
