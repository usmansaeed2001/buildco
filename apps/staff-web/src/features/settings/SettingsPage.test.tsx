import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils";
import { makeUser } from "@/test/factories";
import { server } from "@/test/msw/server";
import { apiError, url } from "@/test/msw/handlers";
import type { CatalogueItemOut, TeamSettingsOut } from "@/api/types";
import { SettingsPage } from "./SettingsPage";

const OWNER = makeUser({ id: "u-owner", role: "owner" });
const MEMBER = makeUser({ id: "u-member", role: "member" });

function settings(overrides: Partial<TeamSettingsOut> = {}): TeamSettingsOut {
  return {
    custom_units: [],
    custom_categories: [],
    notification_prefs: { estimate_locked: true, member_joined: true, member_removed: true },
    updated_at: "2026-02-01T09:00:00Z",
    updated_by: null,
    ...overrides,
  };
}

function rate(overrides: Partial<CatalogueItemOut> = {}): CatalogueItemOut {
  return {
    id: "rate-1",
    name: "Drywall",
    category: "drywall",
    unit: "SF",
    unit_cost: "2.50",
    notes: "",
    created_by: null,
    created_at: "2026-02-01T09:00:00Z",
    updated_at: "2026-02-01T09:00:00Z",
    ...overrides,
  };
}

function serveSettings({
  team = settings(),
  catalogue = [] as CatalogueItemOut[],
} = {}) {
  const calls = {
    patched: [] as Record<string, unknown>[],
    created: [] as Record<string, unknown>[],
    deleted: [] as string[],
  };

  server.use(
    http.get(url("/settings"), () => HttpResponse.json(team)),
    http.get(url("/catalogue-items"), () => HttpResponse.json(catalogue)),
    http.patch(url("/settings"), async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      calls.patched.push(body);
      return HttpResponse.json({ ...team, ...body });
    }),
    http.post(url("/catalogue-items"), async ({ request }) => {
      calls.created.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(rate());
    }),
    http.delete(url("/catalogue-items/:id"), ({ params }) => {
      calls.deleted.push(String(params.id));
      return HttpResponse.json({ ok: true });
    }),
  );

  return calls;
}

function renderSettings(user = OWNER) {
  return renderWithProviders(<SettingsPage />, { user, route: "/settings", path: "/settings" });
}

