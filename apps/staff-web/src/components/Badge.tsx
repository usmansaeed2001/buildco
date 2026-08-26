/**
 * Status and role pills.
 *
 * The colour assignments are carried over from the legacy app: owner amber, admin
 * blue, member grey, and the status triad of green/amber/red. Staff read these at a
 * glance, so changing them would quietly retrain muscle memory for no gain.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import {
  ESTIMATE_STATUS_LABELS,
  PROJECT_STATUS_LABELS,
  WORK_STATUS_LABELS,
  type EstimateStatus,
  type ProjectStatus,
  type Role,
  type WorkStatus,
} from "@/domain/enums";

type Tone = "neutral" | "brand" | "success" | "warning" | "danger";

const TONES: Record<Tone, string> = {
  neutral: "bg-gray-100 text-gray-600 ring-gray-200",
  brand: "bg-brand-50 text-brand-600 ring-brand-100",
  success: "bg-success-50 text-success-700 ring-success-500/20",
  warning: "bg-warning-100 text-warning-600 ring-warning-500/20",
  danger: "bg-danger-50 text-danger-600 ring-danger-500/20",
};

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const ESTIMATE_TONES: Record<EstimateStatus, Tone> = {
  active: "brand",
  submitted: "warning",
  changes_requested: "warning",
  approved: "success",
  rejected: "danger",
  archived: "neutral",
  locked: "neutral",
};

export function EstimateStatusBadge({ status }: { status: EstimateStatus }) {
  return (
    <Badge tone={ESTIMATE_TONES[status] ?? "neutral"}>
      {status === "locked" && <LockIcon />}
      {ESTIMATE_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

const PROJECT_TONES: Record<ProjectStatus, Tone> = {
  active: "brand",
  pending_payment: "warning",
  closed: "success",
  cancelled: "danger",
};

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  return <Badge tone={PROJECT_TONES[status] ?? "neutral"}>{PROJECT_STATUS_LABELS[status]}</Badge>;
}

const WORK_TONES: Record<WorkStatus, Tone> = {
  contract_sent: "neutral",
  contract_not_signed: "danger",
  contract_signed: "brand",
  start_date: "brand",
  in_progress: "warning",
  on_hold: "danger",
  completed: "success",
};

export function WorkStatusBadge({ status }: { status: WorkStatus }) {
  return <Badge tone={WORK_TONES[status] ?? "neutral"}>{WORK_STATUS_LABELS[status]}</Badge>;
}

const ROLE_TONES: Record<Role, Tone> = {
  owner: "warning",
  admin: "brand",
  member: "neutral",
};

export function RoleBadge({ role }: { role: Role }) {
  return <Badge tone={ROLE_TONES[role] ?? "neutral"}>{role}</Badge>;
}

function LockIcon() {
  return (
    <svg className="mr-1 size-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M10 1a4 4 0 0 0-4 4v3H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-1V5a4 4 0 0 0-4-4Zm2 7V5a2 2 0 1 0-4 0v3h4Z"
        clipRule="evenodd"
      />
    </svg>
  );
}
