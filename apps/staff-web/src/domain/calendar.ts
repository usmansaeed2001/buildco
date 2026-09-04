/**
 * Calendar arithmetic: grids, windows, and the local/UTC boundary.
 *
 * All of it is pure and none of it uses a date library. The two things that actually
 * matter are both about timezones, and both are easy to get subtly wrong:
 *
 * **A meeting belongs to a local day, not a UTC one.** `start_time` arrives as ISO with
 * an offset. Bucketing on `toISOString().slice(0, 10)` — the obvious thing — puts a
 * 6pm Los Angeles meeting on *tomorrow*, because 18:00 PST is 02:00 UTC the next day.
 * Every grouping here goes through `localDayKey`, which reads the local calendar
 * fields.
 *
 * **A date and a time from two inputs are local.** `new Date("2026-03-01T14:00")` — no
 * offset — is parsed as local time by every browser, which is what someone typing into
 * a form means. Appending "Z" would silently shift the meeting by the viewer's offset.
 *
 * Weeks start on Sunday, matching the legacy calendar and US convention.
 */

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface CalendarDay {
  date: Date;
  /** `YYYY-MM-DD` in the local zone. The key everything is bucketed by. */
  key: string;
  /** False for the leading/trailing days borrowed from adjacent months. */
  inMonth: boolean;
  isToday: boolean;
}

/** `YYYY-MM-DD` for the *local* calendar day a moment falls on. */
export function localDayKey(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Midnight local on the day `value` falls in. */
export function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

export function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

export function addMonths(value: Date, months: number): Date {
  // Anchored to the 1st before shifting: `new Date(2026, 0, 31)` plus one month is
  // 2 March, because February has no 31st. A month grid only ever needs the month.
  return new Date(value.getFullYear(), value.getMonth() + months, 1);
}

/**
 * Six weeks of days covering the month `anchor` falls in.
 *
 * Always six rows, never five. A grid that changes height as you page through months
 * makes everything below it jump, and February in a non-leap year starting on Sunday is
 * exactly four weeks — so the row count would otherwise vary between 4 and 6.
 */
export function monthGrid(anchor: Date, today: Date = new Date()): CalendarDay[][] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const gridStart = addDays(first, -first.getDay());
  const todayKey = localDayKey(today);

  const weeks: CalendarDay[][] = [];
  for (let week = 0; week < 6; week += 1) {
    const days: CalendarDay[] = [];
    for (let day = 0; day < 7; day += 1) {
      const date = addDays(gridStart, week * 7 + day);
      const key = localDayKey(date);
      days.push({
        date,
        key,
        inMonth: date.getMonth() === anchor.getMonth(),
        isToday: key === todayKey,
      });
    }
    weeks.push(days);
  }

  return weeks;
}

/** The seven days of the Sunday-start week `anchor` falls in. */
export function weekGrid(anchor: Date, today: Date = new Date()): CalendarDay[] {
  const start = addDays(startOfDay(anchor), -anchor.getDay());
  const todayKey = localDayKey(today);

  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(start, index);
    const key = localDayKey(date);
    return { date, key, inMonth: date.getMonth() === anchor.getMonth(), isToday: key === todayKey };
  });
}

/**
 * The twelve months of `anchor`'s year, each as its own six-week grid.
 *
 * No new date arithmetic — twelve calls to `monthGrid`. The year view is a reader, not a
 * different calendar.
 */
export function yearGrid(anchor: Date, today: Date = new Date()): { month: Date; weeks: CalendarDay[][] }[] {
  return Array.from({ length: 12 }, (_, month) => {
    const first = new Date(anchor.getFullYear(), month, 1);
    return { month: first, weeks: monthGrid(first, today) };
  });
}

export function addWeeks(value: Date, weeks: number): Date {
  return addDays(value, weeks * 7);
}

