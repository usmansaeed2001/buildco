/**
 * A receipt: what became of something the assistant proposed, left in the conversation
 * where it happened.
 *
 * Release 1 showed one outcome and replaced it with the next, so a conversation that
 * made three changes showed one. A receipt stays. A past conversation is drawn with the
 * same receipts as a live one, so the two look alike.
 *
 * The colour is never the only signal: every receipt says "Saved" or "Not saved" in
 * words, and nothing says "Saved" until the server has said so.
 */
import { Link } from "react-router-dom";
import { cn } from "@/lib/cn";
import { CheckIcon, ClockIcon, CrossIcon, InfoIcon } from "./icons";
import type { ReceiptStatus } from "./kinds";


const LOOKS: Record<ReceiptStatus, { edge: string; icon: string; headline: string }> = {
  committed: {
    edge: "border-l-success-500",
    icon: "text-success-600 dark:text-success-400",
    headline: "Saved",
  },
  failed: {
    edge: "border-l-danger-500",
    icon: "text-danger-600 dark:text-danger-400",
    headline: "Not saved",
  },
  cancelled: {
    edge: "border-l-gray-300",
    icon: "text-gray-500",
    headline: "Not saved. You rejected it.",
  },
  handed_over: {
    edge: "border-l-gray-300",
    icon: "text-gray-500",
    headline: "Stopped. The form is yours to finish.",
  },
  expired: {
    edge: "border-l-warning-500",
    icon: "text-warning-600 dark:text-warning-400",
    headline: "Not saved. It waited too long.",
  },
  proposed: {
    edge: "border-l-gray-300",
    icon: "text-gray-500",
    headline: "Not saved. It was still waiting when the conversation ended.",
  },
};

export function Receipt({
  status,
  title,
  detail,
  error,
  note,
  to,
}: {
  status: ReceiptStatus;
  /** What it was: the kind in plain words, and the record by name where known. */
  title?: string | null;
  /** One more line: when, for a meeting. */
  detail?: string | null;
  /** Why it failed. */
  error?: string | null;
  /** How it was approved, in a past conversation. */
  note?: string | null;
  /** Where the saved record can be opened. */
  to?: string | null;
}) {
  const look = LOOKS[status];
  const Icon =
    status === "committed"
      ? CheckIcon
      : status === "failed"
        ? CrossIcon
        : status === "expired"
          ? ClockIcon
          : InfoIcon;

  return (
    <article
      className={cn(
        "ast-rise flex gap-2.5 rounded-card border-l-[3px] bg-surface py-2.5 pr-3 pl-2.5 text-sm ring-1 ring-gray-200",
        look.edge,
      )}
    >
      <Icon className={cn("mt-px size-[18px]", look.icon)} />
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-gray-900">{look.headline}</p>
        {title && <p className="truncate text-gray-700">{title}</p>}
        {detail && <p className="tnum text-gray-500">{detail}</p>}
        {status === "failed" && (
          <p className="text-gray-600">{error || "Something went wrong."}</p>
        )}
        {(note || to) && (
          <p className="mt-0.5 flex items-center justify-between gap-3 text-xs text-gray-500">
            <span>{note}</span>
            {to && (
              <Link
                to={to}
                className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-300"
              >
                Open
              </Link>
            )}
          </p>
        )}
      </div>
    </article>
  );
}
