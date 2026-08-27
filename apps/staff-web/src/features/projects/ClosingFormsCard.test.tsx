import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils";
import { makeProject } from "@/test/factories";
import { server } from "@/test/msw/server";
import { apiError, url } from "@/test/msw/handlers";
import type { ProjectOut } from "@/api/types";
import { ClosingFormsCard } from "./ClosingFormsCard";

const PROJECT_ID = "proj-1";
const SIGNED_PATH = "https://storage.googleapis.com/bucket/projects/proj-1/closing-forms/1_1.png";

function project(overrides: Partial<ProjectOut> = {}): ProjectOut {
  return makeProject({ id: PROJECT_ID, ...overrides });
}

/** Records every PUT body, keyed by form number. */
function serveSubmit() {
  const submitted: { form: string; data: Record<string, unknown> }[] = [];
  server.use(
    http.put(url("/projects/:id/closing-forms/:form"), async ({ request, params }) => {
      const body = (await request.json()) as { data: Record<string, unknown> };
      submitted.push({ form: String(params.form), data: body.data });
      return HttpResponse.json(project());
    }),
  );
  return submitted;
}

function renderCard(p: ProjectOut = project(), canSubmit = true) {
  return renderWithProviders(<ClosingFormsCard project={p} canSubmit={canSubmit} />);
}