export function addYears(value: Date, years: number): Date {
  // Anchored to 1 January for the same reason `addMonths` anchors to the 1st: 29
  // February plus one year is not a date, and a year grid only ever needs the year.
  return new Date(value.getFullYear() + years, 0, 1);
}

export interface TimeWindow {
  /** ISO instants, for the API's `from` and `to` query parameters. */
  from: string;
  to: string;
}

/**
 * The window to fetch for a month view.
 *
 * Covers the whole *grid*, not the month — the leading and trailing cells show real
 * days, and a meeting on one of them must appear rather than being invisible until you
 * page to the month it belongs to.
 */
export function monthWindow(anchor: Date): TimeWindow {
  const weeks = monthGrid(anchor);
  const first = weeks[0]![0]!.date;
  const last = weeks[5]![6]!.date;
  return { from: first.toISOString(), to: addDays(last, 1).toISOString() };
}

/** Midnight to midnight, local, for a single day. */
export function dayWindow(day: Date): TimeWindow {
  const start = startOfDay(day);
  return { from: start.toISOString(), to: addDays(start, 1).toISOString() };
}

/** Sunday midnight to the following Sunday midnight, local. */
export function weekWindow(anchor: Date): TimeWindow {
  const start = addDays(startOfDay(anchor), -anchor.getDay());
  return { from: start.toISOString(), to: addDays(start, 7).toISOString() };
}

/**
 * The whole of `anchor`'s year.
 *
 * Covers the calendar year rather than the twelve rendered grids. A year view shows
 * density per day, not individual meetings, so the few borrowed days at either end
 * belong to a neighbouring year's count and are not worth a wider fetch.
 */
export function yearWindow(anchor: Date): TimeWindow {
  const year = anchor.getFullYear();
  return {
    from: new Date(year, 0, 1).toISOString(),
    to: new Date(year + 1, 0, 1).toISOString(),
  };
}

/** Bucket anything with a `start_time` by the local day it falls on. */
export function groupByDay<T extends { start_time: string }>(items: readonly T[]): Map<string, T[]> {
  const byDay = new Map<string, T[]>();

  for (const item of items) {
    const key = localDayKey(item.start_time);
    if (!key) continue;
    const bucket = byDay.get(key);
    if (bucket) bucket.push(item);
    else byDay.set(key, [item]);
  }

  // Ascending within each day, so a day cell reads top to bottom in time order.
  for (const bucket of byDay.values()) {
    bucket.sort((a, b) => a.start_time.localeCompare(b.start_time));
  }

  return byDay;
}

// ── Form values ─────────────────────────────────────────────────────────────

/** `YYYY-MM-DD` for a `<input type="date">`, in the local zone. */
export function toDateInput(iso: string): string {
  return localDayKey(iso);
}

/** `HH:MM` for a `<input type="time">`, in the local zone. */
export function toTimeInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * Combine a date and a time field into an ISO instant.
 *
 * The two values are what the person typed, in their own zone, so they are composed
 * with the local `Date` constructor rather than by string concatenation with a "Z".
 * Returns null for an incomplete or unparseable pair rather than an Invalid Date, which
 * would serialise as `null` and produce a confusing 422.
 */
export function fromDateTimeInputs(date: string, time: string): string | null {
  if (!date || !time) return null;

  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  if ([year, month, day, hour, minute].some((n) => n === undefined || Number.isNaN(n))) {
    return null;
  }

  const composed = new Date(year!, month! - 1, day!, hour!, minute!, 0, 0);
  return Number.isNaN(composed.getTime()) ? null : composed.toISOString();
}

/** One hour after `time` on the same date, as `HH:MM`. The default end for a new meeting. */
export function addHour(time: string): string {
  const [hour, minute] = time.split(":").map(Number);
  if (hour === undefined || Number.isNaN(hour)) return time;
  return `${String((hour + 1) % 24).padStart(2, "0")}:${String(minute ?? 0).padStart(2, "0")}`;
}

// ── The time grid ───────────────────────────────────────────────────────────

