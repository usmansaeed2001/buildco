/**
 * Turning a `<input type="date">` value into an instant the API can filter on.
 *
 * The input hands back `YYYY-MM-DD` with no zone. The API filters `created_at`, which is
 * a real instant — so somebody has to decide which 24 hours "the 3rd" means, and only the
 * browser knows the viewer's offset. Doing it here rather than server-side is the same
 * decision `domain/calendar.ts` makes for meetings, and for the same reason: a UTC day
 * boundary puts an estimate created at 6pm in Los Angeles on the following day.
 *
 * Both bounds are inclusive, so the end of a day is 23:59:59.999 rather than the
 * following midnight — the API compares with `<=`, and midnight-next-day would sweep in
 * anything created in that first millisecond.
 */

/** Midnight local on `value`, as an ISO instant. `undefined` for a blank or unparseable input. */
export function startOfLocalDay(value: string): string | undefined {
  const parts = parse(value);
  if (!parts) return undefined;
  const [year, month, day] = parts;
  return new Date(year, month - 1, day, 0, 0, 0, 0).toISOString();
}

/** The last millisecond of `value`, local, as an ISO instant. */
export function endOfLocalDay(value: string): string | undefined {
  const parts = parse(value);
  if (!parts) return undefined;
  const [year, month, day] = parts;
  return new Date(year, month - 1, day, 23, 59, 59, 999).toISOString();
}

function parse(value: string): [number, number, number] | null {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  if ([year, month, day].some(Number.isNaN)) return null;
  // A date the browser cannot represent should drop the filter rather than send an
  // "Invalid Date", which serialises to a 422 the user cannot act on.
  const composed = new Date(year, month - 1, day);
  return Number.isNaN(composed.getTime()) ? null : [year, month, day];
}
