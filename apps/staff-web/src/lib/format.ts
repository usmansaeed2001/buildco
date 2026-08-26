/** Date and text formatting.
 *
 * All API timestamps are ISO 8601 with an offset (`DateTime(timezone=True)`), so they
 * parse unambiguously and render in the viewer's local zone. */

const DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const DATE_TIME = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value: string | null | undefined, fallback = "—"): string {
  const date = parse(value);
  return date ? DATE.format(date) : fallback;
}

export function formatDateTime(value: string | null | undefined, fallback = "—"): string {
  const date = parse(value);
  return date ? DATE_TIME.format(date) : fallback;
}

export function formatTime(value: string | null | undefined, fallback = "—"): string {
  const date = parse(value);
  return date ? TIME.format(date) : fallback;
}

/** "3 days ago", "in 2 hours". Uses the browser's own relative formatting so the
 *  wording is localised rather than hand-rolled. */
export function formatRelative(value: string | null | undefined): string {
  const date = parse(value);
  if (!date) return "—";

  const seconds = (date.getTime() - Date.now()) / 1000;
  const formatter = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3600],
    ["minute", 60],
  ];

  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return formatter.format(Math.round(seconds), "second");
}

/** How long a trashed estimate has left.
 *
 * The 30-day window is the legacy app's own convention, shown to set expectations. It
 * is not enforced anywhere — nothing purges the trash on a schedule — so this is a
 * statement of intent, not a countdown to an actual deletion. */
export const TRASH_RETENTION_DAYS = 30;

export function daysLeftInTrash(deletedAt: string | null | undefined): number | null {
  const date = parse(deletedAt);
  if (!date) return null;
  const elapsed = (Date.now() - date.getTime()) / 86_400_000;
  return Math.max(0, Math.ceil(TRASH_RETENTION_DAYS - elapsed));
}

/** The name to show for an actor, matching the backend's `display_name` property. */
export function displayName(
  actor: { full_name?: string; email?: string } | null | undefined,
): string {
  if (!actor) return "Unknown";
  return actor.full_name || actor.email || "Unknown";
}
