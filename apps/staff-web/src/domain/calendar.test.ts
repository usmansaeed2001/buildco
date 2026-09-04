/**
 * The timezone boundary is what these are really about.
 *
 * The suite runs in whatever zone the machine is in, so anything asserting a *specific*
 * offset would pass on one laptop and fail on another. Instead the tests state
 * relationships that hold in every zone — a meeting lands on the local day its own
 * `Date` reports, a composed time round-trips through the inputs it came from — which is
 * exactly the property the calendar depends on.
 */
import { describe, expect, it } from "vitest";
import {
  addDays,
  addHour,
  addMonths,
  dayWindow,
  fromDateTimeInputs,
  groupByDay,
  localDayKey,
  addYears,
  assignColumns,
  minutesSinceMidnight,
  monthGrid,
  monthWindow,
  slotFromOffset,
  snapToSlot,
  startOfDay,
  weekGrid,
  weekWindow,
  yearGrid,
  yearWindow,
  toDateInput,
  toTimeInput,
  WEEKDAY_LABELS,
} from "./calendar";

describe("localDayKey", () => {
  it("reads the local calendar day, not the UTC one", () => {
    // The bug this exists to prevent: `toISOString().slice(0,10)` puts a 6pm Los
    // Angeles meeting on tomorrow, because 18:00 PST is 02:00 UTC the next day.
    const evening = new Date(2026, 2, 1, 18, 0);
    expect(localDayKey(evening)).toBe("2026-03-01");
    expect(localDayKey(evening)).toBe(
      `${evening.getFullYear()}-${String(evening.getMonth() + 1).padStart(2, "0")}-${String(
        evening.getDate(),
      ).padStart(2, "0")}`,
    );
  });

  it("agrees with the Date object for an ISO string in any zone", () => {
    const iso = "2026-03-01T02:00:00Z";
    const parsed = new Date(iso);
    expect(localDayKey(iso)).toBe(localDayKey(parsed));
  });

  it("returns an empty string for something unparseable", () => {
    expect(localDayKey("not a date")).toBe("");
  });
});

describe("date arithmetic", () => {
  it("adds days across a month boundary", () => {
    expect(localDayKey(addDays(new Date(2026, 0, 31), 1))).toBe("2026-02-01");
  });

  it("adds days across a leap day", () => {
    expect(localDayKey(addDays(new Date(2028, 1, 28), 1))).toBe("2028-02-29");
  });

  it("adds a month without overflowing a short one", () => {
    // `new Date(2026, 0, 31)` plus one month is 2 March by naive arithmetic, because
    // February has no 31st.
    const next = addMonths(new Date(2026, 0, 31), 1);
    expect(next.getMonth()).toBe(1);
    expect(next.getDate()).toBe(1);
  });

  it("steps back across a year boundary", () => {
    const prev = addMonths(new Date(2026, 0, 15), -1);
    expect(prev.getFullYear()).toBe(2025);
    expect(prev.getMonth()).toBe(11);
  });

  it("startOfDay strips the time", () => {
    const start = startOfDay(new Date(2026, 2, 1, 18, 30));
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(localDayKey(start)).toBe("2026-03-01");
  });
});

describe("monthGrid", () => {
  it("always returns six weeks of seven days", () => {
    // A grid that changes height makes everything below it jump as you page through.
    for (const month of [0, 1, 4, 11]) {
      const grid = monthGrid(new Date(2026, month, 1));
      expect(grid).toHaveLength(6);
      expect(grid.every((week) => week.length === 7)).toBe(true);
    }
  });

  it("starts every row on a Sunday", () => {
    const grid = monthGrid(new Date(2026, 2, 1));
    expect(grid.every((week) => week[0]!.date.getDay() === 0)).toBe(true);
    expect(WEEKDAY_LABELS[0]).toBe("Sun");
  });

  it("marks the borrowed days from adjacent months", () => {
    // March 2026 starts on a Sunday, so there are no leading days but plenty trailing.
    const grid = monthGrid(new Date(2026, 2, 1));
    const flat = grid.flat();

    expect(flat.filter((day) => day.inMonth)).toHaveLength(31);
    expect(flat.filter((day) => !day.inMonth).length).toBe(42 - 31);
  });

  it("includes leading days when the month does not start on a Sunday", () => {
    // 1 April 2026 is a Wednesday, so three days of March lead the grid.
    const grid = monthGrid(new Date(2026, 3, 1));
    expect(grid[0]!.slice(0, 3).every((day) => !day.inMonth)).toBe(true);
    expect(grid[0]![3]!.inMonth).toBe(true);
    expect(grid[0]![3]!.date.getDate()).toBe(1);
  });

  it("marks today, and only today", () => {
    const today = new Date(2026, 2, 15);
    const flat = monthGrid(today, today).flat();

    expect(flat.filter((day) => day.isToday)).toHaveLength(1);
    expect(flat.find((day) => day.isToday)!.key).toBe("2026-03-15");
  });

  it("marks nothing when today is in another month", () => {
    const grid = monthGrid(new Date(2026, 6, 1), new Date(2026, 2, 15));
    expect(grid.flat().some((day) => day.isToday)).toBe(false);
  });
});

