import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils";
import {
  makeActivity,
  makeEstimate,
  makeEstimatePage,
  makeMilestone,
  makeProject,
  makeUser,
} from "@/test/factories";
import { server } from "@/test/msw/server";
import { apiError, url } from "@/test/msw/handlers";
import type { MilestoneOut, ProjectOut, SupplementLinkOut } from "@/api/types";
import { ProjectDetailPage } from "./ProjectDetailPage";

const OWNER = makeUser({ id: "owner-1", role: "owner", full_name: "Casey Owner" });
const MEMBER = makeUser({ id: "member-1", role: "member", full_name: "Sam Member" });

function project(overrides: Partial<ProjectOut> = {}): ProjectOut {
  return makeProject({
    id: "proj-1",
    owner_name: "Jordan Homeowner",
    address: "12 Oak Street",
    work_type: "Water damage",
    work_status: "in_progress",
    status: "active",
    total_budget: "10000.00",
    labor_cost: "2000.00",
    materials_cost: "1500.00",
    reimbursements: "500.00",
    amount_collected: "4000.00",
    assigned_to: MEMBER.id,
    ...overrides,
  });
}

interface DetailParts {
  project?: Partial<ProjectOut>;
  milestones?: MilestoneOut[];
  supplements?: SupplementLinkOut[];
  activity?: ReturnType<typeof makeActivity>[];
}

/** Serves the composed detail response and records every mutation. */
function serveProject(parts: DetailParts = {}) {
  const calls = {
    patch: [] as Record<string, unknown>[],
    workStatus: [] as Record<string, unknown>[],
    status: [] as Record<string, unknown>[],
    milestonePatch: [] as Record<string, unknown>[],
    deleted: [] as string[],
  };

  const body = project(parts.project ?? {});

  server.use(
    http.get(url("/projects/proj-1"), () =>
      HttpResponse.json({
        project: body,
        milestones: parts.milestones ?? [],
        supplements: parts.supplements ?? [],
        activity: parts.activity ?? [],
      }),
    ),
    http.patch(url("/projects/proj-1"), async ({ request }) => {
      calls.patch.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(body);
    }),
    http.patch(url("/projects/proj-1/work-status"), async ({ request }) => {
      calls.workStatus.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(body);
    }),
    http.patch(url("/projects/proj-1/status"), async ({ request }) => {
      calls.status.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(body);
    }),
    http.patch(url("/projects/proj-1/milestones/:id"), async ({ request }) => {
      calls.milestonePatch.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(makeMilestone());
    }),
    http.delete(url("/projects/proj-1"), () => {
      calls.deleted.push("proj-1");
      return new HttpResponse(null, { status: 204 });
    }),
  );

  return calls;
}

function renderDetail(user = OWNER) {
  return renderWithProviders(<ProjectDetailPage />, {
    user,
    route: "/projects/proj-1",
    path: "/projects/:projectId",
  });
}

const waitForDetail = () =>
  screen.findByRole("heading", { name: "Jordan Homeowner" });

