import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils";
import { makeApprovalRequest, makeUser } from "@/test/factories";
import { server } from "@/test/msw/server";
import { apiError, url } from "@/test/msw/handlers";
import type { ApprovalRequestOut, UserOut } from "@/api/types";
import { TeamPage } from "./TeamPage";

const OWNER = makeUser({ id: "u-owner", role: "owner", full_name: "Casey Owner" });
const ADMIN = makeUser({ id: "u-admin", role: "admin", full_name: "Alex Admin" });
const MEMBER = makeUser({ id: "u-member", role: "member", full_name: "Sam Member" });

function serveTeam(users: UserOut[], requests: ApprovalRequestOut[] = []) {
  const calls = { roles: [] as { id: string; role: string }[], banned: [] as string[] };

  server.use(
    http.get(url("/users"), () => HttpResponse.json(users)),
    http.get(url("/approval-requests"), () => HttpResponse.json(requests)),
    http.patch(url("/users/:id/role"), async ({ params, request }) => {
      const body = (await request.json()) as { role: string };
      calls.roles.push({ id: String(params.id), role: body.role });
      return HttpResponse.json(makeUser());
    }),
    http.post(url("/users/:id/ban"), ({ params }) => {
      calls.banned.push(String(params.id));
      return HttpResponse.json(makeUser({ status: "banned" }));
    }),
  );

  return calls;
}

function renderTeam(user = OWNER) {
  return renderWithProviders(<TeamPage />, { user, route: "/team", path: "/team" });
}

const rowFor = (name: string) => screen.getByText(name).closest("li")!;

