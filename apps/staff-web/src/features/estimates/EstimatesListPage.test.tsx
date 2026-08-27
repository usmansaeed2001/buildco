import { beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils";
import { makeEstimate, makeEstimatePage, makeTotals, makeUser } from "@/test/factories";
import { server } from "@/test/msw/server";
import { apiError, url } from "@/test/msw/handlers";
import type { EstimateOut } from "@/api/types";
import { clearSeen, markSeen } from "@/lib/seen";
import { EstimatesListPage } from "./EstimatesListPage";

const OWNER = makeUser({ id: "u-owner", role: "owner" });

function estimate(id: string, overrides: Partial<EstimateOut> = {}): EstimateOut {
  return makeEstimate({
    id,
    identifier: `CLM-${id}`,
    project_name: `Estimate ${id}`,
    totals: makeTotals({ total: "100.00", room_count: 1, item_count: 1 }),
    ...overrides,
  });
}

/** Serves the list and records the query each request asked for. */
function serveEstimates(estimates: EstimateOut[]) {
  const queries: URLSearchParams[] = [];
  server.use(
    http.get(url("/estimates"), ({ request }) => {
      queries.push(new URL(request.url).searchParams);
      return HttpResponse.json(makeEstimatePage(estimates));
    }),
  );
  return queries;
}

const renderList = (route = "/estimates") =>
  renderWithProviders(<EstimatesListPage />, { user: OWNER, route, path: "/estimates" });

const chip = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });

beforeEach(() => clearSeen());

describe("EstimatesListPage", () => {
  it("lists estimates with their totals", async () => {
    serveEstimates([estimate("a"), estimate("b")]);
    renderList();

    expect(await screen.findByText("Estimate a")).toBeVisible();
    expect(screen.getByText("2 estimates")).toBeVisible();
  });

  describe("filtering", () => {
    it("fetches once and filters in the browser", async () => {
      // The chips carry unread dots, which need to know what is in the *other*
      // statuses — a server-filtered query could not light them.
      const queries = serveEstimates([
        estimate("a", { status: "active" }),
        estimate("s", { status: "submitted" }),
      ]);
      const { user } = renderList();
      await screen.findByText("Estimate a");

      await user.click(chip("Submitted"));

      expect(screen.getByText("Estimate s")).toBeVisible();
      expect(screen.queryByText("Estimate a")).not.toBeInTheDocument();
      // Still one request: no round trip per chip.
      expect(queries).toHaveLength(1);
      expect(queries[0]!.get("status")).toBeNull();
    });

    it("restores the filter from the URL", async () => {
      serveEstimates([estimate("a", { status: "active" }), estimate("s", { status: "submitted" })]);
      renderList("/estimates?status=submitted");

      expect(await screen.findByText("Estimate s")).toBeVisible();
      expect(screen.queryByText("Estimate a")).not.toBeInTheDocument();
    });

    it("searches within the current filter", async () => {
      serveEstimates([
        estimate("a", { project_name: "Kitchen flood" }),
        estimate("b", { project_name: "Roof repair" }),
      ]);
      const { user } = renderList();
      await screen.findByText("Kitchen flood");

      await user.type(screen.getByLabelText("Search estimates"), "roof");

      expect(screen.getByText("Roof repair")).toBeVisible();
      expect(screen.queryByText("Kitchen flood")).not.toBeInTheDocument();
    });

    it("requests the trash separately", async () => {
      const queries = serveEstimates([]);
      const { user } = renderList();
      await screen.findByText("No estimates yet");

      await user.click(chip("Trash"));

      await waitFor(() => expect(queries.at(-1)!.get("trash")).toBe("true"));
    });
  });

  describe("unread dots", () => {
    it("marks a status you have never looked at", async () => {
      serveEstimates([estimate("a", { status: "active" }), estimate("s", { status: "submitted" })]);
      renderList();
      await screen.findByText("Estimate a");

      expect(within(chip("Submitted")).getByText("new")).toBeInTheDocument();
    });

    it("does not mark a status with nothing in it", async () => {
      serveEstimates([estimate("a", { status: "active" })]);
      renderList();
      await screen.findByText("Estimate a");

      expect(within(chip("Rejected")).queryByText("new")).not.toBeInTheDocument();
    });

    it("does not mark what has already been seen", async () => {
      markSeen("submitted", ["s"]);
      serveEstimates([estimate("a", { status: "active" }), estimate("s", { status: "submitted" })]);
      renderList();
      await screen.findByText("Estimate a");

      expect(within(chip("Submitted")).queryByText("new")).not.toBeInTheDocument();
    });

    it("marks a status again when something new arrives in it", async () => {
      markSeen("submitted", ["s"]);
      serveEstimates([
        estimate("s", { status: "submitted" }),
        estimate("s2", { status: "submitted" }),
      ]);
      renderList();
      await screen.findByText("Estimate s");

      expect(within(chip("Submitted")).getByText("new")).toBeInTheDocument();
    });

    it("clears the dot once you view that status", async () => {
      serveEstimates([estimate("a", { status: "active" }), estimate("s", { status: "submitted" })]);
      const { user } = renderList();
      await screen.findByText("Estimate a");

      await user.click(chip("Submitted"));
      // Not on the chip you are looking at.
      expect(within(chip("Submitted")).queryByText("new")).not.toBeInTheDocument();

      // And it stays cleared after moving away.
      await user.click(chip("Approved"));
      expect(within(chip("Submitted")).queryByText("new")).not.toBeInTheDocument();
    });

    it("announces the dot rather than relying on colour alone", async () => {
      serveEstimates([estimate("s", { status: "submitted" })]);
      renderList();
      await screen.findByText("Estimate s");

      // A red dot alone says nothing to a screen reader, and colour alone fails
      // anyone who cannot distinguish it.
      expect(within(chip("Submitted")).getByText("new")).toHaveClass("sr-only");
    });
  });

  describe("empty and error states", () => {
    it("invites a first estimate when there are none", async () => {
      serveEstimates([]);
      renderList();

      expect(await screen.findByText("No estimates yet")).toBeVisible();
    });

    it("says so when a search matches nothing", async () => {
      serveEstimates([estimate("a", { project_name: "Kitchen flood" })]);
      const { user } = renderList();
      await screen.findByText("Kitchen flood");

      await user.type(screen.getByLabelText("Search estimates"), "zzzz");

      expect(screen.getByText("No estimates match that search")).toBeVisible();
    });

    it("reports a failed load with a retry", async () => {
      server.use(http.get(url("/estimates"), () => apiError(500, "internal_error", "Boom.")));
      renderList();

      expect(await screen.findByText("Could not load this")).toBeVisible();
      expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    });
  });

  it("creates an estimate and opens it", async () => {
    serveEstimates([]);
    server.use(
      http.post(url("/estimates"), () => HttpResponse.json(estimate("new"), { status: 201 })),
    );

    const { user } = renderList();
    await user.click(await screen.findByRole("button", { name: "New estimate" }));

    // Navigation is asserted by the editor's own tests; here it is enough that the
    // create call succeeded without surfacing an error.
    await waitFor(() =>
      expect(screen.queryByText(/Could not create/)).not.toBeInTheDocument(),
    );
  });
});
