/**
 * Project permissions and the status-derivation rules.
 *
 * A port of `apps/api/app/services/rules/project_rules.py` plus the authorisation each
 * project route declares, kept structurally identical so the two read side by side.
 *
 * **This gates UI affordances and explanations only.** The backend re-decides every one
 * of these and is the sole authority. Its job here is twofold: avoid offering a control
 * that would come back 403 or 404, and let the screen *explain* why a project's status
 * is what it is — "closed once every milestone is paid" is far more useful than a badge
 * that changes on its own with no stated cause.
 */
import type { ProjectStatus, Role, WorkStatus } from "./enums";
import { isElevated } from "./enums";
import type { ActorSnapshot } from "./estimateRules";

export type { ActorSnapshot };

export interface MilestoneSnapshot {
  paid: boolean;
}

/** Everything the rules need, and nothing else. Mirrors `ProjectSnapshot`. */
export interface ProjectSnapshot {
  workStatus: WorkStatus;
  status: ProjectStatus;
  hasClosingForm1: boolean;
  hasClosingForm2: boolean;
  milestones: readonly MilestoneSnapshot[];
  assignedTo: string | null;
}

export function bothClosingFormsSubmitted(project: ProjectSnapshot): boolean {
  return project.hasClosingForm1 && project.hasClosingForm2;
}

/**
 * A project with no milestones counts as fully paid.
 *
 * Matches the legacy `!milestones?.length || milestones.every(m => m.paid)`: a job with
 * no payment schedule recorded should not be held open for ever waiting on payments
 * that were never scheduled.
 */
export function allMilestonesPaid(project: ProjectSnapshot): boolean {
  return project.milestones.every((milestone) => milestone.paid);
}

// ── Derivation ──────────────────────────────────────────────────────────────

export interface DerivedState {
  workStatus: WorkStatus;
  status: ProjectStatus;
  /** Why, in one sentence, for the UI to show beside the badge. */
  reason: string;
}

/**
 * What the backend's rules engine will conclude, given these facts.
 *
 * The API returns the updated project after every mutation, so this is never the source
 * of truth — it exists so the screen can say what *will* happen before someone clicks,
 * and explain a status that appears to have changed by itself.
 *
 * Mirrors `project_rules.evaluate`, including the ordering: cancellation short-circuits
 * everything, then closing forms decide work status, then work status and milestones
 * decide the engagement status.
 */
export function deriveProjectState(project: ProjectSnapshot): DerivedState {
  // Rule 5: cancellation is a human decision and no automatic rule may override it.
  if (project.status === "cancelled") {
    return {
      workStatus: project.workStatus,
      status: "cancelled",
      reason: "Cancelled. No automatic rule will change this.",
    };
  }

  // Rule 1: both forms in ⇒ work complete.
  const workStatus: WorkStatus = bothClosingFormsSubmitted(project)
    ? "completed"
    : project.workStatus;

  // Rules 2–4.
  if (workStatus !== "completed") {
    return {
      workStatus,
      status: "active",
      reason: "Active while the work is not yet completed.",
    };
  }

  if (allMilestonesPaid(project)) {
    return {
      workStatus,
      status: "closed",
      reason:
        project.milestones.length === 0
          ? "Closed: the work is complete and no payment milestones were scheduled."
          : "Closed: the work is complete and every milestone is paid.",
    };
  }

  const outstanding = project.milestones.filter((milestone) => !milestone.paid).length;
  return {
    workStatus,
    status: "pending_payment",
    reason: `Awaiting payment: the work is complete but ${outstanding} ${
      outstanding === 1 ? "milestone is" : "milestones are"
    } unpaid.`,
  };
}

// ── Access ──────────────────────────────────────────────────────────────────

/**
 * Whether this project is visible at all.
 *
 * Mirrors `require_project_access`, which returns **404** rather than 403 for a member
 * who is not assigned — the project's existence is itself privileged.
 */
export function canAccess(actor: ActorSnapshot, project: ProjectSnapshot): boolean {
  if (isElevated(actor.role)) return true;
  return project.assignedTo === actor.id;
}

const ELEVATED_ONLY = (actor: ActorSnapshot): boolean => isElevated(actor.role);

/** Creating, editing details, cancelling, and deleting are all owner/admin. */
export const canCreateProject = ELEVATED_ONLY;
export const canEditProject = ELEVATED_ONLY;
export const canDeleteProject = ELEVATED_ONLY;
/** `PATCH /projects/{id}/status` — and only to a settable value, see enums.ts. */
export const canSetProjectStatus = ELEVATED_ONLY;
/** `DELETE /projects/{id}/milestones/{id}` is elevated; adding and paying are not. */
export const canDeleteMilestone = ELEVATED_ONLY;

/**
 * Advancing the work is open to anyone assigned.
 *
 * This is the crew's own progress, and requiring an admin to record it is how a status
 * board stops matching reality.
 */
export function canChangeWorkStatus(actor: ActorSnapshot, project: ProjectSnapshot): boolean {
  return canAccess(actor, project);
}

export function canManageMilestones(actor: ActorSnapshot, project: ProjectSnapshot): boolean {
  return canAccess(actor, project);
}

export function canLinkSupplements(actor: ActorSnapshot, project: ProjectSnapshot): boolean {
  return canAccess(actor, project);
}

export function canSubmitClosingForms(actor: ActorSnapshot, project: ProjectSnapshot): boolean {
  return canAccess(actor, project);
}

// ── Work status ─────────────────────────────────────────────────────────────

/**
 * The stepper's order.
 *
 * `on_hold` sits outside the sequence deliberately: it is a state a project enters from
 * anywhere and leaves back to where it was, not a stage between two others. Rendering it
 * inline would imply every project passes through it.
 */
export const WORK_STATUS_SEQUENCE: readonly WorkStatus[] = [
  "contract_sent",
  "contract_not_signed",
  "contract_signed",
  "start_date",
  "in_progress",
  "completed",
];

export const WORK_STATUS_ASIDE: readonly WorkStatus[] = ["on_hold"];

/** Index within the sequence, or -1 for `on_hold`. Drives which steps look done. */
export function workStatusIndex(status: WorkStatus): number {
  return WORK_STATUS_SEQUENCE.indexOf(status);
}

/** Roles used only for the type export above; keeps the import honest. */
export type { Role };