describe("windows", () => {
  it("covers the whole grid, not just the month", () => {
    // The leading and trailing cells show real days; a meeting on one must appear
    // rather than being invisible until you page to the month it belongs to.
    const anchor = new Date(2026, 3, 1);
    const grid = monthGrid(anchor);
    const { from, to } = monthWindow(anchor);

    expect(new Date(from).getTime()).toBe(grid[0]![0]!.date.getTime());
    expect(new Date(to).getTime()).toBeGreaterThan(grid[5]![6]!.date.getTime());
  });

  it("day window spans exactly one local day", () => {
    const { from, to } = dayWindow(new Date(2026, 2, 1, 18, 0));
    const span = new Date(to).getTime() - new Date(from).getTime();

    // 24 hours, except across a DST transition where it is 23 or 25 — which is correct
    // and is exactly why the window is built from local midnights rather than +24h.
    expect(span).toBeGreaterThanOrEqual(23 * 3600_000);
    expect(span).toBeLessThanOrEqual(25 * 3600_000);
    expect(localDayKey(new Date(from))).toBe("2026-03-01");
  });
});

describe("groupByDay", () => {
  const meeting = (start: Date, title: string) => ({ start_time: start.toISOString(), title });

  it("buckets by the local day", () => {
    const evening = new Date(2026, 2, 1, 18, 0);
    const grouped = groupByDay([meeting(evening, "Walkthrough")]);

    expect(grouped.get("2026-03-01")).toHaveLength(1);
    // And emphatically not on the next day, which UTC bucketing would produce in the
    // Americas.
    expect(grouped.get("2026-03-02")).toBeUndefined();
  });

  it("sorts within a day", () => {
    const grouped = groupByDay([
      meeting(new Date(2026, 2, 1, 15, 0), "Afternoon"),
      meeting(new Date(2026, 2, 1, 9, 0), "Morning"),
      meeting(new Date(2026, 2, 1, 12, 0), "Midday"),
    ]);

    expect(grouped.get("2026-03-01")!.map((m) => m.title)).toEqual([
      "Morning",
      "Midday",
      "Afternoon",
    ]);
  });

  it("separates days", () => {
    const grouped = groupByDay([
      meeting(new Date(2026, 2, 1, 9, 0), "First"),
      meeting(new Date(2026, 2, 2, 9, 0), "Second"),
    ]);

    expect([...grouped.keys()].sort()).toEqual(["2026-03-01", "2026-03-02"]);
  });

  it("drops an unparseable timestamp rather than throwing", () => {
    const grouped = groupByDay([{ start_time: "nonsense" }, meeting(new Date(2026, 2, 1), "Ok")]);
    expect(grouped.size).toBe(1);
  });

  it("returns an empty map for no meetings", () => {
    expect(groupByDay([]).size).toBe(0);
  });
});

describe("form values", () => {
  it("round-trips a moment through the date and time inputs", () => {
    // The property the modal depends on: what is shown in the two fields, recombined,
    // is the same instant it came from.
    const original = new Date(2026, 2, 1, 14, 30).toISOString();

    const recomposed = fromDateTimeInputs(toDateInput(original), toTimeInput(original));

    expect(recomposed).toBe(original);
  });

  it("composes the two fields as local time, not UTC", () => {
    // Appending "Z" would silently shift every meeting by the viewer's offset.
    const iso = fromDateTimeInputs("2026-03-01", "14:00")!;
    const parsed = new Date(iso);

    expect(parsed.getHours()).toBe(14);
    expect(parsed.getMinutes()).toBe(0);
    expect(localDayKey(parsed)).toBe("2026-03-01");
  });

  it("returns null rather than an Invalid Date for an incomplete pair", () => {
    // An Invalid Date serialises as null and produces a confusing 422.
    expect(fromDateTimeInputs("", "14:00")).toBeNull();
    expect(fromDateTimeInputs("2026-03-01", "")).toBeNull();
    expect(fromDateTimeInputs("not-a-date", "14:00")).toBeNull();
  });

  it("pads the time input", () => {
    expect(toTimeInput(new Date(2026, 2, 1, 9, 5).toISOString())).toBe("09:05");
  });

  it("adds an hour, wrapping at midnight", () => {
    expect(addHour("14:00")).toBe("15:00");
    expect(addHour("23:30")).toBe("00:30");
    expect(addHour("09:05")).toBe("10:05");
  });
});