/** How finely a drag or a click snaps, in minutes. */
export const SLOT_MINUTES = 15;

/** Minutes from local midnight to `value`. The vertical position of anything on a grid. */
export function minutesSinceMidnight(value: Date | string): number {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return 0;
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Round to the nearest slot, clamped to the day.
 *
 * A non-finite input returns midnight rather than propagating. It reaches here from a
 * pointer offset divided by a scale, and a NaN would end up in a CSS `top`, which
 * silently collapses the element it was positioning.
 */
export function snapToSlot(minutes: number, slot: number = SLOT_MINUTES): number {
  if (!Number.isFinite(minutes)) return 0;
  const snapped = Math.round(minutes / slot) * slot;
  return Math.min(24 * 60, Math.max(0, snapped));
}

/** The wall-clock moment a pointer at `offsetY` pixels down a day column is pointing at. */
export function slotFromOffset(offsetY: number, pixelsPerMinute: number, day: Date): Date {
  const minutes = snapToSlot(offsetY / pixelsPerMinute);
  const start = startOfDay(day);
  // Composed with setMinutes rather than by adding milliseconds: on a DST boundary the
  // arithmetic day is 23 or 25 hours long, and "10:00" must still mean 10:00.
  start.setMinutes(minutes);
  return start;
}

export interface Placed<T> {
  item: T;
  /** Zero-based column within this item's overlap cluster. */
  column: number;
  /** How many columns that cluster needs. Width is `1 / columnCount`. */
  columnCount: number;
}

/**
 * Lay overlapping meetings out side by side, the way a calendar does.
 *
 * Two passes, because one is not enough:
 *
 * 1. **Assign columns.** Walk the day in start order, reusing the first column whose
 *    occupant has already finished, otherwise opening a new one.
 * 2. **Size each cluster separately.** `columnCount` is the widest point of the
 *    *connected* run of overlaps an item belongs to, not the widest point of the day.
 *    Without this, one five-way pile-up at 9am would squeeze a lone 4pm meeting to a
 *    fifth of the width for no reason.
 *
 * Back-to-back meetings — one ending exactly as the next begins — deliberately do not
 * overlap. They are the most common shape on a working calendar, and stacking them side
 * by side would halve the width of an ordinary day.
 */
export function assignColumns<T extends { start_time: string; end_time: string }>(
  items: readonly T[],
): Placed<T>[] {
  const sorted = [...items].sort(
    (a, b) => a.start_time.localeCompare(b.start_time) || a.end_time.localeCompare(b.end_time),
  );

  const placed: { item: T; column: number; start: string; end: string }[] = [];
  const columnEnds: string[] = [];
  // Index in `placed` where the current run of overlaps began, plus the latest end time
  // seen in it — a cluster ends when a meeting starts at or after everything before it.
  const clusters: { from: number; to: number; width: number }[] = [];
  let clusterFrom = 0;
  let clusterEnd = "";

  for (const item of sorted) {
    if (clusterEnd && item.start_time >= clusterEnd) {
      clusters.push({ from: clusterFrom, to: placed.length, width: columnEnds.length });
      columnEnds.length = 0;
      clusterFrom = placed.length;
      clusterEnd = "";
    }

    let column = columnEnds.findIndex((end) => end <= item.start_time);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(item.end_time);
    } else {
      columnEnds[column] = item.end_time;
    }

    placed.push({ item, column, start: item.start_time, end: item.end_time });
    if (item.end_time > clusterEnd) clusterEnd = item.end_time;
  }
  if (placed.length > clusterFrom) {
    clusters.push({ from: clusterFrom, to: placed.length, width: columnEnds.length });
  }

  const out: Placed<T>[] = [];
  for (const cluster of clusters) {
    for (let index = cluster.from; index < cluster.to; index += 1) {
      const entry = placed[index]!;
      out.push({ item: entry.item, column: entry.column, columnCount: cluster.width });
    }
  }
  return out;
}
