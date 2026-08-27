/**
 * Which estimates you have already looked at, per status.
 *
 * This is the one thing that stays in `localStorage` after Phase 8 moved Settings
 * server-side, and it belongs there: "have *I* seen this" is genuinely per-person and
 * per-device, and syncing it would mean a colleague opening an estimate clears your dot.
 *
 * A port of `getSeenIds`/`markAsSeen` from the legacy `app.html`, which drove a red dot
 * on each status chip. Two differences:
 *
 * - **Storage is capped.** The legacy version stored every id it ever saw, per status,
 *   for ever — an unbounded key that only grows. Ids are trimmed to the most recent
 *   `LIMIT`, which is far more than any filter shows at once.
 * - **Every access is guarded.** `localStorage` throws in Safari private mode and when
 *   a browser is configured to block site data. The legacy `markAsSeen` was unguarded,
 *   so the whole render died on a machine with cookies disabled.
 */

const PREFIX = "buildco_seen_";

/** Plenty for any filter, and bounded so the key cannot grow without limit. */
export const LIMIT = 500;

function keyFor(status: string): string {
  return `${PREFIX}${status}`;
}

export function readSeen(status: string): string[] {
  try {
    const raw = localStorage.getItem(keyFor(status));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    // Unreadable, unparseable, or storage disabled. An empty list means "nothing seen",
    // which shows a dot that should not be there — a far better failure than a blank
    // screen.
    return [];
  }
}

export function writeSeen(status: string, ids: readonly string[]): void {
  try {
    // Most recent last, so trimming from the front drops the oldest.
    localStorage.setItem(keyFor(status), JSON.stringify(ids.slice(-LIMIT)));
  } catch {
    // Quota exceeded, or storage disabled. Losing a read-marker is not worth an error.
  }
}

/** Ids present now that were not present the last time this status was viewed. */
export function unseenIds(status: string, ids: readonly string[]): string[] {
  const seen = new Set(readSeen(status));
  return ids.filter((id) => !seen.has(id));
}

export function hasUnseen(status: string, ids: readonly string[]): boolean {
  return unseenIds(status, ids).length > 0;
}

/**
 * Record everything currently in a status as seen.
 *
 * Replaces rather than merges: an id that has left the status can never come back to
 * *this* status list without being new again, and keeping it would pin the key at its
 * cap with entries that no longer mean anything.
 */
export function markSeen(status: string, ids: readonly string[]): void {
  writeSeen(status, ids);
}

/** For tests and for a sign-out that should not leak one person's dots to the next. */
export function clearSeen(): void {
  try {
    const keys = Object.keys(localStorage).filter((key) => key.startsWith(PREFIX));
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}
