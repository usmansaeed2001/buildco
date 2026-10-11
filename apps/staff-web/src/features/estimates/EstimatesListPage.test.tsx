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

/**
 * Serves the list and records the query each request asked for.
 *
 * The stub *applies* the filters rather than returning everything, because the screen no
 * longer filters in the browser — status, search and the date window are all the API's
 * job now. A stub that ignored them would let a page that sends the wrong parameters
 * pass every test.
 */
function serveEstimates(estimates: EstimateOut[]) {
  const queries: URLSearchParams[] = [];
  server.use(
    http.get(url("/estimates"), ({ request }) => {
      const query = new URL(request.url).searchParams;
      queries.push(query);

      const status = query.get("status");
      const needle = query.get("q")?.toLowerCase();
      const limit = Number(query.get("limit") ?? 24);
      const offset = Number(query.get("offset") ?? 0);

      const matching = estimates.filter((row) => {
        if (status && row.status !== status) return false;
        if (needle && !row.project_name.toLowerCase().includes(needle)) return false;
        return true;
      });

      return HttpResponse.json({
        ...makeEstimatePage(matching.slice(offset, offset + limit)),
        total: matching.length,
        limit,
        offset,
      });
    }),
  );
  return queries;
}

/**
 * Serves the id/status listing that lights the unread dots.
 *
 * Separate from the list on purpose: the dots have to know what is in the statuses you
 * are *not* looking at, which a paginated, status-filtered list cannot tell them.
 */
