import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils";
import { makeMeeting, makeUser } from "@/test/factories";
import { server } from "@/test/msw/server";
import { apiError, url } from "@/test/msw/handlers";
import type { MeetingOut } from "@/api/types";
import { localDayKey } from "@/domain/calendar";
import { CalendarPage } from "./CalendarPage";

const OWNER = makeUser({ id: "owner-1", role: "owner", full_name: "Casey Owner" });
const MEMBER = makeUser({ id: "member-1", role: "member", full_name: "Sam Member" });

/** A meeting at a local wall-clock time on a given day. */
function at(year: number, month: number, day: number, hour: number, overrides: Partial<MeetingOut> = {}) {
  const start = new Date(year, month - 1, day, hour, 0);
  const end = new Date(year, month - 1, day, hour + 1, 0);
  return makeMeeting({
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    ...overrides,
  });
}

/** Serves meetings and records the window each request asked for. */
function serveMeetings(meetings: MeetingOut[]) {
  const windows: URLSearchParams[] = [];
  server.use(
    http.get(url("/meetings"), ({ request }) => {
      windows.push(new URL(request.url).searchParams);
      return HttpResponse.json(meetings);
    }),
  );
  return windows;
}

function renderCalendar(user = OWNER, route = "/calendar?on=2026-03-15&view=month") {
  return renderWithProviders(<CalendarPage />, { user, route, path: "/calendar" });
}

const grid = () => screen.getByRole("button", { name: "Open 2026-03-15" }).closest(".grid")!;