describe("ClosingFormsCard", () => {
  describe("the card", () => {
    it("lists both forms as not submitted", () => {
      renderCard();

      expect(screen.getByText("MATERIAL SIGN-OFF")).toBeVisible();
      expect(screen.getByText("PROJECT SIGN-OFF")).toBeVisible();
      expect(screen.getAllByText("Not submitted")).toHaveLength(2);
    });

    it("says what submitting both will do, before it happens", () => {
      // "Fill in this form" and "fill in this form and the project closes" are
      // different asks.
      renderCard();
      expect(screen.getByText(/closes the project if every milestone is paid/)).toBeVisible();
    });

    it("marks a submitted form as such", () => {
      renderCard(
        project({
          closing_form_1: { cf1_signature: "Jordan" },
          closing_form_submitted_at: "2026-03-01T10:00:00Z",
        }),
      );

      expect(screen.getByText(/Submitted Mar 1, 2026/)).toBeVisible();
      expect(screen.getByText("Not submitted")).toBeVisible();
    });

    it("treats an empty stored object as not submitted, matching the backend", () => {
      // `bool(project.closing_form_1)` server-side. Showing it as submitted would leave
      // someone waiting for a project to close that never will.
      renderCard(project({ closing_form_1: {} }));
      expect(screen.getAllByText("Not submitted")).toHaveLength(2);
    });

    it("offers only View when the user cannot submit", () => {
      renderCard(project(), false);
      expect(screen.getAllByRole("button", { name: "View" })).toHaveLength(2);
      expect(screen.queryByRole("button", { name: "Fill in" })).not.toBeInTheDocument();
    });
  });

  describe("filling in form 1", () => {
    it("shows the letterhead and the legal wording", async () => {
      const { user } = renderCard();
      await user.click(screen.getAllByRole("button", { name: "Fill in" })[0]!);

      expect(screen.getByText("FKA: L A Handy Construction")).toBeVisible();
      expect(screen.getByText("Lic. # 942121")).toBeVisible();
      expect(screen.getByText(/re-stocking fee charged by the supplier/)).toBeVisible();
    });

    it("requires a signature before it can be submitted", async () => {
      const { user } = renderCard();
      await user.click(screen.getAllByRole("button", { name: "Fill in" })[0]!);

      expect(screen.getByRole("button", { name: "Submit form" })).toBeDisabled();
      expect(screen.getByText(/A signature is required/)).toBeVisible();

      await user.type(screen.getByLabelText("Signature"), "Jordan Homeowner");
      expect(screen.getByRole("button", { name: "Submit form" })).toBeEnabled();
    });

    it("submits only the keys the form defines, trimmed", async () => {
      const submitted = serveSubmit();
      const { user } = renderCard();
      await user.click(screen.getAllByRole("button", { name: "Fill in" })[0]!);

      await user.type(screen.getByLabelText("Signatory name"), "  Jordan Homeowner  ");
      await user.type(screen.getByLabelText("Brand"), "Mohawk");
      await user.type(screen.getByLabelText("Signature"), "Jordan Homeowner");
      await user.click(screen.getByRole("button", { name: "Submit form" }));

      await waitFor(() => expect(submitted).toHaveLength(1));
      expect(submitted[0]!.form).toBe("1");
      expect(submitted[0]!.data).toEqual({
        cf1_signatory: "Jordan Homeowner",
        cf1_brand: "Mohawk",
        cf1_signature: "Jordan Homeowner",
      });
      // Blank fields are omitted rather than stored as empty strings.
      expect(submitted[0]!.data).not.toHaveProperty("cf1_sku");
    });

    it("warns when this is the second form", async () => {
      const { user } = renderCard(project({ closing_form_2: { cf2_owner_sig: "Jordan" } }));
      await user.click(screen.getByRole("button", { name: "Fill in" }));

      expect(screen.getByText(/Submitting it marks the work complete/)).toBeVisible();
    });

    it("does not warn when the other form is still outstanding", async () => {
      const { user } = renderCard();
      await user.click(screen.getAllByRole("button", { name: "Fill in" })[0]!);

      expect(screen.queryByText(/Submitting it marks the work complete/)).not.toBeInTheDocument();
    });
  });

  describe("form 2", () => {
    it("carries the exact contractual terms", async () => {
      const { user } = renderCard();
      await user.click(screen.getAllByRole("button", { name: "Fill in" })[1]!);

      expect(screen.getByText(/no less than \$250 per day/)).toBeVisible();
      expect(
        screen.getByText(
          "Work outside of the original contract will require a new contract/ scope of work.",
        ),
      ).toBeVisible();
    });

    it("requires both signatures", async () => {
      const { user } = renderCard();
      await user.click(screen.getAllByRole("button", { name: "Fill in" })[1]!);

      await user.type(screen.getByLabelText("Home Owner Signature"), "Jordan");
      expect(screen.getByRole("button", { name: "Submit form" })).toBeDisabled();

      await user.type(screen.getByLabelText("Contractor Signature"), "Casey");
      expect(screen.getByRole("button", { name: "Submit form" })).toBeEnabled();
    });

    it("has no photo field", async () => {
      const { user } = renderCard();
      await user.click(screen.getAllByRole("button", { name: "Fill in" })[1]!);

      expect(screen.queryByLabelText("Material photo")).not.toBeInTheDocument();
    });
  });

  describe("the material photo", () => {
    it("uploads it and stores the key, not the image", async () => {
      // The legacy app stored a base64 data URI inside the JSONB column, which bloated
      // every project-detail read for every project.
      const submitted = serveSubmit();
      server.use(
        http.post(url(`/projects/${PROJECT_ID}/closing-forms/1/photo-upload-url`), () =>
          HttpResponse.json({
            upload_url: SIGNED_PATH,
            storage_path: "projects/proj-1/closing-forms/1_1.png",
            required_headers: { "Content-Type": "image/png" },
            expires_in: 900,
          }),
        ),
        http.put(SIGNED_PATH, () => new HttpResponse(null, { status: 200 })),
      );
      // jsdom implements neither.
      Object.defineProperty(URL, "createObjectURL", { value: () => "blob:x", configurable: true });

      const { user } = renderCard();
      await user.click(screen.getAllByRole("button", { name: "Fill in" })[0]!);

      await user.upload(
        screen.getByLabelText("Material photo"),
        new File(["x"], "material.png", { type: "image/png" }),
      );
      await waitFor(() => expect(screen.getByAltText("Material")).toBeVisible());

      await user.type(screen.getByLabelText("Signature"), "Jordan");
      await user.click(screen.getByRole("button", { name: "Submit form" }));

      await waitFor(() => expect(submitted).toHaveLength(1));
      expect(submitted[0]!.data.material_photo_path).toBe(
        "projects/proj-1/closing-forms/1_1.png",
      );
    });

    it("says the form is still submittable when storage is unconfigured", async () => {
      server.use(
        http.post(url(`/projects/${PROJECT_ID}/closing-forms/1/photo-upload-url`), () =>
          apiError(503, "integration_unavailable", "Cloud Storage is not configured."),
        ),
      );
      Object.defineProperty(URL, "createObjectURL", { value: () => "blob:x", configurable: true });

      const { user } = renderCard();
      await user.click(screen.getAllByRole("button", { name: "Fill in" })[0]!);
      await user.upload(
        screen.getByLabelText("Material photo"),
        new File(["x"], "material.png", { type: "image/png" }),
      );

      expect(await screen.findByText(/rest of the form can still be submitted/)).toBeVisible();
    });
  });

  describe("a submitted form", () => {
    it("opens read-only, and can be reopened for a correction", async () => {
      const { user } = renderCard(
        project({ closing_form_1: { cf1_signature: "Jordan", cf1_brand: "Mohawk" } }),
      );

      await user.click(screen.getByRole("button", { name: "View" }));

      // Read-only: the values render as text, not as inputs.
      expect(screen.queryByLabelText("Brand")).not.toBeInTheDocument();
      expect(screen.getByText("Mohawk")).toBeVisible();

      // These are signed in a driveway on a phone; a typo must be fixable.
      await user.click(screen.getByRole("button", { name: "Edit" }));
      expect(screen.getByLabelText("Brand")).toHaveValue("Mohawk");
    });

    it("offers no Edit to someone who cannot submit", async () => {
      const { user } = renderCard(project({ closing_form_1: { cf1_signature: "Jordan" } }), false);

      await user.click(screen.getAllByRole("button", { name: "View" })[0]!);

      expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    });

    it("prints the document rather than the page", async () => {
      const print = vi.fn();
      vi.stubGlobal("print", print);

      const { user } = renderCard();
      await user.click(screen.getAllByRole("button", { name: "Fill in" })[0]!);
      await user.click(screen.getByRole("button", { name: "Print" }));

      expect(print).toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  });

  describe("failures", () => {
    it("keeps a rejected submission on screen with the values intact", async () => {
      server.use(
        http.put(url("/projects/:id/closing-forms/:form"), () =>
          apiError(403, "forbidden", "You are not assigned to this project."),
        ),
      );

      const { user } = renderCard();
      await user.click(screen.getAllByRole("button", { name: "Fill in" })[0]!);
      await user.type(screen.getByLabelText("Signature"), "Jordan");
      await user.click(screen.getByRole("button", { name: "Submit form" }));

      expect(await screen.findByText("You are not assigned to this project.")).toBeVisible();
      expect(screen.getByLabelText("Signature")).toHaveValue("Jordan");
    });
  });
});