function serveIds(estimates: EstimateOut[]) {
  server.use(
    http.get(url("/estimates/ids"), () =>
      HttpResponse.json(estimates.map(({ id, status }) => ({ id, status }))),
    ),
  );
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
    it("asks the server for the status, rather than filtering in the browser", async () => {
      // Deliberately reversed. This used to be one 200-row request filtered in memory,
      // which is a correctness bug once the list is paginated: page two would be
      // filtered against only the rows page two happens to hold.
      const queries = serveEstimates([
        estimate("a", { status: "active" }),
        estimate("s", { status: "submitted" }),
      ]);
      const { user } = renderList();
      await screen.findByText("Estimate a");

      await user.click(chip("Submitted"));

      expect(await screen.findByText("Estimate s")).toBeVisible();
      expect(screen.queryByText("Estimate a")).not.toBeInTheDocument();
      await waitFor(() => expect(queries.at(-1)!.get("status")).toBe("submitted"));
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

      expect(await screen.findByText("Roof repair")).toBeVisible();
      // Waited for rather than asserted immediately: the previous page is deliberately
      // kept on screen while the next one loads, so paging does not collapse the list to
      // a spinner and jump the scroll position.
      await waitFor(() => expect(screen.queryByText("Kitchen flood")).not.toBeInTheDocument());
    });

    it("debounces the search rather than requesting per keystroke", async () => {
      const queries = serveEstimates([estimate("a", { project_name: "Kitchen flood" })]);
      const { user } = renderList();
      await screen.findByText("Kitchen flood");
      const before = queries.length;

      await user.type(screen.getByLabelText("Search estimates"), "kitchen");

      // Seven characters must not become seven round trips.
      await waitFor(() => expect(queries.at(-1)!.get("q")).toBe("kitchen"));
      expect(queries.length - before).toBeLessThan(7);
    });

    it("sends a local day boundary for the date window, not a UTC one", async () => {
      // An estimate created at 6pm in Los Angeles is already "tomorrow" in UTC, so
      // filtering on a raw date string would file it under the wrong day.
      const queries = serveEstimates([estimate("a")]);
      const { user } = renderList();
      await screen.findByText("Estimate a");

      await user.type(screen.getByLabelText("Created from"), "2026-03-01");

      await waitFor(() => expect(queries.at(-1)!.get("created_from")).toBeTruthy());
      const sent = new Date(queries.at(-1)!.get("created_from")!);
      expect(sent.getFullYear()).toBe(2026);
      expect(sent.getMonth()).toBe(2);
      expect(sent.getDate()).toBe(1);
      expect(sent.getHours()).toBe(0);
    });

    it("returns to the first page when the filters change", async () => {
      // Narrowing a list while on page three would otherwise show an empty page.
      const queries = serveEstimates(
        Array.from({ length: 40 }, (_, i) => estimate(`e${i}`, { status: "active" })),
      );
      const { user } = renderList();
      await screen.findByRole("button", { name: "Next" });

      await user.click(screen.getByRole("button", { name: "Next" }));
      await waitFor(() => expect(queries.at(-1)!.get("offset")).toBe("24"));

      await user.click(chip("Submitted"));

      await waitFor(() => expect(queries.at(-1)!.get("offset")).toBe("0"));
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
    // The dots are now fed by `GET /estimates/ids`, not by the list. They have to know
    // what is in the statuses you are *not* looking at, which a paginated, status-
    // filtered list cannot tell them — before pagination that worked only because the
    // screen happened to load every row at once.

    it("marks a status you have never looked at", async () => {
      serveEstimates([estimate("a", { status: "active" }), estimate("s", { status: "submitted" })]);
      serveIds([estimate("a", { status: "active" }), estimate("s", { status: "submitted" })]);
      renderList();
      await screen.findByText("Estimate a");

      expect(within(chip("Submitted")).getByText("new")).toBeInTheDocument();
    });

    it("does not mark a status with nothing in it", async () => {
      serveEstimates([estimate("a", { status: "active" })]);
      serveIds([estimate("a", { status: "active" })]);
      renderList();
      await screen.findByText("Estimate a");

      expect(within(chip("Rejected")).queryByText("new")).not.toBeInTheDocument();
    });

    it("does not mark what has already been seen", async () => {
      markSeen("submitted", ["s"]);
      serveEstimates([estimate("a", { status: "active" }), estimate("s", { status: "submitted" })]);
      serveIds([estimate("a", { status: "active" }), estimate("s", { status: "submitted" })]);
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
      serveIds([
        estimate("s", { status: "submitted" }),
        estimate("s2", { status: "submitted" }),
      ]);
      renderList();
      await screen.findByText("Estimate s");

      expect(within(chip("Submitted")).getByText("new")).toBeInTheDocument();
    });

    it("clears the dot once you view that status", async () => {
      serveEstimates([estimate("a", { status: "active" }), estimate("s", { status: "submitted" })]);
      serveIds([estimate("a", { status: "active" }), estimate("s", { status: "submitted" })]);
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
      serveIds([estimate("s", { status: "submitted" })]);
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

      expect(await screen.findByText("Nothing matches these filters")).toBeVisible();
    });

    it("reports a failed load with a retry", async () => {
      server.use(http.get(url("/estimates"), () => apiError(500, "internal_error", "Boom.")));
      renderList();

      expect(await screen.findByText("Could not load this")).toBeVisible();
      expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    });
  });

  describe("creating", () => {
    /** Serves POST /estimates and records what was actually sent. */
    function serveCreate() {
      const bodies: Record<string, unknown>[] = [];
      server.use(
        http.post(url("/estimates"), async ({ request }) => {
          bodies.push((await request.json()) as Record<string, unknown>);
          return HttpResponse.json(estimate("new"), { status: 201 });
        }),
      );
      return bodies;
    }

    it("asks for a name instead of creating an unnamed estimate immediately", async () => {
      // It used to POST an empty body and jump to the editor, which is why every row on
      // this list read the same.
      const bodies = serveCreate();
      const { user } = renderList();

      await user.click(await screen.findByRole("button", { name: "New estimate" }));

      expect(await screen.findByRole("dialog")).toBeVisible();
      expect(bodies).toHaveLength(0);
    });

    it("will not create without a name", async () => {
      serveCreate();
      const { user } = renderList();
      await user.click(await screen.findByRole("button", { name: "New estimate" }));

      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();
    });

    it("sends the name, client and claim id", async () => {
      const bodies = serveCreate();
      const { user } = renderList();
      await user.click(await screen.findByRole("button", { name: "New estimate" }));

      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByLabelText(/Project name/), "11196 Schuyler Ave");
      await user.type(within(dialog).getByLabelText(/Client name/), "Acme");
      await user.type(within(dialog).getByLabelText(/Claim ID/), "0833781057");
      await user.click(within(dialog).getByRole("button", { name: "Create" }));

      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0]).toEqual({
        project_name: "11196 Schuyler Ave",
        client_name: "Acme",
        identifier: "0833781057",
      });
    });

    it("omits a blank claim id rather than sending an empty one", async () => {
      // The server reads an absent identifier as "generate one" and a blank one as
      // invalid, so the difference matters.
      const bodies = serveCreate();
      const { user } = renderList();
      await user.click(await screen.findByRole("button", { name: "New estimate" }));

      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByLabelText(/Project name/), "Roof job");
      await user.click(within(dialog).getByRole("button", { name: "Create" }));

      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0]).not.toHaveProperty("identifier");
    });

    it("keeps a duplicate claim id on screen beside the field", async () => {
      serveEstimates([]);
      server.use(
        http.post(url("/estimates"), () =>
          apiError(409, "conflict", "Claim ID 'DUP-1' is already used by another estimate."),
        ),
      );
      const { user } = renderList();
      await user.click(await screen.findByRole("button", { name: "New estimate" }));

      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByLabelText(/Project name/), "Roof job");
      await user.type(within(dialog).getByLabelText(/Claim ID/), "DUP-1");
      await user.click(within(dialog).getByRole("button", { name: "Create" }));

      // In the dialog, not a toast: the fix is to edit the field still on screen.
      expect(await within(dialog).findByText(/already used by another estimate/)).toBeVisible();
      expect(within(dialog).getByLabelText(/Claim ID/)).toHaveValue("DUP-1");
    });
  });

  describe("sorting", () => {
    it("opens on most recently edited", async () => {
      // Requested explicitly rather than relying on the API default, which stays
      // newest-created so no other caller is reordered underneath.
      const queries = serveEstimates([estimate("a")]);
      renderList();

      await waitFor(() => expect(queries).toHaveLength(1));
      expect(queries[0]!.get("sort")).toBe("recently_edited");
    });

    it("asks the server for the chosen order", async () => {
      const queries = serveEstimates([estimate("a")]);
      const { user } = renderList();
      await screen.findByText("Estimate a");

      await user.selectOptions(screen.getByLabelText("Sort by"), "highest_total");

      await waitFor(() => expect(queries.at(-1)!.get("sort")).toBe("highest_total"));
    });

    it("restores the sort from the URL", async () => {
      const queries = serveEstimates([estimate("a")]);
      renderList("/estimates?sort=client_name");

      await waitFor(() => expect(queries).toHaveLength(1));
      expect(queries[0]!.get("sort")).toBe("client_name");
      expect(screen.getByLabelText("Sort by")).toHaveValue("client_name");
    });

    it("ignores an unknown sort in the URL rather than sending it", async () => {
      const queries = serveEstimates([estimate("a")]);
      renderList("/estimates?sort=cheapest");

      await waitFor(() => expect(queries).toHaveLength(1));
      expect(queries[0]!.get("sort")).toBe("recently_edited");
    });

    it("returns to the first page when the sort changes", async () => {
      const queries = serveEstimates(
        Array.from({ length: 40 }, (_, i) => estimate(`e${i}`)),
      );
      const { user } = renderList();
      await screen.findByRole("button", { name: "Next" });
      await user.click(screen.getByRole("button", { name: "Next" }));
      await waitFor(() => expect(queries.at(-1)!.get("offset")).toBe("24"));

      await user.selectOptions(screen.getByLabelText("Sort by"), "client_name");

      await waitFor(() => expect(queries.at(-1)!.get("offset")).toBe("0"));
    });
  });

  describe("the card", () => {
    it("names an unnamed estimate by its claim id", async () => {
      // `project_name` defaulted to the literal "New Estimate" until this round, so
      // rows created by the old flow are not unnamed — they are all named the same
      // thing. Treating that as unnamed is what makes them tellable apart.
      serveEstimates([estimate("a", { project_name: "New Estimate" })]);
      renderList();

      expect(await screen.findByText(/Untitled/)).toBeVisible();
      expect(screen.getAllByText("CLM-a").length).toBeGreaterThan(0);
    });

    it("names an estimate created with a blank name by its claim id", async () => {
      serveEstimates([estimate("a", { project_name: "" })]);
      renderList();

      expect(await screen.findByText(/Untitled/)).toBeVisible();
    });

    it("shows when it was last edited, not when it was created", async () => {
      serveEstimates([
        estimate("a", {
          created_at: "2020-01-01T00:00:00Z",
          updated_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        }),
      ]);
      renderList();

      expect(await screen.findByText(/edited 2 hours ago/)).toBeVisible();
    });

    it("says an unpriced estimate is unpriced rather than shouting zero", async () => {
      serveEstimates([
        estimate("a", { totals: makeTotals({ total: "0.00", room_count: 0, item_count: 0 }) }),
      ]);
      renderList();

      expect(await screen.findByText("Not priced yet")).toBeVisible();
      expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    });

    it("still shows a real zero when there are rooms", async () => {
      // Zero with rooms in it is a figure somebody arrived at, not an absence.
      serveEstimates([
        estimate("a", { totals: makeTotals({ total: "0.00", room_count: 2, item_count: 0 }) }),
      ]);
      renderList();

      expect(await screen.findByText("$0.00")).toBeVisible();
      expect(screen.queryByText("Not priced yet")).not.toBeInTheDocument();
    });
  });

  describe("loading", () => {
    it("holds the grid's shape with skeletons rather than a spinner", async () => {
      // A centred spinner threw the layout away and rebuilt it: the toolbar sat above a
      // void, then the cards appeared and shoved the pager down the page.
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      server.use(
        http.get(url("/estimates"), async () => {
          await held;
          return HttpResponse.json(makeEstimatePage([estimate("a")]));
        }),
      );

      renderList();

      expect(await screen.findByRole("status", { name: "Loading estimates" })).toBeVisible();
      release?.();
      expect(await screen.findByText("Estimate a")).toBeVisible();
      expect(screen.queryByRole("status", { name: "Loading estimates" })).not.toBeInTheDocument();
    });

    it("says it is loading rather than showing a stale count", async () => {
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      server.use(
        http.get(url("/estimates"), async () => {
          await held;
          return HttpResponse.json(makeEstimatePage([estimate("a")]));
        }),
      );

      renderList();

      expect(await screen.findByText("Loading…")).toBeVisible();
      release?.();
      expect(await screen.findByText("1 estimate")).toBeVisible();
    });
  });

  describe("pagination", () => {
    const manyEstimates = () =>
      serveEstimates(Array.from({ length: 100 }, (_, i) => estimate(`e${i}`)));

    it("offers numbered pages, not just previous and next", async () => {
      manyEstimates();
      renderList();
      await screen.findByRole("button", { name: "Next" });

      // 100 rows at 24 a page is five pages. First and last are always offered, so the
      // end of the list is one click away however long it gets; the middle collapses.
      expect(screen.getByRole("button", { name: "Page 1" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Page 2" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Page 5" })).toBeVisible();
      expect(screen.queryByRole("button", { name: "Page 3" })).not.toBeInTheDocument();
    });

    it("jumps straight to a numbered page", async () => {
      const queries = manyEstimates();
      const { user } = renderList();
      await screen.findByRole("button", { name: "Page 5" });

      await user.click(screen.getByRole("button", { name: "Page 5" }));

      await waitFor(() => expect(queries.at(-1)!.get("offset")).toBe("96"));
    });

    it("marks the current page for screen readers, not just visually", async () => {
      manyEstimates();
      renderList();

      expect(await screen.findByRole("button", { name: "Page 1" })).toHaveAttribute(
        "aria-current",
        "page",
      );
    });

    it("reports the range on show", async () => {
      manyEstimates();
      renderList();

      expect(await screen.findByText("Showing 1–24 of 100 estimates")).toBeVisible();
    });

    it("disables previous on the first page and next on the last", async () => {
      manyEstimates();
      const { user } = renderList();
      await screen.findByRole("button", { name: "Page 5" });
      expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

      await user.click(screen.getByRole("button", { name: "Page 5" }));

      await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeDisabled());
    });

    it("shows no pager when everything fits on one page", async () => {
      serveEstimates([estimate("a")]);
      renderList();
      await screen.findByText("Estimate a");

      // A control that can only ever be disabled is clutter.
      expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    });
  });

  describe("row actions", () => {
    const openMenu = async (user: ReturnType<typeof renderList>["user"]) => {
      await user.click(screen.getByRole("button", { name: /Actions for/ }));
    };

    it("archives without leaving the list", async () => {
      serveEstimates([estimate("a")]);
      const actions: string[] = [];
      server.use(
        http.post(url("/estimates/:id/transitions"), async ({ request }) => {
          actions.push(((await request.json()) as { action: string }).action);
          return HttpResponse.json(estimate("a", { status: "archived" }));
        }),
      );
      const { user } = renderList();
      await screen.findByText("Estimate a");

      await openMenu(user);
      await user.click(screen.getByRole("menuitem", { name: "Archive" }));

      await waitFor(() => expect(actions).toEqual(["archive"]));
    });

    it("offers unarchive on an archived estimate", async () => {
      serveEstimates([estimate("a", { status: "archived" })]);
      const { user } = renderList("/estimates?status=archived");
      await screen.findByText("Estimate a");

      await openMenu(user);

      expect(screen.getByRole("menuitem", { name: "Unarchive" })).toBeVisible();
    });

    it("does not offer archiving to a member", async () => {
      // Owner/admin only per the transition matrix. The API enforces it either way;
      // this keeps the menu from offering something that would only 403.
      serveEstimates([estimate("a")]);
      const { user } = renderWithProviders(<EstimatesListPage />, {
        user: makeUser({ id: "u-member", role: "member" }),
        route: "/estimates",
        path: "/estimates",
      });
      await screen.findByText("Estimate a");

      await openMenu(user);

      expect(screen.queryByRole("menuitem", { name: "Archive" })).not.toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    });

    it.each(["locked", "submitted", "changes_requested"] as const)(
      "does not offer archiving on a %s estimate, even to an owner",
      async (status) => {
        // The API answers 409 from these statuses. Offering it on a locked estimate was
        // also a way round the lock: archive it, then unarchive it back to active.
        serveEstimates([estimate("a", { status })]);
        const { user } = renderList();
        await screen.findByText("Estimate a");

        await openMenu(user);

        expect(screen.queryByRole("menuitem", { name: "Archive" })).not.toBeInTheDocument();
        expect(screen.queryByRole("menuitem", { name: "Unarchive" })).not.toBeInTheDocument();
        expect(screen.getByRole("menuitem", { name: "Delete" })).toBeVisible();
      },
    );

    it.each(["active", "rejected", "approved"] as const)(
      "offers archiving on a %s estimate",
      async (status) => {
        serveEstimates([estimate("a", { status })]);
        const { user } = renderList();
        await screen.findByText("Estimate a");

        await openMenu(user);

        expect(screen.getByRole("menuitem", { name: "Archive" })).toBeVisible();
      },
    );

    it("confirms before moving an estimate to the trash", async () => {
      serveEstimates([estimate("a")]);
      const deleted: string[] = [];
      server.use(
        http.delete(url("/estimates/:id"), ({ params: p }) => {
          deleted.push(String(p["id"]));
          return HttpResponse.json(estimate("a"));
        }),
      );
      const { user } = renderList();
      await screen.findByText("Estimate a");

      await openMenu(user);
      await user.click(screen.getByRole("menuitem", { name: "Delete" }));
      expect(deleted).toHaveLength(0);

      await user.click(await screen.findByRole("button", { name: "Move to trash" }));

      await waitFor(() => expect(deleted).toEqual(["a"]));
    });

    it("closes the menu on Escape", async () => {
      serveEstimates([estimate("a")]);
      const { user } = renderList();
      await screen.findByText("Estimate a");
      await openMenu(user);
      expect(screen.getByRole("menu")).toBeVisible();

      await user.keyboard("{Escape}");

      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("opening the menu does not navigate", async () => {
      // The card is a stretched link, so the menu button has to sit above it rather
      // than inside the anchor — a button nested in an <a> navigates on click.
      serveEstimates([estimate("a")]);
      const { user } = renderList();
      await screen.findByText("Estimate a");

      await openMenu(user);

      expect(screen.getByRole("menu")).toBeVisible();
      expect(screen.getByText("Estimate a")).toBeVisible();
    });
  });
});