describe("CalendarPage", () => {
  describe("the month view", () => {
    it("renders a six-week grid starting on Sunday", async () => {
      serveMeetings([]);
      renderCalendar();
      await screen.findByRole("button", { name: "Open 2026-03-15" });

      expect(screen.getByText("Sun")).toBeVisible();
      // 42 day buttons, always — a grid that changes height makes the page jump.
      expect(screen.getAllByRole("button", { name: /^Open \d{4}-\d{2}-\d{2}$/ })).toHaveLength(42);
    });

    it("places a meeting on its local day", async () => {
      // The bug this guards: UTC bucketing puts a 6pm Los Angeles meeting on tomorrow.
      serveMeetings([at(2026, 3, 15, 18, { title: "Evening walkthrough" })]);
      renderCalendar();

      expect(await screen.findByRole("button", { name: /Evening walkthrough/ })).toBeVisible();
      const cell = screen.getByRole("button", { name: "Open 2026-03-15" }).parentElement!;
      expect(within(cell).getByText("Evening walkthrough")).toBeVisible();
    });

    it("fetches the whole grid, not just the month", async () => {
      // The leading and trailing cells show real days; a meeting on one must appear
      // rather than being invisible until you page to the month it belongs to.
      const windows = serveMeetings([]);
      renderCalendar();
      await screen.findByRole("button", { name: "Open 2026-03-15" });

      // 1 March 2026 is a Sunday, so this grid has no leading days — but six weeks
      // from there runs to 11 April, and the window has to reach it.
      expect(localDayKey(new Date(windows[0]!.get("from")!))).toBe("2026-03-01");
      expect(new Date(windows[0]!.get("to")!).getTime()).toBeGreaterThan(
        new Date(2026, 3, 11).getTime(),
      );
    });

    it("includes the leading days of a month that does not start on a Sunday", async () => {
      // 1 April 2026 is a Wednesday, so the grid opens on 29 March.
      const windows = serveMeetings([]);
      renderCalendar(OWNER, "/calendar?on=2026-04-15&view=month");
      await screen.findByRole("button", { name: "Open 2026-04-15" });

      expect(localDayKey(new Date(windows[0]!.get("from")!))).toBe("2026-03-29");
    });

    it("collapses a busy day rather than growing the cell", async () => {
      serveMeetings([
        at(2026, 3, 15, 9, { id: "m1", title: "One" }),
        at(2026, 3, 15, 10, { id: "m2", title: "Two" }),
        at(2026, 3, 15, 11, { id: "m3", title: "Three" }),
        at(2026, 3, 15, 12, { id: "m4", title: "Four" }),
      ]);
      renderCalendar();

      expect(await screen.findByText("+1 more")).toBeVisible();
    });

    it("marks today", async () => {
      serveMeetings([]);
      const today = localDayKey(new Date());
      renderCalendar(OWNER, `/calendar?on=${today}&view=month`);

      await waitFor(() =>
        expect(screen.getByRole("button", { name: `Open ${today}` })).toHaveClass("bg-brand-600"),
      );
    });
  });

  describe("navigation", () => {
    it("steps a month at a time and keeps it in the URL", async () => {
      serveMeetings([]);
      const { user } = renderCalendar();
      await screen.findByRole("heading", { name: "March 2026" });

      await user.click(screen.getByRole("button", { name: "Next" }));
      expect(await screen.findByRole("heading", { name: "April 2026" })).toBeVisible();

      await user.click(screen.getByRole("button", { name: "Previous" }));
      expect(await screen.findByRole("heading", { name: "March 2026" })).toBeVisible();
    });

    it("restores the month from the URL, so a link opens where the sender was", async () => {
      serveMeetings([]);
      renderCalendar(OWNER, "/calendar?on=2026-07-04&view=month");

      expect(await screen.findByRole("heading", { name: "July 2026" })).toBeVisible();
    });

    it("falls back to today for an unparseable date", async () => {
      serveMeetings([]);
      renderCalendar(OWNER, "/calendar?on=not-a-date&view=month");

      // Renders something rather than an Invalid Date.
      expect(await screen.findByRole("heading", { name: /\w+ \d{4}/ })).toBeVisible();
    });

    it("opens a day from its cell", async () => {
      serveMeetings([at(2026, 3, 15, 9, { title: "Walkthrough" })]);
      const { user } = renderCalendar();
      await screen.findByRole("button", { name: "Open 2026-03-15" });

      await user.click(screen.getByRole("button", { name: "Open 2026-03-15" }));

      expect(
        await screen.findByRole("heading", { name: "Sunday, March 15, 2026" }),
      ).toBeVisible();
    });
  });

  describe("the day view", () => {
    it("lists the day's meetings with their times", async () => {
      serveMeetings([at(2026, 3, 15, 9, { title: "Walkthrough", location: "12 Oak Street" })]);
      renderCalendar(OWNER, "/calendar?on=2026-03-15&view=day");

      expect(await screen.findByText("Walkthrough")).toBeVisible();
      expect(screen.getByText(/12 Oak Street/)).toBeVisible();
    });

    it("says so when nothing is scheduled", async () => {
      serveMeetings([]);
      renderCalendar(OWNER, "/calendar?on=2026-03-15&view=day");

      expect(await screen.findByText("Nothing scheduled")).toBeVisible();
    });

    it("windows a single day", async () => {
      const windows = serveMeetings([]);
      renderCalendar(OWNER, "/calendar?on=2026-03-15&view=day");
      await waitFor(() => expect(windows).toHaveLength(1));

      expect(localDayKey(new Date(windows[0]!.get("from")!))).toBe("2026-03-15");
      expect(localDayKey(new Date(windows[0]!.get("to")!))).toBe("2026-03-16");
    });

    it("flags a meeting that has a Meet link", async () => {
      serveMeetings([
        at(2026, 3, 15, 9, { title: "Walkthrough", meet_link: "https://meet.google.com/abc" }),
      ]);
      renderCalendar(OWNER, "/calendar?on=2026-03-15&view=day");

      expect(await screen.findByText("Meet")).toBeVisible();
    });
  });

  describe("permissions", () => {
    it("shows the shared calendar to a member", async () => {
      // GET /meetings is deliberately not role-filtered.
      serveMeetings([at(2026, 3, 15, 9, { title: "Walkthrough" })]);
      renderCalendar(MEMBER);

      expect(await screen.findByRole("button", { name: /Walkthrough/ })).toBeVisible();
    });

    it("offers a member no way to create one", async () => {
      serveMeetings([]);
      renderCalendar(MEMBER);
      await screen.findByRole("heading", { name: "March 2026" });

      expect(screen.queryByRole("button", { name: "New meeting" })).not.toBeInTheDocument();
    });

    it("lets a member open a meeting read-only", async () => {
      serveMeetings([at(2026, 3, 15, 9, { title: "Walkthrough" })]);
      const { user } = renderCalendar(MEMBER);

      await user.click(await screen.findByRole("button", { name: /Walkthrough/ }));

      expect(screen.getByLabelText(/^Title/)).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Cancel meeting" })).not.toBeInTheDocument();
    });
  });

  it("reports a failed load with a retry", async () => {
    server.use(http.get(url("/meetings"), () => apiError(500, "internal_error", "Boom.")));
    renderCalendar();

    expect(await screen.findByText("Could not load this")).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });
});

describe("grid geometry", () => {
  it("keeps every cell addressable by its local day key", async () => {
    serveMeetings([]);
    renderCalendar();
    await screen.findByRole("button", { name: "Open 2026-03-15" });

    // The container is the flat 42-cell grid.
    expect(grid()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open 2026-03-01" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open 2026-03-31" })).toBeVisible();
  });
});