// ── Week and year grids ──────────────────────────────────────────────────────

describe("weekGrid", () => {
  it("returns seven days starting on Sunday", () => {
    const week = weekGrid(new Date(2026, 2, 4)); // A Wednesday.

    expect(week).toHaveLength(7);
    expect(week[0]!.date.getDay()).toBe(0);
    expect(week[0]!.key).toBe("2026-03-01");
    expect(week[6]!.key).toBe("2026-03-07");
  });

  it("spans a month boundary rather than stopping at it", () => {
    const week = weekGrid(new Date(2026, 2, 31)); // Tuesday 31 March.

    expect(week[0]!.key).toBe("2026-03-29");
    expect(week[6]!.key).toBe("2026-04-04");
    // `inMonth` is relative to the anchor, so April's days read as borrowed.
    expect(week[6]!.inMonth).toBe(false);
  });

  it("marks today", () => {
    const week = weekGrid(new Date(2026, 2, 4), new Date(2026, 2, 6));

    expect(week.filter((day) => day.isToday).map((day) => day.key)).toEqual(["2026-03-06"]);
  });
});

describe("yearGrid", () => {
  it("returns twelve months of the anchor's year", () => {
    const year = yearGrid(new Date(2026, 6, 15));

    expect(year).toHaveLength(12);
    expect(year[0]!.month.getMonth()).toBe(0);
    expect(year[11]!.month.getMonth()).toBe(11);
    expect(year.every((entry) => entry.month.getFullYear() === 2026)).toBe(true);
  });

  it("gives every month a full six-week grid, as the month view does", () => {
    const year = yearGrid(new Date(2026, 0, 1));

    expect(year.every((entry) => entry.weeks.length === 6)).toBe(true);
  });

  it("handles a leap February", () => {
    const february = yearGrid(new Date(2028, 0, 1))[1]!;
    const days = february.weeks.flat().filter((day) => day.inMonth);

    expect(days).toHaveLength(29);
  });
});

describe("weekWindow", () => {
  it("spans Sunday midnight to the next Sunday midnight", () => {
    const window = weekWindow(new Date(2026, 2, 4, 13, 30));

    expect(new Date(window.from).getDay()).toBe(0);
    expect(new Date(window.from).getHours()).toBe(0);
    const days = (new Date(window.to).getTime() - new Date(window.from).getTime()) / 86_400_000;
    // 7, or 6.958…/7.042 across a DST change — the boundary must stay a local midnight.
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });
});

describe("yearWindow", () => {
  it("spans 1 January to the following 1 January", () => {
    const window = yearWindow(new Date(2026, 6, 15));

    expect(new Date(window.from).getFullYear()).toBe(2026);
    expect(new Date(window.from).getMonth()).toBe(0);
    expect(new Date(window.to).getFullYear()).toBe(2027);
  });
});

describe("addYears", () => {
  it("steps the year without landing on a date that does not exist", () => {
    // 29 February plus one year is not a date. Anchoring to 1 January sidesteps it.
    expect(addYears(new Date(2028, 1, 29), 1).getFullYear()).toBe(2029);
    expect(addYears(new Date(2028, 1, 29), 1).getMonth()).toBe(0);
  });
});

// ── The time grid ────────────────────────────────────────────────────────────

describe("snapToSlot", () => {
  it("rounds to the nearest quarter hour", () => {
    expect(snapToSlot(0)).toBe(0);
    expect(snapToSlot(7)).toBe(0);
    expect(snapToSlot(8)).toBe(15);
    expect(snapToSlot(52)).toBe(45);
    expect(snapToSlot(60)).toBe(60);
  });

  it("clamps to the day rather than running past midnight", () => {
    expect(snapToSlot(-30)).toBe(0);
    expect(snapToSlot(24 * 60 + 90)).toBe(24 * 60);
  });
});

describe("minutesSinceMidnight", () => {
  it("reads local wall-clock time, not UTC", () => {
    expect(minutesSinceMidnight(new Date(2026, 2, 1, 14, 30))).toBe(870);
  });

  it("returns zero for an unparseable value rather than NaN", () => {
    // NaN would propagate into a CSS `top` and blank the whole grid.
    expect(minutesSinceMidnight("not a date")).toBe(0);
  });
});

describe("slotFromOffset", () => {
  it("turns a pixel offset into a snapped wall-clock time", () => {
    const at = slotFromOffset(600, 1, new Date(2026, 2, 1));

    expect(at.getHours()).toBe(10);
    expect(at.getMinutes()).toBe(0);
  });

  it("round-trips with minutesSinceMidnight at any scale", () => {
    const at = slotFromOffset(48 * 14.5, 48 / 60, new Date(2026, 2, 1));

    expect(minutesSinceMidnight(at)).toBe(snapToSlot(14.5 * 60));
  });
});

