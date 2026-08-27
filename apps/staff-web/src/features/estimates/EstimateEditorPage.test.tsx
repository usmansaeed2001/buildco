import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils";
import { makeEstimate, makeTotals, makeUser } from "@/test/factories";
import { server } from "@/test/msw/server";
import { apiError, url } from "@/test/msw/handlers";
import type { EstimateOut } from "@/api/types";
import { EstimateEditorPage } from "./EstimateEditorPage";

const OWNER = makeUser({ id: "owner-1", role: "owner", full_name: "Casey Owner" });
const MEMBER = makeUser({ id: "member-1", role: "member", full_name: "Sam Member" });

function estimateWith(overrides: Partial<EstimateOut> = {}): EstimateOut {
  return makeEstimate({
    id: "est-1",
    identifier: "CLM-100200",
    project_name: "Water damage — kitchen",
    created_by: OWNER.id,
    rooms: [
      {
        name: "Kitchen",
        items: [
          {
            name: "Drywall",
            category: "drywall",
            unit: "SF",
            quantity: 10,
            unitCost: "2.50",
            isCustom: true,
            catalogueId: null,
            notes: "",
          },
        ],
      },
    ] as unknown as EstimateOut["rooms"],
    totals: makeTotals({ total: "25.00", room_count: 1, item_count: 1 }),
    ...overrides,
  });
}

/** Serves one estimate and records every PATCH body the editor sends. */
function serveEstimate(estimate: EstimateOut) {
  const patches: Record<string, unknown>[] = [];

  server.use(
    http.get(url("/estimates/:id"), () => HttpResponse.json(estimate)),
    http.patch(url("/estimates/:id"), async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      patches.push(body);
      return HttpResponse.json({ ...estimate, ...body });
    }),
  );

  return patches;
}

function renderEditor(user = OWNER) {
  return renderWithProviders(<EstimateEditorPage />, {
    user,
    route: "/estimates/est-1",
    path: "/estimates/:estimateId",
  });
}

/** The editor's own loading state clears once the estimate resolves. */
async function waitForEditor() {
  expect(await screen.findByRole("heading", { name: "Water damage — kitchen" })).toBeVisible();
}

