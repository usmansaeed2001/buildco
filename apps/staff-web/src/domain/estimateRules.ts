/**
 * Estimate permissions and the status state machine.
 *
 * A port of `apps/api/app/services/rules/estimate_rules.py`, kept structurally
 * identical so the two can be read side by side.
 *
 * **This gates UI affordances only.** The backend re-decides every one of these on
 * every request and is the sole authority; nothing here is a security boundary. Its
 * job is to avoid offering a button that would come back 403 — which is a worse
 * experience than not showing the button at all.
 */
import type { EstimateStatus, Role } from "./enums";
import { isElevated } from "./enums";

/** The acting user, reduced to what permission decisions depend on. */
export interface ActorSnapshot {
  id: string;
  role: Role;
}

export interface EstimateSnapshot {
  status: EstimateStatus;
  createdBy: string | null;
  isTrashed: boolean;
}

export type TransitionAction =
  | "archive"
  | "unarchive"
  | "lock"
  | "unlock"
  | "recall"
  | "resubmit_ready"
  | "admin_approve";

export interface Transition {
  action: TransitionAction;
  target: EstimateStatus;
  allowedRoles: readonly Role[];
  /** Whether performing this invalidates an outstanding reviewer link. */
  clearsApprovalToken: boolean;
  /** Button copy. */
  label: string;
  description: string;
}

const ELEVATED: readonly Role[] = ["owner", "admin"];
const EVERYONE: readonly Role[] = ["owner", "admin", "member"];

/** Mirrors `TRANSITIONS`. */
export const TRANSITIONS: Record<TransitionAction, Transition> = {
  archive: {
    action: "archive",
    target: "archived",
    allowedRoles: ELEVATED,
    clearsApprovalToken: false,
    label: "Archive",
    description: "Move the estimate out of the active list.",
  },
  unarchive: {
    action: "unarchive",
    target: "active",
    allowedRoles: ELEVATED,
    clearsApprovalToken: false,
    label: "Unarchive",
    description: "Return an archived estimate to the active list.",
  },
  lock: {
    action: "lock",
    target: "locked",
    allowedRoles: ["owner"],
    clearsApprovalToken: false,
    label: "Lock",
    description: "Freeze the estimate. Only the owner can lock or unlock.",
  },
  unlock: {
    action: "unlock",
    target: "active",
    allowedRoles: ["owner"],
    clearsApprovalToken: false,
    label: "Unlock",
    description: "Release a locked estimate for editing.",
  },
  recall: {
    action: "recall",
    target: "active",
    allowedRoles: EVERYONE,
    clearsApprovalToken: true,
    label: "Recall",
    description: "Withdraw a submitted estimate and invalidate the reviewer's link.",
  },
  resubmit_ready: {
    action: "resubmit_ready",
    target: "active",
    allowedRoles: EVERYONE,
    clearsApprovalToken: true,
    label: "Edit & Resubmit",
    description: "Reopen an estimate that came back with requested changes.",
  },
  admin_approve: {
    action: "admin_approve",
    target: "approved",
    allowedRoles: ELEVATED,
    clearsApprovalToken: false,
    label: "Approve",
    description: "Approve internally, without waiting on the external reviewer.",
  },
};

/** Statuses an estimate may be sent for external review from. */
export const SUBMITTABLE_FROM: readonly EstimateStatus[] = [
  "active",
  "changes_requested",
  "rejected",
];

/** Statuses a reviewer has already decided on. */
export const TERMINAL_REVIEW_STATUSES: readonly EstimateStatus[] = ["approved", "rejected"];

// ── Predicates ──────────────────────────────────────────────────────────────

/** Members see only their own estimates. */
export function canView(actor: ActorSnapshot, estimate: EstimateSnapshot): boolean {
  if (isElevated(actor.role)) return true;
  return estimate.createdBy === actor.id;
}

/**
 * Who may change an estimate's contents.
 *
 * A locked estimate is editable by the owner alone; that outranks every other rule.
 *
 * Note this is more permissive than the legacy UI, which froze editing unless the
 * status was exactly `active`. The backend has never enforced that, so the old
 * behaviour was disabling actions the API would have accepted. Following the backend.
 */
export function canEdit(actor: ActorSnapshot, estimate: EstimateSnapshot): boolean {
  if (estimate.status === "locked") return actor.role === "owner";
  return canView(actor, estimate);
}

export function canSoftDelete(actor: ActorSnapshot, estimate: EstimateSnapshot): boolean {
  return isElevated(actor.role) || estimate.createdBy === actor.id;
}

/** Never a member, even for their own estimate. */
export function canPermanentlyDelete(actor: ActorSnapshot): boolean {
  return isElevated(actor.role);
}

export function canRestore(actor: ActorSnapshot): boolean {
  return isElevated(actor.role);
}

/** Submitting freezes the document behind an approval link, so it follows editing. */
export function canSubmitForReview(actor: ActorSnapshot, estimate: EstimateSnapshot): boolean {
  return canEdit(actor, estimate);
}

/** Whether the current status permits sending for review at all. */
export function canBeSubmitted(estimate: EstimateSnapshot): boolean {
  return SUBMITTABLE_FROM.includes(estimate.status);
}

// ── Transition resolution ───────────────────────────────────────────────────

export function isTransitionAllowed(action: TransitionAction, actor: ActorSnapshot): boolean {
  return TRANSITIONS[action].allowedRoles.includes(actor.role);
}

/**
 * Which actions to offer for an estimate in its current state.
 *
 * Combines three things the backend keeps separate: the role check from `TRANSITIONS`,
 * whether the transition would be a no-op from here, and whether the estimate is in the
 * trash. Returning them in a fixed order keeps the toolbar from reshuffling as status
 * changes.
 */
export function availableTransitions(
  actor: ActorSnapshot,
  estimate: EstimateSnapshot,
): Transition[] {
  if (estimate.isTrashed) return [];

  const relevant: TransitionAction[] = [];
  switch (estimate.status) {
    case "active":
      relevant.push("admin_approve", "lock", "archive");
      break;
    case "submitted":
      relevant.push("recall", "admin_approve");
      break;
    case "changes_requested":
      relevant.push("resubmit_ready", "admin_approve");
      break;
    case "rejected":
      relevant.push("admin_approve", "archive");
      break;
    case "approved":
      relevant.push("archive");
      break;
    case "archived":
      relevant.push("unarchive");
      break;
    case "locked":
      relevant.push("unlock");
      break;
  }

  return relevant
    .filter((action) => isTransitionAllowed(action, actor))
    .map((action) => TRANSITIONS[action]);
}
