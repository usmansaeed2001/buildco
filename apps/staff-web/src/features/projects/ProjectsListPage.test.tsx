import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils";
import { makeProject, makeProjectPage, makeUser } from "@/test/factories";
import { server } from "@/test/msw/server";
import { url } from "@/test/msw/handlers";
import type { ProjectOut } from "@/api/types";
import { ProjectsListPage } from "./ProjectsListPage";

const OWNER = makeUser({ id: "owner-1", role: "owner" });
const MEMBER = makeUser({ id: "member-1", role: "member" });

/** Serves the list, recording the query the page asked for. */
function serveProjects(projects: ProjectOut[]) {
  const queries: URLSearchParams[] = [];
  server.use(
    http.get(url("/projects"), ({ request }) => {
      queries.push(new URL(request.url).searchParams);
      return HttpResponse.json(makeProjectPage(projects));
    }),
  );
  return queries;
}

function renderList(user = OWNER, route = "/projects") {
  return renderWithProviders(<ProjectsListPage />, { user, route, path: "/projects" });
}

const ACTIVE = makeProject({
  id: "p1",
  owner_name: "Jordan Homeowner",
  address: "12 Oak Street",
  work_type: "Water damage",
  status: "active",
  total_budget: "10000.00",
  amount_collected: "2500.00",
});

const CLOSED = makeProject({
  id: "p2",
  owner_name: "Riley Client",
  address: "8 Elm Road",
  work_type: "Fire restoration",
  status: "closed",
  total_budget: "0.00",
});

describe("ProjectsListPage", () => {
  it("lists projects with their statuses", async () => {
    serveProjects([ACTIVE, CLOSED]);
    renderList();

    expect(await screen.findByText("Jordan Homeowner")).toBeVisible();
    expect(screen.getByText("Riley Client")).toBeVisible();
    expect(screen.getByText("2 projects")).toBeVisible();
  });

  it("shows collection progress, and says so when no budget is set", async () => {
    serveProjects([ACTIVE, CLOSED]);
    renderList();
    await screen.findByText("Jordan Homeowner");

    expect(screen.getByText("$2,500.00 of $10,000.00 collected")).toBeVisible();
    // A bar at 0% would read as "nothing collected", which is a different claim.
    expect(screen.getByText("No budget set")).toBeVisible();
  });

  it("filters by status through the query string", async () => {
    const queries = serveProjects([ACTIVE]);
    const { user } = renderList();
    await screen.findByText("Jordan Homeowner");

    await user.click(screen.getByRole("button", { name: "Pending Payment" }));

    await waitFor(() => expect(queries.at(-1)!.get("status")).toBe("pending_payment"));
  });

  it("offers derived statuses as filters even though nobody can set them", async () => {
    // "What is waiting on money" is the most common question this screen answers.
    serveProjects([ACTIVE]);
    renderList();
    await screen.findByText("Jordan Homeowner");

    expect(screen.getByRole("button", { name: "Closed" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Pending Payment" })).toBeVisible();
  });

  it("searches on owner, address and work type without a request per keystroke", async () => {
    const queries = serveProjects([ACTIVE, CLOSED]);
    const { user } = renderList();
    await screen.findByText("Jordan Homeowner");
    const before = queries.length;

    await user.type(screen.getByLabelText("Search projects"), "Elm");

    expect(screen.getByText("Riley Client")).toBeVisible();
    expect(screen.queryByText("Jordan Homeowner")).not.toBeInTheDocument();
    expect(queries).toHaveLength(before);
  });

  it("restores the filter from the URL, so a refresh keeps it", async () => {
    const queries = serveProjects([ACTIVE]);
    renderList(OWNER, "/projects?status=closed");

    await waitFor(() => expect(queries[0]!.get("status")).toBe("closed"));
    expect(screen.getByRole("button", { name: "Closed" })).toHaveAttribute("aria-pressed", "true");
  });

  describe("creating", () => {
    it("offers a New project button to an elevated user", async () => {
      serveProjects([]);
      renderList(OWNER);

      expect(await screen.findByRole("button", { name: "New project" })).toBeVisible();
    });

    it("offers none to a member, and says why the list is empty", async () => {
      serveProjects([]);
      renderList(MEMBER);

      expect(await screen.findByText("You have not been assigned to any projects.")).toBeVisible();
      expect(screen.queryByRole("button", { name: "New project" })).not.toBeInTheDocument();
    });

    it("creates a project and sends money as a string", async () => {
      serveProjects([]);
      const bodies: Record<string, unknown>[] = [];
      server.use(
        http.post(url("/projects"), async ({ request }) => {
          bodies.push((await request.json()) as Record<string, unknown>);
          return HttpResponse.json(makeProject({ id: "new-1" }));
        }),
      );

      const { user } = renderList();
      await user.click(await screen.findByRole("button", { name: "New project" }));

      await user.type(screen.getByLabelText("Home owner"), "Jordan Homeowner");
      await user.type(screen.getByLabelText("Address"), "12 Oak Street");
      await user.type(screen.getByLabelText("Total budget"), "10000");
      await user.click(screen.getByRole("button", { name: "Create project" }));

      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0]).toMatchObject({
        owner_name: "Jordan Homeowner",
        address: "12 Oak Street",
        total_budget: "10000.00",
      });
      // An empty date is not a date; the field is nullable and must be omitted.
      expect(bodies[0]).not.toHaveProperty("start_date");
      expect(bodies[0]).not.toHaveProperty("assigned_to");
    });

    it("refuses a negative budget where it was typed", async () => {
      // Every money field is Field(ge=0) server-side, and the validation envelope's
      // message is generic — catching it here lets the field say what is wrong.
      serveProjects([]);
      const { user } = renderList();
      await user.click(await screen.findByRole("button", { name: "New project" }));

      await user.type(screen.getByLabelText("Home owner"), "Jordan");
      await user.type(screen.getByLabelText(/Total budget/), "-500");

      expect(screen.getByText("A budget cannot be negative.")).toBeVisible();
      expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
    });

    it("will not create a project with neither owner nor address", async () => {
      serveProjects([]);
      const { user } = renderList();
      await user.click(await screen.findByRole("button", { name: "New project" }));

      expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
      expect(screen.getByText("Give the project an owner or an address.")).toBeVisible();

      await user.type(screen.getByLabelText("Address"), "12 Oak Street");
      expect(screen.getByRole("button", { name: "Create project" })).toBeEnabled();
    });
  });
});
