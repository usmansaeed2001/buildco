/**
 * The three states every data-backed view needs: loading, empty, and failed.
 *
 * Having them as components rather than inline JSX is what stops a screen from
 * accidentally shipping with only two of the three handled — the classic result being
 * a permanently blank panel when a request fails.
 */
import type { ReactNode } from "react";
import { ApiError } from "@/api/client";
import { Button, Spinner } from "./Button";
import { cn } from "@/lib/cn";

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("rounded-card bg-surface ring-1 ring-gray-200", className)}>{children}</div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-gray-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center gap-3 py-16 text-gray-500"
    >
      <Spinner className="size-6" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <p className="font-medium text-gray-900">{title}</p>
      {description && <p className="max-w-md text-sm text-gray-500">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/**
 * A failed request, explained.
 *
 * The API's messages are written for people — "This estimate is locked. Only the owner
 * can edit it." — so showing `error.message` is better than a generic apology. The
 * request id is surfaced only when present, because it is what correlates a user's
 * report with the server log line.
 */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const apiError = error instanceof ApiError ? error : null;
  const message =
    apiError?.message ??
    (error instanceof Error ? error.message : "Something went wrong. Please try again.");

  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <p className="font-medium text-gray-900">Could not load this</p>
      <p className="max-w-md text-sm text-gray-500">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
      {apiError?.requestId && (
        <p className="text-xs text-gray-400">
          Reference <code className="font-mono">{apiError.requestId}</code>
        </p>
      )}
    </div>
  );
}

/** An inline banner, for errors attached to a form rather than a whole page. */
export function Alert({
  tone = "danger",
  children,
}: {
  tone?: "danger" | "warning" | "success" | "info";
  children: ReactNode;
}) {
  const tones = {
    danger: "bg-danger-50 text-danger-600 ring-danger-500/20",
    warning: "bg-warning-50 text-warning-600 ring-warning-500/20",
    success: "bg-success-50 text-success-700 ring-success-500/20",
    info: "bg-brand-50 text-brand-700 ring-brand-100",
  } as const;

  return (
    <div className={cn("rounded-md px-3 py-2 text-sm ring-1 ring-inset", tones[tone])} role="alert">
      {children}
    </div>
  );
}