describe("ProjectDetailPage", () => {
  describe("loading", () => {
    it("shows the project, its work stage and its money", async () => {
      serveProject();
      renderDetail();
      await waitForDetail();

      expect(screen.getByText("12 Oak Street")).toBeVisible();
      expect(screen.getByRole("button", { name: /In Progress/ })).toHaveAttribute(
        "aria-current",
        "step",
      );
      expect(screen.getByLabelText("Labor")).toHaveValue("2000.00");
    });

    it("points a member at the list when the project is not theirs", async () => {
      // The API 404s an unassigned member rather than 403ing — the project's
      // existence is itself privileged.
      server.use(
        http.get(url("/projects/proj-1"), () => apiError(404, "not_found", "Not Found")),
      );
      renderDetail(MEMBER);

      expect(await screen.findByText("Could not load this")).toBeVisible();
      expect(screen.getByRole("link", { name: "Back to projects" })).toBeVisible();
    });
  });

  describe("the derived status is explained, not just displayed", () => {
    it("says why an active project is active", async () => {
      serveProject();
      renderDetail();
      await waitForDetail();

      expect(screen.getByText(/Active while the work is not yet completed/)).toBeVisible();
    });

    it("counts the outstanding milestones on a project awaiting payment", async () => {
      serveProject({
        project: { work_status: "completed", status: "pending_payment" },
        milestones: [
          makeMilestone({ id: "m1", label: "Deposit", paid: true }),
          makeMilestone({ id: "m2", label: "Final", paid: false }),
        ],
      });
      renderDetail();
      await waitForDetail();

      expect(screen.getByText(/1 milestone is unpaid/)).toBeVisible();
    });

    it("explains a closed project with no milestones", async () => {
      serveProject({ project: { work_status: "completed", status: "closed" }, milestones: [] });
      renderDetail();
      await waitForDetail();

      expect(screen.getByText(/no payment milestones were scheduled/)).toBeVisible();
    });

    it("warns when the stored status contradicts the facts", async () => {
      // Should be impossible — it would mean a mutation landed without the rules
      // engine running. Saying so beats rendering a quietly wrong badge.
      serveProject({
        project: { work_status: "in_progress", status: "closed" },
        milestones: [makeMilestone({ paid: false })],
      });
      renderDetail();
      await waitForDetail();

      expect(await screen.findByRole("alert")).toHaveTextContent(/stored as Closed/);
    });
  });

  describe("work status", () => {
    it("sets a stage optimistically", async () => {
      const calls = serveProject();
      const { user } = renderDetail();
      await waitForDetail();

      await user.click(screen.getByRole("button", { name: /Contract Signed/ }));

      await waitFor(() => expect(calls.workStatus).toHaveLength(1));
      expect(calls.workStatus[0]).toEqual({ work_status: "contract_signed" });
    });

    it("rolls back and explains when the server refuses", async () => {
      serveProject();
      server.use(
        http.patch(url("/projects/proj-1/work-status"), () =>
          apiError(403, "forbidden", "You are not assigned to this project."),
        ),
      );
      const { user } = renderDetail();
      await waitForDetail();

      await user.click(screen.getByRole("button", { name: /Contract Signed/ }));

      expect(await screen.findByText("You are not assigned to this project.")).toBeVisible();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /In Progress/ })).toHaveAttribute(
          "aria-current",
          "step",
        ),
      );
    });

    it("lets an assigned member advance the work", async () => {
      // Requiring an admin to record the crew's own progress is how a status board
      // stops matching reality.
      const calls = serveProject();
      const { user } = renderDetail(MEMBER);
      await waitForDetail();

      await user.click(screen.getByRole("button", { name: /Contract Signed/ }));

      await waitFor(() => expect(calls.workStatus).toHaveLength(1));
    });

    it("freezes the stepper on a cancelled project", async () => {
      serveProject({ project: { status: "cancelled" } });
      renderDetail();
      await waitForDetail();

      expect(screen.getByRole("button", { name: /Contract Signed/ })).toBeDisabled();
    });
  });

  describe("status changes", () => {
    it("offers only the statuses the API accepts", async () => {
      serveProject();
      renderDetail();
      await waitForDetail();

      const select = screen.getByLabelText("Set project status");
      const options = within(select).getAllByRole("option").map((o) => o.textContent);

      // `closed` and `pending_payment` are conclusions the rules engine reaches;
      // PATCH /status rejects them with a 422.
      expect(options).not.toContain("Closed");
      expect(options).not.toContain("Pending Payment");
      expect(options).toContain("Cancelled");
    });

    it("does not offer a status control to a member", async () => {
      serveProject();
      renderDetail(MEMBER);
      await waitForDetail();

      expect(screen.queryByLabelText("Set project status")).not.toBeInTheDocument();
    });
  });

  describe("milestones", () => {
    it("toggles paid and sends only that field", async () => {
      const calls = serveProject({
        milestones: [makeMilestone({ id: "m1", label: "Deposit", amount: "2500.00", paid: false })],
      });
      const { user } = renderDetail();
      await waitForDetail();

      await user.click(screen.getByLabelText("Mark Deposit as paid"));

      await waitFor(() => expect(calls.milestonePatch).toHaveLength(1));
      expect(calls.milestonePatch[0]).toEqual({ paid: true });
    });

    it("says a project with no milestones counts as fully paid", async () => {
      serveProject({ milestones: [] });
      renderDetail();
      await waitForDetail();

      expect(screen.getByText(/counts as fully paid/)).toBeVisible();
    });

    it("lets a member add and pay but not delete", async () => {
      serveProject({
        milestones: [makeMilestone({ id: "m1", label: "Deposit", paid: false })],
      });
      renderDetail(MEMBER);
      await waitForDetail();

      expect(screen.getByLabelText("Mark Deposit as paid")).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Delete Deposit" })).not.toBeInTheDocument();
    });

    it("warns that deleting one may change the project status", async () => {
      serveProject({
        milestones: [makeMilestone({ id: "m1", label: "Deposit", paid: false })],
      });
      const { user } = renderDetail();
      await waitForDetail();

      await user.click(screen.getByRole("button", { name: "Delete Deposit" }));

      expect(screen.getByText(/may change the project’s status/)).toBeVisible();
    });
  });

  describe("linked supplements", () => {
    const linked: SupplementLinkOut = {
      id: "link-1",
      project_id: "proj-1",
      estimate_id: "est-9",
      linked_by: null,
      linked_at: "2026-02-01T09:00:00Z",
      estimate: {
        id: "est-9",
        identifier: "CLM-100200",
        project_name: "Kitchen supplement",
        client_name: "Jordan",
        status: "approved",
        total: "1500.00",
      },
    };

    it("rolls linked estimates into the project's revenue", async () => {
      serveProject({ supplements: [linked] });
      renderDetail();
      await waitForDetail();

      // "Linked supplements" appears twice on purpose — as the panel heading and as a
      // line in the budget — so scope to the budget's own line.
      expect(screen.getByText("Total revenue").parentElement).toHaveTextContent("$11,500.00");
      expect(
        screen.getByRole("heading", { name: "Linked supplements" }).parentElement,
      ).toHaveTextContent("$1,500.00");
    });

    it("links an estimate", async () => {
      serveProject();
      const linkedIds: unknown[] = [];
      server.use(
        http.get(url("/estimates"), () =>
          HttpResponse.json(
            makeEstimatePage([
              makeEstimate({
                id: "est-9",
                identifier: "CLM-100200",
                project_name: "Kitchen supplement",
              }),
            ]),
          ),
        ),
        http.post(url("/projects/proj-1/supplements"), async ({ request }) => {
          linkedIds.push(((await request.json()) as { estimate_id: string }).estimate_id);
          return HttpResponse.json(linked);
        }),
      );

      const { user } = renderDetail();
      await waitForDetail();
      // The picker is populated by its own query; wait for it rather than the heading.
      await screen.findByRole("option", { name: /CLM-100200/ });

      await user.selectOptions(screen.getByLabelText("Link an estimate"), "est-9");
      await user.click(screen.getByRole("button", { name: "Link" }));

      await waitFor(() => expect(linkedIds).toEqual(["est-9"]));
    });

    it("explains a duplicate link rather than showing a raw 409", async () => {
      serveProject({ supplements: [linked] });
      server.use(
        http.get(url("/estimates"), () =>
          HttpResponse.json(
            makeEstimatePage([
              makeEstimate({ id: "est-8", identifier: "CLM-2", project_name: "Other" }),
            ]),
          ),
        ),
        http.post(url("/projects/proj-1/supplements"), () =>
          apiError(409, "conflict", "Already linked."),
        ),
      );

      const { user } = renderDetail();
      await waitForDetail();
      await screen.findByRole("option", { name: /CLM-2/ });

      await user.selectOptions(screen.getByLabelText("Link an estimate"), "est-8");
      await user.click(screen.getByRole("button", { name: "Link" }));

      expect(
        await screen.findByText("That estimate is already linked to this project."),
      ).toBeVisible();
    });

    it("unlinks by estimate id, and says the estimate itself survives", async () => {
      serveProject({ supplements: [linked] });
      const unlinked: string[] = [];
      server.use(
        http.delete(url("/projects/proj-1/supplements/:estimateId"), ({ params }) => {
          unlinked.push(String(params.estimateId));
          return new HttpResponse(null, { status: 204 });
        }),
      );

      const { user } = renderDetail();
      await waitForDetail();

      await user.click(screen.getByRole("button", { name: "Unlink CLM-100200" }));

      await waitFor(() => expect(unlinked).toEqual(["est-9"]));
    });
  });

  describe("budget", () => {
    it("computes cost, outstanding and profit from the stored strings", async () => {
      serveProject();
      renderDetail();
      await waitForDetail();

      // 2000 + 1500 + 500 = 4000 cost; 10000 revenue; 4000 collected.
      expect(screen.getByText("Total cost").parentElement).toHaveTextContent("$4,000.00");
      expect(screen.getByText("Outstanding").parentElement).toHaveTextContent("$6,000.00");
      // Collected 4000 − cost 4000 = 0.
      expect(screen.getByText("Profit").parentElement).toHaveTextContent("$0.00");
    });

    it("saves a figure on blur, as a string", async () => {
      const calls = serveProject();
      const { user } = renderDetail();
      await waitForDetail();

      const field = screen.getByLabelText("Labor");
      await user.clear(field);
      await user.type(field, "2500");
      await user.tab();

      await waitFor(() => expect(calls.patch).toHaveLength(1));
      expect(calls.patch[0]).toEqual({ labor_cost: "2500.00" });
    });

    it("refuses a negative figure without sending it", async () => {
      const calls = serveProject();
      const { user } = renderDetail();
      await waitForDetail();

      const field = screen.getByLabelText("Labor");
      await user.clear(field);
      await user.type(field, "-100");
      await user.tab();

      expect(await screen.findByText("That figure cannot be negative.")).toBeVisible();
      expect(calls.patch).toEqual([]);
      // And the field is put back to what the server holds.
      await waitFor(() => expect(screen.getByLabelText("Labor")).toHaveValue("2000.00"));
    });

    it("flags costs that exceed revenue", async () => {
      serveProject({ project: { labor_cost: "9000.00", materials_cost: "5000.00" } });
      renderDetail();
      await waitForDetail();

      expect(screen.getByText(/Costs exceed revenue by/)).toBeVisible();
    });

    it("says nothing to track against when no budget is set", async () => {
      serveProject({ project: { total_budget: "0.00" } });
      renderDetail();
      await waitForDetail();

      expect(screen.getByText(/No budget set/)).toBeVisible();
    });

    it("is read-only for a member", async () => {
      serveProject();
      renderDetail(MEMBER);
      await waitForDetail();

      expect(screen.getByLabelText("Labor")).toBeDisabled();
    });
  });

  describe("activity", () => {
    it("shows what happened and who did it", async () => {
      serveProject({
        activity: [
          makeActivity({ id: "a1", action: "Milestone paid", details: "Deposit", user_name: "Casey Owner" }),
        ],
      });
      renderDetail();
      await waitForDetail();

      expect(screen.getByText("Milestone paid")).toBeVisible();
      expect(screen.getByText(/Casey Owner/)).toBeVisible();
    });

    it("says so when nothing has happened yet", async () => {
      serveProject({ activity: [] });
      renderDetail();
      await waitForDetail();

      expect(screen.getByText("Nothing recorded yet.")).toBeVisible();
    });
  });

  describe("deleting", () => {
    it("warns that there is no trash for projects", async () => {
      const calls = serveProject();
      const { user } = renderDetail();
      await waitForDetail();

      await user.click(screen.getByRole("button", { name: "Delete project" }));
      expect(screen.getByText(/there is no trash for projects/)).toBeVisible();
      expect(calls.deleted).toEqual([]);

      await user.click(screen.getByRole("button", { name: "Delete permanently" }));
      await waitFor(() => expect(calls.deleted).toEqual(["proj-1"]));
    });

    it("is not offered to a member", async () => {
      serveProject();
      renderDetail(MEMBER);
      await waitForDetail();

      expect(screen.queryByRole("button", { name: "Delete project" })).not.toBeInTheDocument();
    });
  });
});