describe("assignColumns", () => {
  const at = (start: string, end: string) => ({ start_time: start, end_time: end });

  it("gives a lone meeting the full width", () => {
    const placed = assignColumns([at("2026-03-01T10:00:00Z", "2026-03-01T11:00:00Z")]);

    expect(placed[0]!.column).toBe(0);
    expect(placed[0]!.columnCount).toBe(1);
  });

  it("returns nothing for an empty day", () => {
    expect(assignColumns([])).toEqual([]);
  });

  it("splits two overlapping meetings into two columns", () => {
    const placed = assignColumns([
      at("2026-03-01T10:00:00Z", "2026-03-01T11:00:00Z"),
      at("2026-03-01T10:30:00Z", "2026-03-01T11:30:00Z"),
    ]);

    expect(placed.map((p) => p.column)).toEqual([0, 1]);
    expect(placed.every((p) => p.columnCount === 2)).toBe(true);
  });

  it("keeps back-to-back meetings full width", () => {
    // The most common shape on a working calendar. Treating a shared boundary as an
    // overlap would halve the width of an ordinary day.
    const placed = assignColumns([
      at("2026-03-01T10:00:00Z", "2026-03-01T11:00:00Z"),
      at("2026-03-01T11:00:00Z", "2026-03-01T12:00:00Z"),
    ]);

    expect(placed.every((p) => p.columnCount === 1)).toBe(true);
  });

  it("stacks a three-way overlap into three columns", () => {
    const placed = assignColumns([
      at("2026-03-01T10:00:00Z", "2026-03-01T12:00:00Z"),
      at("2026-03-01T10:30:00Z", "2026-03-01T12:00:00Z"),
      at("2026-03-01T11:00:00Z", "2026-03-01T12:00:00Z"),
    ]);

    expect(placed.map((p) => p.column)).toEqual([0, 1, 2]);
    expect(placed.every((p) => p.columnCount === 3)).toBe(true);
  });

  it("handles a transitive chain: A-B and B-C overlap, A-C do not", () => {
    // The case a naive "count what is concurrent right now" gets wrong. All three are
    // one connected cluster, so all three are sized against it — but A and C can share
    // a column, because they do not actually overlap.
    const placed = assignColumns([
      at("2026-03-01T10:00:00Z", "2026-03-01T11:00:00Z"),
      at("2026-03-01T10:30:00Z", "2026-03-01T12:00:00Z"),
      at("2026-03-01T11:30:00Z", "2026-03-01T13:00:00Z"),
    ]);

    expect(placed.map((p) => p.column)).toEqual([0, 1, 0]);
    expect(placed.every((p) => p.columnCount === 2)).toBe(true);
  });

  it("sizes each cluster independently", () => {
    // A pile-up in the morning must not narrow an unrelated meeting in the afternoon.
    const placed = assignColumns([
      at("2026-03-01T09:00:00Z", "2026-03-01T10:00:00Z"),
      at("2026-03-01T09:00:00Z", "2026-03-01T10:00:00Z"),
      at("2026-03-01T09:00:00Z", "2026-03-01T10:00:00Z"),
      at("2026-03-01T16:00:00Z", "2026-03-01T17:00:00Z"),
    ]);

    expect(placed.slice(0, 3).every((p) => p.columnCount === 3)).toBe(true);
    expect(placed[3]!.columnCount).toBe(1);
  });

  it("sorts by start time regardless of input order", () => {
    const placed = assignColumns([
      at("2026-03-01T14:00:00Z", "2026-03-01T15:00:00Z"),
      at("2026-03-01T09:00:00Z", "2026-03-01T10:00:00Z"),
    ]);

    expect(placed[0]!.item.start_time).toBe("2026-03-01T09:00:00Z");
  });

  it("puts the shorter of two meetings starting together in the first column", () => {
    const placed = assignColumns([
      at("2026-03-01T10:00:00Z", "2026-03-01T14:00:00Z"),
      at("2026-03-01T10:00:00Z", "2026-03-01T11:00:00Z"),
    ]);

    expect(placed[0]!.item.end_time).toBe("2026-03-01T11:00:00Z");
  });

  it("nests a short meeting inside a long one without losing either", () => {
    const placed = assignColumns([
      at("2026-03-01T09:00:00Z", "2026-03-01T17:00:00Z"),
      at("2026-03-01T12:00:00Z", "2026-03-01T13:00:00Z"),
    ]);

    expect(placed).toHaveLength(2);
    expect(placed.map((p) => p.column)).toEqual([0, 1]);
  });
});