describe("TeamPage", () => {
  it("lists the active team", async () => {
    serveTeam([OWNER, ADMIN, MEMBER]);
    renderTeam();

    expect(await screen.findByText("Casey Owner")).toBeVisible();
    expect(screen.getByText("Alex Admin")).toBeVisible();
    expect(screen.getByText("3 active")).toBeVisible();
  });

  it("marks which row is you", async () => {
    serveTeam([OWNER, MEMBER]);
    renderTeam(OWNER);
    await screen.findByText("Casey Owner");

    expect(within(rowFor("Casey Owner")).getByText("(you)")).toBeVisible();
  });

  it("separates removed members", async () => {
    serveTeam([OWNER, makeUser({ id: "u-gone", full_name: "Gone Person", status: "banned" })]);
    renderTeam();

    expect(await screen.findByRole("heading", { name: "Removed" })).toBeVisible();
    expect(within(rowFor("Gone Person")).getByText("Removed")).toBeVisible();
  });

  describe("roles", () => {
    it("lets an owner change someone else's role", async () => {
      const calls = serveTeam([OWNER, MEMBER]);
      const { user } = renderTeam(OWNER);
      await screen.findByText("Sam Member");

      await user.selectOptions(screen.getByLabelText("Role for Sam Member"), "admin");

      await waitFor(() => expect(calls.roles).toEqual([{ id: MEMBER.id, role: "admin" }]));
    });

    it("offers no role control for your own row", async () => {
      // Nobody changes their own role — the guard against an admin self-promoting and
      // against the last owner demoting themselves.
      serveTeam([OWNER, MEMBER]);
      renderTeam(OWNER);
      await screen.findByText("Casey Owner");

      expect(screen.queryByLabelText("Role for Casey Owner")).not.toBeInTheDocument();
      expect(within(rowFor("Casey Owner")).getByTitle(/your own role/)).toBeVisible();
    });

    it("withholds the owner role from an admin", async () => {
      serveTeam([ADMIN, MEMBER]);
      renderTeam(ADMIN);
      await screen.findByText("Sam Member");

      const select = screen.getByLabelText("Role for Sam Member");
      const options = within(select).getAllByRole("option").map((o) => o.textContent);
      expect(options).not.toContain("owner");
      expect(options).toContain("admin");
    });

    it("gives an admin no control over an owner", async () => {
      serveTeam([OWNER, ADMIN]);
      renderTeam(ADMIN);
      await screen.findByText("Casey Owner");

      expect(screen.queryByLabelText("Role for Casey Owner")).not.toBeInTheDocument();
    });
  });

  describe("removal", () => {
    it("confirms, then removes", async () => {
      const calls = serveTeam([OWNER, MEMBER]);
      const { user } = renderTeam(OWNER);
      await screen.findByText("Sam Member");

      await user.click(within(rowFor("Sam Member")).getByRole("button", { name: "Remove" }));
      expect(calls.banned).toEqual([]);
      // The consequence is stated: it takes effect at once, not at token expiry.
      expect(screen.getByText(/signed out at once/)).toBeVisible();

      // Two "Remove" buttons once the dialog is open: the row's and the dialog's.
      await user.click(screen.getAllByRole("button", { name: "Remove" }).at(-1)!);
      await waitFor(() => expect(calls.banned).toEqual([MEMBER.id]));
    });

    it("disables removing an owner, and says why", async () => {
      // Demote first, deliberately — which makes locking the team out of its own
      // account a two-step, owner-only act.
      serveTeam([OWNER, ADMIN]);
      renderTeam(ADMIN);
      await screen.findByText("Casey Owner");

      const button = within(rowFor("Casey Owner")).getByRole("button", { name: "Remove" });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", expect.stringContaining("owner cannot be removed"));
    });

    it("disables removing yourself", async () => {
      serveTeam([OWNER, MEMBER]);
      renderTeam(OWNER);
      await screen.findByText("Casey Owner");

      expect(within(rowFor("Casey Owner")).getByRole("button", { name: "Remove" })).toBeDisabled();
    });

    it("stops an admin removing another admin", async () => {
      const other = makeUser({ id: "u-admin-2", role: "admin", full_name: "Other Admin" });
      serveTeam([ADMIN, other]);
      renderTeam(ADMIN);
      await screen.findByText("Other Admin");

      const button = within(rowFor("Other Admin")).getByRole("button", { name: "Remove" });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", expect.stringContaining("only remove members"));
    });

    it("reports a refusal from the server", async () => {
      serveTeam([OWNER, MEMBER]);
      server.use(
        http.post(url("/users/:id/ban"), () =>
          apiError(403, "forbidden", "The owner cannot be removed."),
        ),
      );
      const { user } = renderTeam(OWNER);
      await screen.findByText("Sam Member");

      await user.click(within(rowFor("Sam Member")).getByRole("button", { name: "Remove" }));
      await user.click(screen.getAllByRole("button", { name: "Remove" }).at(-1)!);

      expect(await screen.findByText("The owner cannot be removed.")).toBeVisible();
    });
  });

  describe("access requests", () => {
    it("shows nothing when the queue is empty", async () => {
      serveTeam([OWNER], []);
      renderTeam();
      await screen.findByText("Casey Owner");

      expect(screen.queryByText("Access requests")).not.toBeInTheDocument();
    });

    it("lists a pending request and explains where it came from", async () => {
      serveTeam(
        [OWNER],
        [makeApprovalRequest({ id: "r1", email: "gone@buildco.test", full_name: "Gone Person" })],
      );
      renderTeam();

      expect(await screen.findByText("Gone Person")).toBeVisible();
      expect(screen.getByText(/Filed automatically when someone who was removed/)).toBeVisible();
    });

    it("restores access", async () => {
      const request = makeApprovalRequest({ id: "r1", full_name: "Gone Person" });
      serveTeam([OWNER], [request]);
      const decisions: string[] = [];
      server.use(
        http.post(url("/approval-requests/:id/:decision"), ({ params }) => {
          decisions.push(String(params.decision));
          return HttpResponse.json(request);
        }),
      );

      const { user } = renderTeam();
      await user.click(await screen.findByRole("button", { name: "Restore access" }));

      await waitFor(() => expect(decisions).toEqual(["approve"]));
    });

    it("denies a request", async () => {
      const request = makeApprovalRequest({ id: "r1", full_name: "Gone Person" });
      serveTeam([OWNER], [request]);
      const decisions: string[] = [];
      server.use(
        http.post(url("/approval-requests/:id/:decision"), ({ params }) => {
          decisions.push(String(params.decision));
          return HttpResponse.json(request);
        }),
      );

      const { user } = renderTeam();
      await user.click(await screen.findByRole("button", { name: "Deny" }));

      await waitFor(() => expect(decisions).toEqual(["deny"]));
    });
  });

  it("reports a failed load with a retry", async () => {
    server.use(http.get(url("/users"), () => apiError(500, "internal_error", "Boom.")));
    renderTeam();

    expect(await screen.findByText("Could not load this")).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });
});