describe("EstimateEditorPage", () => {
  describe("loading", () => {
    it("renders the estimate with its rooms, items and total", async () => {
      serveEstimate(estimateWith());
      renderEditor();
      await waitForEditor();

      expect(screen.getByText("CLM-100200")).toBeVisible();
      expect(screen.getByRole("button", { name: /^Kitchen/ })).toBeVisible();
      expect(screen.getByLabelText("Name for Drywall")).toHaveValue("Drywall");
      expect(screen.getByLabelText("Quantity for Drywall")).toHaveValue("10");
      // Computed locally so it tracks edits, rather than echoing the server's copy.
      expect(screen.getByLabelText("Estimate total")).toHaveTextContent("$25.00");
    });

    it("reads the legacy unit_cost spelling rather than showing zero", async () => {
      serveEstimate(
        estimateWith({
          rooms: [
            { name: "Hall", items: [{ name: "Trim", unit_cost: "7.25", quantity: 2 }] },
          ] as unknown as EstimateOut["rooms"],
        }),
      );
      renderEditor();
      await screen.findByLabelText("Unit cost for Trim");

      expect(screen.getByLabelText("Unit cost for Trim")).toHaveValue("7.25");
      expect(screen.getByLabelText("Estimate total")).toHaveTextContent("$14.50");
    });

    it("offers a way back to the list when the estimate does not exist", async () => {
      server.use(
        http.get(url("/estimates/:id"), () => apiError(404, "not_found", "Not Found")),
      );
      renderEditor();

      expect(await screen.findByText("Could not load this")).toBeVisible();
      expect(screen.getByRole("link", { name: "Back to supplements" })).toBeVisible();
      // A 404 is not worth retrying — the record is gone, not unavailable.
      expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    });
  });

  describe("editing", () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    afterEach(() => vi.useRealTimers());

    it("saves once after the debounce, not once per keystroke", async () => {
      const patches = serveEstimate(estimateWith());
      const { user } = renderEditor();
      await waitForEditor();

      await user.clear(screen.getByLabelText("Quantity for Drywall"));
      await user.type(screen.getByLabelText("Quantity for Drywall"), "12");

      expect(screen.getByText("Unsaved changes")).toBeVisible();
      expect(patches).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1200);

      await waitFor(() => expect(patches).toHaveLength(1));
      expect(screen.getByText("Saved")).toBeVisible();
    });

    it("sends rooms in the shape the request schema demands", async () => {
      const patches = serveEstimate(estimateWith());
      const { user } = renderEditor();
      await waitForEditor();

      await user.clear(screen.getByLabelText("Unit cost for Drywall"));
      await user.type(screen.getByLabelText("Unit cost for Drywall"), "3.5");
      await vi.advanceTimersByTimeAsync(1200);
      await waitFor(() => expect(patches).toHaveLength(1));

      const rooms = patches[0]!.rooms as { items: Record<string, unknown>[] }[];
      // Strings, not numbers — a float in the body is what NUMERIC(12,2) exists to avoid.
      expect(rooms[0]!.items[0]!.unitCost).toBe("3.50");
      expect(rooms[0]!.items[0]!.quantity).toBe("10");
      // No `id`, `status` or `created_at`: EstimateUpdate forbids unknown keys.
      expect(Object.keys(patches[0]!).sort()).toEqual([
        "client_name",
        "insurance_carrier",
        "notes",
        "pm_name",
        "project_name",
        "rooms",
      ]);
    });

    it("does not send a freshly added blank row, which the API would 422", async () => {
      // `LineItem.name` is minLength:1 server-side. Sending the blank row a user has
      // just created would fail the whole PATCH, and every later autosave with it —
      // one empty row would make the estimate permanently unsaveable.
      const patches = serveEstimate(estimateWith());
      const { user } = renderEditor();
      await waitForEditor();

      await user.click(screen.getByRole("button", { name: "+ Add item" }));
      await vi.advanceTimersByTimeAsync(1200);
      await waitFor(() => expect(patches).toHaveLength(1));

      const rooms = patches[0]!.rooms as { items: unknown[] }[];
      expect(rooms[0]!.items).toHaveLength(1);
      // It is still on screen — the editor does not re-seed from the response.
      expect(screen.getByLabelText("Quantity for line 2")).toBeVisible();
      await waitFor(() => expect(screen.getByText("Saved")).toBeVisible());
    });

    it("starts persisting that row as soon as it is named", async () => {
      const patches = serveEstimate(estimateWith());
      const { user } = renderEditor();
      await waitForEditor();

      await user.click(screen.getByRole("button", { name: "+ Add item" }));
      await user.type(screen.getByLabelText("Name for line 2"), "Paint");
      await vi.advanceTimersByTimeAsync(1200);
      await waitFor(() => expect(patches).toHaveLength(1));

      const rooms = patches.at(-1)!.rooms as { items: { name: string }[] }[];
      expect(rooms[0]!.items.map((i) => i.name)).toEqual(["Drywall", "Paint"]);
    });

    it("recomputes the total as you type, before anything is saved", async () => {
      serveEstimate(estimateWith());
      const { user } = renderEditor();
      await waitForEditor();

      await user.clear(screen.getByLabelText("Quantity for Drywall"));
      await user.type(screen.getByLabelText("Quantity for Drywall"), "4");

      expect(screen.getByLabelText("Estimate total")).toHaveTextContent("$10.00");
    });

    it("adds a room and selects it", async () => {
      serveEstimate(estimateWith());
      const { user } = renderEditor();
      await waitForEditor();

      await user.click(screen.getByRole("button", { name: "+ Add room" }));

      expect(screen.getByRole("button", { name: /^Room 2/ })).toHaveAttribute(
        "aria-current",
        "true",
      );
      expect(screen.getByText("No line items in this room")).toBeVisible();
    });

    it("adds a line item to the selected room", async () => {
      serveEstimate(estimateWith());
      const { user } = renderEditor();
      await waitForEditor();

      await user.click(screen.getByRole("button", { name: "+ Add item" }));

      expect(screen.getByLabelText("Quantity for line 2")).toHaveValue("1");
    });

    it("deletes a line item", async () => {
      serveEstimate(estimateWith());
      const { user } = renderEditor();
      await waitForEditor();

      await user.click(screen.getByRole("button", { name: "Delete Drywall" }));

      expect(screen.queryByLabelText("Name for Drywall")).not.toBeInTheDocument();
    });

    it("confirms before deleting a room, and says what is inside it", async () => {
      serveEstimate(estimateWith());
      const { user } = renderEditor();
      await waitForEditor();

      await user.click(screen.getByRole("button", { name: "Delete Kitchen" }));
      expect(screen.getByText(/1 line item/)).toBeVisible();

      await user.click(screen.getByRole("button", { name: "Delete room" }));
      expect(screen.queryByRole("button", { name: /^Kitchen/ })).not.toBeInTheDocument();
    });

    it("renames a room inline instead of through a prompt", async () => {
      serveEstimate(estimateWith());
      const { user } = renderEditor();
      await waitForEditor();

      await user.click(screen.getByRole("button", { name: "Rename Kitchen" }));
      await user.clear(screen.getByLabelText("Room name"));
      await user.type(screen.getByLabelText("Room name"), "Galley{Enter}");

      expect(screen.getByRole("button", { name: /^Galley/ })).toBeVisible();
    });

    it("edits the project details on the second tab", async () => {
      const patches = serveEstimate(estimateWith());
      const { user } = renderEditor();
      await waitForEditor();

      await user.click(screen.getByRole("tab", { name: "Project Details" }));
      await user.clear(screen.getByLabelText("Client name"));
      await user.type(screen.getByLabelText("Client name"), "Alex Client");
      await vi.advanceTimersByTimeAsync(1200);

      await waitFor(() => expect(patches).toHaveLength(1));
      expect(patches[0]!.client_name).toBe("Alex Client");
    });

    it("shows the claim id but does not let it be edited", async () => {
      serveEstimate(estimateWith());
      const { user } = renderEditor();
      await waitForEditor();

      await user.click(screen.getByRole("tab", { name: "Project Details" }));

      expect(screen.getByLabelText("Claim ID")).toHaveValue("CLM-100200");
      expect(screen.getByLabelText("Claim ID")).toHaveAttribute("readonly");
    });
  });

  describe("undo and redo", () => {
    it("has nothing to undo when the editor opens", async () => {
      serveEstimate(estimateWith());
      renderEditor();
      await waitForEditor();

      expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
    });

    it("restores a deleted room, which the legacy editor could not", async () => {
      serveEstimate(estimateWith());
      const { user } = renderEditor();
      await waitForEditor();

      await user.click(screen.getByRole("button", { name: "Delete Kitchen" }));
      await user.click(screen.getByRole("button", { name: "Delete room" }));
      await user.click(screen.getByRole("button", { name: "Undo" }));

      expect(screen.getByRole("button", { name: /^Kitchen/ })).toBeVisible();
      expect(screen.getByLabelText("Name for Drywall")).toHaveValue("Drywall");
    });

    it("reverts a whole field edit rather than one character", async () => {
      serveEstimate(estimateWith());
      const { user } = renderEditor();
      await waitForEditor();

      await user.clear(screen.getByLabelText("Unit cost for Drywall"));
      await user.type(screen.getByLabelText("Unit cost for Drywall"), "375");
      await user.click(screen.getByRole("button", { name: "Undo" }));

      expect(screen.getByLabelText("Unit cost for Drywall")).toHaveValue("2.50");
    });

    it("redoes what it undid", async () => {
      serveEstimate(estimateWith());
      const { user } = renderEditor();
      await waitForEditor();

      await user.click(screen.getByRole("button", { name: "+ Add room" }));
      await user.click(screen.getByRole("button", { name: "Undo" }));
      expect(screen.queryByRole("button", { name: /^Room 2/ })).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Redo" }));
      expect(screen.getByRole("button", { name: /^Room 2/ })).toBeVisible();
    });
  });

  describe("permissions", () => {
    it("is read-only for a member looking at someone else's locked estimate", async () => {
      serveEstimate(estimateWith({ status: "locked" }));
      renderEditor(MEMBER);
      await waitForEditor();

      expect(screen.getByText(/Only the owner can edit it/)).toBeVisible();
      expect(screen.queryByLabelText("Name for Drywall")).not.toBeInTheDocument();
      expect(screen.getByText("Drywall")).toBeVisible();
      expect(screen.queryByRole("button", { name: "+ Add room" })).not.toBeInTheDocument();
    });

    it("stays editable for the owner when locked", async () => {
      serveEstimate(estimateWith({ status: "locked" }));
      renderEditor(OWNER);
      await waitForEditor();

      expect(screen.getByLabelText("Name for Drywall")).toBeEnabled();
    });

    it("offers a member no owner-only transitions", async () => {
      serveEstimate(estimateWith({ created_by: MEMBER.id }));
      renderEditor(MEMBER);
      await waitForEditor();

      expect(screen.queryByRole("button", { name: "Lock" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    });

    it("offers the owner the transitions the backend allows from active", async () => {
      serveEstimate(estimateWith());
      renderEditor(OWNER);
      await waitForEditor();

      expect(screen.getByRole("button", { name: "Approve" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Lock" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Archive" })).toBeVisible();
      // Recall belongs to a submitted estimate, not an active one.
      expect(screen.queryByRole("button", { name: "Recall" })).not.toBeInTheDocument();
    });

    it("blocks editing of a trashed estimate", async () => {
      serveEstimate(estimateWith({ deleted_at: "2026-02-10T09:00:00Z" }));
      renderEditor(OWNER);
      await waitForEditor();

      expect(screen.getByText(/in the trash and cannot be edited/)).toBeVisible();
      expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    });
  });

  describe("transitions", () => {
    it("posts the action the button names", async () => {
      const estimate = estimateWith();
      serveEstimate(estimate);
      const actions: string[] = [];
      server.use(
        http.post(url("/estimates/:id/transitions"), async ({ request }) => {
          const body = (await request.json()) as { action: string };
          actions.push(body.action);
          return HttpResponse.json({ ...estimate, status: "archived" });
        }),
      );

      const { user } = renderEditor();
      await waitForEditor();
      await user.click(screen.getByRole("button", { name: "Archive" }));

      await waitFor(() => expect(actions).toEqual(["archive"]));
    });

    it("reports a refused transition rather than appearing to succeed", async () => {
      serveEstimate(estimateWith());
      server.use(
        http.post(url("/estimates/:id/transitions"), () =>
          apiError(403, "forbidden", "This estimate is locked. Only the owner can edit it."),
        ),
      );

      const { user } = renderEditor();
      await waitForEditor();
      await user.click(screen.getByRole("button", { name: "Archive" }));

      expect(
        await screen.findByText("This estimate is locked. Only the owner can edit it."),
      ).toBeVisible();
    });

    it("confirms before moving an estimate to the trash", async () => {
      serveEstimate(estimateWith());
      let deleted = false;
      server.use(
        http.delete(url("/estimates/:id"), () => {
          deleted = true;
          return HttpResponse.json(estimateWith({ deleted_at: "2026-02-10T09:00:00Z" }));
        }),
      );

      const { user } = renderEditor();
      await waitForEditor();

      await user.click(screen.getByRole("button", { name: "Delete" }));
      expect(deleted).toBe(false);

      await user.click(screen.getByRole("button", { name: "Move to trash" }));
      await waitFor(() => expect(deleted).toBe(true));
    });
  });

  describe("save failures", () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    afterEach(() => vi.useRealTimers());

    it("says so loudly instead of logging to the console like the legacy editor", async () => {
      serveEstimate(estimateWith());
      server.use(
        http.patch(url("/estimates/:id"), () =>
          apiError(403, "forbidden", "This estimate is locked. Only the owner can edit it."),
        ),
      );

      const { user } = renderEditor();
      await waitForEditor();
      await user.clear(screen.getByLabelText("Quantity for Drywall"));
      await user.type(screen.getByLabelText("Quantity for Drywall"), "3");
      await vi.advanceTimersByTimeAsync(1200);

      const alert = await screen.findByRole("alert");
      expect(within(alert).getByText(/Changes are not being saved/)).toBeVisible();
      expect(screen.getByText("Not saved")).toBeVisible();
    });

    it("retries the failed write on demand", async () => {
      serveEstimate(estimateWith());
      let attempts = 0;
      server.use(
        http.patch(url("/estimates/:id"), async ({ request }) => {
          attempts += 1;
          if (attempts === 1) return apiError(503, "integration_unavailable", "Try later.");
          return HttpResponse.json({ ...estimateWith(), ...((await request.json()) as object) });
        }),
      );

      const { user } = renderEditor();
      await waitForEditor();
      await user.clear(screen.getByLabelText("Quantity for Drywall"));
      await user.type(screen.getByLabelText("Quantity for Drywall"), "3");
      await vi.advanceTimersByTimeAsync(1200);

      await screen.findByRole("alert");
      await user.click(screen.getByRole("button", { name: "Retry now" }));

      await waitFor(() => expect(screen.getByText("Saved")).toBeVisible());
      expect(attempts).toBe(2);
    });
  });

  describe("legacy documents", () => {
    it("warns when a stored category will be rewritten on save", async () => {
      serveEstimate(
        estimateWith({
          rooms: [
            { name: "Kitchen", items: [{ name: "Outlet", category: "electrical" }] },
          ] as unknown as EstimateOut["rooms"],
        }),
      );
      renderEditor();
      await waitForEditor();

      expect(screen.getByText(/no longer supports/)).toBeVisible();
      expect(screen.getByLabelText("Category for Outlet")).toHaveValue("other");
    });

    it("says nothing when every category is supported", async () => {
      serveEstimate(estimateWith());
      renderEditor();
      await waitForEditor();

      expect(screen.queryByText(/no longer supports/)).not.toBeInTheDocument();
    });
  });

  describe("change requests", () => {
    it("shows the reviewer's note on demand", async () => {
      serveEstimate(
        estimateWith({
          status: "changes_requested",
          review_note: "Please itemise the flooring separately.",
          reviewed_at: "2026-02-09T15:00:00Z",
        }),
      );

      const { user } = renderEditor();
      await waitForEditor();
      await user.click(screen.getByRole("button", { name: "View changes requested" }));

      expect(screen.getByText("Please itemise the flooring separately.")).toBeVisible();
    });

    it("offers no such button when there is no note", async () => {
      serveEstimate(estimateWith());
      renderEditor();
      await waitForEditor();

      expect(
        screen.queryByRole("button", { name: "View changes requested" }),
      ).not.toBeInTheDocument();
    });
  });

  describe("CSV export", () => {
    it("downloads a file named after the claim id", async () => {
      serveEstimate(estimateWith());
      const clicked: HTMLAnchorElement[] = [];
      Object.defineProperty(URL, "createObjectURL", { value: () => "blob:stub", configurable: true });
      Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, configurable: true });
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        clicked.push(this);
      });

      const { user } = renderEditor();
      await waitForEditor();
      await user.click(screen.getByRole("button", { name: "Export CSV" }));

      expect(clicked).toHaveLength(1);
      expect(clicked[0]!.download).toBe("CLM-100200.csv");
      vi.restoreAllMocks();
    });
  });
});
