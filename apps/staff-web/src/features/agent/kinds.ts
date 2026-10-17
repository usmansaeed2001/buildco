/**
 * The kinds of change the assistant can propose, as the panel names them, and where the
 * record each one saves can be opened. Mirrors `agent_rules.KINDS` on the API.
 */
import type { Target } from "./protocol";

export const KIND_TITLES: Record<string, string> = {
  "meeting.create": "New meeting",
  "meeting.update": "Change to a meeting",
  "supplement.create": "New supplement",
  "supplement.update_details": "Change supplement details",
  "supplement.transition": "Change supplement status",
  "supplement.submit": "Send for review",
  "supplement.add_lines": "Add lines",
  "memory.change": "Change to what I remember",
};

/**
 * A proposal's kind in plain words. A status change is named for what it does
 * ("Archive supplement") when the server said, since "change status" tells nobody which.
 */
export function kindTitle(kind: string | null | undefined, actionLabel?: string | null): string {
  if (kind === "supplement.transition" && actionLabel) return `${actionLabel} supplement`;
  return (kind && KIND_TITLES[kind]) || "Proposed change";
}

/** What became of a proposal, as a receipt shows it. */
export type ReceiptStatus =
  | "committed"
  | "failed"
  | "cancelled"
  | "handed_over"
  | "expired"
  | "proposed";

const RECEIPTS: readonly string[] = [
  "committed",
  "failed",
  "cancelled",
  "handed_over",
  "expired",
  "proposed",
];

/**
 * A receipt's status, from whatever the server called the outcome. Null when there is no
 * receipt to show: replaced by a correction, where the new proposal is the outcome and
 * gets its own.
 */
export function receiptStatus(status: string): ReceiptStatus | null {
  return RECEIPTS.includes(status) ? (status as ReceiptStatus) : null;
}

/** Where in the app a saved record lives. */
export function linkTo(target: Target | null | undefined): string | null {
  if (!target) return null;
  if (target.type === "supplement") return `/estimates/${target.id}`;
  if (target.type === "meeting") return "/calendar";
  if (target.type === "memory") return "/profile";
  return null;
}