describe("SettingsPage", () => {
  it("says these are shared, not per-browser", async () => {
    // The whole point of the phase: in the legacy app this was localStorage, so the
    // "universal" rate list was neither universal nor visible to anyone else.
    serveSettings();
    renderSettings();

    expect(
      await screen.findByText("Shared by the whole team, not just this browser."),
    ).toBeVisible();
  });

  describe("the rate list", () => {
    it("lists rates with their prices", async () => {
      serveSettings({ catalogue: [rate({ name: "Drywall", unit_cost: "2.50" })] });
      renderSettings();

      expect(await screen.findByText("Drywall")).toBeVisible();
      expect(screen.getByText("$2.50")).toBeVisible();
    });

    it("says so when there are none", async () => {
      serveSettings();
      renderSettings();

      expect(await screen.findByText("No rates yet.")).toBeVisible();
    });

    it("adds a rate, sending money as a string", async () => {
      const calls = serveSettings();
      const { user } = renderSettings();
      await screen.findByText("No rates yet.");

      await user.type(screen.getByLabelText("Item"), "Baseboard");
      await user.type(screen.getByLabelText("Unit cost"), "3.75");
      await user.click(screen.getByRole("button", { name: "Add rate" }));

      await waitFor(() => expect(calls.created).toHaveLength(1));
      expect(calls.created[0]).toMatchObject({ name: "Baseboard", unit_cost: "3.75" });
    });

    it("refuses a negative price where it was typed", async () => {
      serveSettings();
      const { user } = renderSettings();
      await screen.findByText("No rates yet.");

      await user.type(screen.getByLabelText("Item"), "Baseboard");
      await user.type(screen.getByLabelText(/Unit cost/), "-1");

      expect(screen.getByText("Cannot be negative.")).toBeVisible();
      expect(screen.getByRole("button", { name: "Add rate" })).toBeDisabled();
    });

    it("says quoted estimates keep their prices before removing one", async () => {
      const calls = serveSettings({ catalogue: [rate({ name: "Drywall" })] });
      const { user } = renderSettings();
      await screen.findByText("Drywall");

      await user.click(screen.getByRole("button", { name: "Remove Drywall" }));
      expect(screen.getByText(/keep their prices/)).toBeVisible();
      expect(calls.deleted).toEqual([]);

      await user.click(screen.getAllByRole("button", { name: "Remove" }).at(-1)!);
      await waitFor(() => expect(calls.deleted).toEqual(["rate-1"]));
    });
  });

  describe("custom units and categories", () => {
    it("shows built-ins as unremovable alongside the custom ones", async () => {
      serveSettings({ team: settings({ custom_units: ["Roll"] }) });
      renderSettings();

      await screen.findByText("Roll");
      expect(screen.getAllByTitle("Built in — cannot be removed").length).toBeGreaterThan(0);
      expect(screen.getByRole("button", { name: "Remove Roll" })).toBeVisible();
    });

    it("adds one", async () => {
      const calls = serveSettings();
      const { user } = renderSettings();
      await screen.findByLabelText("Add to custom units");

      await user.type(screen.getByLabelText("Add to custom units"), "Roll");
      await user.click(screen.getByRole("button", { name: "Add unit" }));

      await waitFor(() => expect(calls.patched).toHaveLength(1));
      expect(calls.patched[0]).toEqual({ custom_units: ["Roll"] });
    });

    it("refuses a duplicate of a built-in", async () => {
      // Two entries that mean the same thing is a dropdown nobody can use.
      serveSettings();
      const { user } = renderSettings();
      await screen.findByLabelText("Add to custom units");

      await user.type(screen.getByLabelText("Add to custom units"), "sf");

      expect(screen.getByText("Already in the list.")).toBeVisible();
    });

    it("removes one", async () => {
      const calls = serveSettings({ team: settings({ custom_units: ["Roll", "Bundle"] }) });
      const { user } = renderSettings();
      await screen.findByText("Roll");

      await user.click(screen.getByRole("button", { name: "Remove Roll" }));

      await waitFor(() => expect(calls.patched).toHaveLength(1));
      expect(calls.patched[0]).toEqual({ custom_units: ["Bundle"] });
    });
  });

  describe("notifications", () => {
    it("shows every toggle enabled by default", async () => {
      serveSettings();
      renderSettings();

      expect(await screen.findByLabelText(/New member/)).toBeChecked();
      expect(screen.getByLabelText(/Estimate locked/)).toBeChecked();
    });

    it("sends only the switch that moved", async () => {
      // The API merges rather than replaces, so sending the whole map would be a way
      // to reset toggles nobody touched.
      const calls = serveSettings();
      const { user } = renderSettings();

      await user.click(await screen.findByLabelText(/New member/));

      await waitFor(() => expect(calls.patched).toHaveLength(1));
      expect(calls.patched[0]).toEqual({ notification_prefs: { member_joined: false } });
    });

    it("reflects a stored preference", async () => {
      serveSettings({
        team: settings({
          notification_prefs: {
            estimate_locked: true,
            member_joined: false,
            member_removed: true,
          },
        }),
      });
      renderSettings();

      expect(await screen.findByLabelText(/New member/)).not.toBeChecked();
    });

    it("says access attempts are deliberately not switchable", async () => {
      serveSettings();
      renderSettings();

      expect(await screen.findByText(/security signal rather than a routine update/)).toBeVisible();
    });
  });

  describe("a member", () => {
    it("can read but not change anything", async () => {
      serveSettings({ team: settings({ custom_units: ["Roll"] }), catalogue: [rate()] });
      renderSettings(MEMBER);

      expect(await screen.findByText(/only an owner or admin can/)).toBeVisible();
      expect(screen.getByLabelText(/New member/)).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Add rate" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Remove Roll" })).not.toBeInTheDocument();
      // But the rate list itself is readable — the estimate editor needs it.
      expect(screen.getByText("Drywall")).toBeVisible();
    });
  });

  it("reports a failed load with a retry", async () => {
    server.use(http.get(url("/settings"), () => apiError(500, "internal_error", "Boom.")));
    renderSettings();

    expect(await screen.findByText("Could not load this")).toBeVisible();
  });
});
