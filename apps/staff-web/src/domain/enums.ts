/**
 * Domain enumerations and their display labels.
 *
 * Values mirror `apps/api/app/models/enums.py` exactly — they are stored as `text` with
 * a CHECK constraint, so a typo here is a 422 from the API rather than a type error at
 * build time. The `satisfies` assertions below are what turn that into a build error
 * instead: every enum member must have a label, and no label may name a value that
 * does not exist.
 */

export const ROLES = ["owner", "admin", "member"] as const;
export type Role = (typeof ROLES)[number];

/** Roles with team-wide authority. Mirrors `ELEVATED_ROLES`. */
export function isElevated(role: Role | undefined | null): boolean {
  return role === "owner" || role === "admin";
}

export const USER_STATUSES = ["active", "banned"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const ESTIMATE_STATUSES = [
  "active",
  "archived",
  "locked",
  "submitted",
  "approved",
  "rejected",
  "changes_requested",
] as const;
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];

export const ESTIMATE_STATUS_LABELS = {
  active: "Active",
  archived: "Archived",
  locked: "Locked",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
  changes_requested: "Changes Requested",
} as const satisfies Record<EstimateStatus, string>;

/** Order the filter chips appear in, matching the legacy list view. */
export const ESTIMATE_FILTER_ORDER: EstimateStatus[] = [
  "active",
  "submitted",
  "changes_requested",
  "approved",
  "rejected",
  "archived",
];

export const WORK_STATUSES = [
  "contract_sent",
  "contract_not_signed",
  "contract_signed",
  "start_date",
  "in_progress",
  "on_hold",
  "completed",
] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

/** Verbatim from `WORK_STATUS_LABELS` in enums.py. */
export const WORK_STATUS_LABELS = {
  contract_sent: "Contract Sent",
  contract_not_signed: "Contract Not Signed",
  contract_signed: "Contract Signed",
  start_date: "Start Date Set",
  in_progress: "In Progress",
  on_hold: "On Hold",
  completed: "Completed",
} as const satisfies Record<WorkStatus, string>;

export const PROJECT_STATUSES = ["active", "pending_payment", "closed", "cancelled"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STATUS_LABELS = {
  active: "Active",
  pending_payment: "Pending Payment",
  closed: "Closed",
  cancelled: "Cancelled",
} as const satisfies Record<ProjectStatus, string>;

/**
 * The only two statuses a client may set.
 *
 * `closed` and `pending_payment` are derived by `project_rules` from work status and
 * milestone payment, and `ProjectStatusUpdate` rejects them with a 422. The UI must
 * offer these two alone.
 */
export const SETTABLE_PROJECT_STATUSES: ProjectStatus[] = ["active", "cancelled"];

export const APPROVAL_REQUEST_STATUSES = ["pending", "approved", "denied"] as const;
export type ApprovalRequestStatus = (typeof APPROVAL_REQUEST_STATUSES)[number];

export const ITEM_CATEGORIES = [
  "drywall",
  "flooring",
  "trim",
  "painting",
  "custom",
  "other",
] as const;
export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

/**
 * Category swatches, carried over verbatim from `app.html`.
 *
 * `electrical` and `plumbing` are here because legacy documents contain them, even
 * though they are not valid `ItemCategory` values the API will accept on a write —
 * hence the wider key type. A stored row using one must still render with its colour.
 */
export const CATEGORY_COLORS: Record<string, string> = {
  drywall: "#6B8CAE",
  flooring: "#8B7355",
  trim: "#7A9E7E",
  painting: "#C47B5A",
  custom: "#9B7EC8",
  other: "#8A8A8A",
  electrical: "#F59E0B",
  plumbing: "#06B6D4",
};

export function categoryColor(category: string | undefined): string {
  return CATEGORY_COLORS[category ?? "other"] ?? CATEGORY_COLORS.other!;
}

/** Note the mixed casing — these are the literal stored values, not display text. */
export const ITEM_UNITS = ["LF", "SF", "Ea", "Qty", "Sq"] as const;
export type ItemUnit = (typeof ITEM_UNITS)[number];

/** The ten meeting colours offered in the legacy calendar modal. */
export const MEETING_COLORS = [
  "#10B981",
  "#3B82F6",
  "#F59E0B",
  "#EF4444",
  "#8B5CF6",
  "#EC4899",
  "#06B6D4",
  "#F97316",
  "#84CC16",
  "#6366F1",
] as const;
