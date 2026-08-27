import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils";
import { makeReviewDecision, makeReviewEstimate } from "@/test/factories";
import { server } from "@/test/msw/server";
import { apiError, url } from "@/test/msw/handlers";
import type { ReviewEstimateOut } from "@/api/types";
import { ReviewPage } from "./ReviewPage";

const TOKEN = "tok-abc123";

function serveReview(estimate: ReviewEstimateOut = makeReviewEstimate()) {
  server.use(http.get(url(`/public/reviews/${TOKEN}`), () => HttpResponse.json(estimate)));
}

/** Records every decision POST, so a test can prove one did *not* happen. */
function captureDecisions() {
  const calls: { path: string; body: unknown; auth: string | null }[] = [];

  for (const action of ["approve", "reject", "request-changes"] as const) {
    server.use(
      http.post(url(`/public/reviews/${TOKEN}/${action}`), async ({ request }) => {
        const body = request.body ? await request.json().catch(() => null) : null;
        calls.push({ path: action, body, auth: request.headers.get("Authorization") });
        return HttpResponse.json(
          makeReviewDecision({ status: action === "reject" ? "rejected" : "approved" }),
        );
      }),
    );
  }

  return calls;
}

function renderReview(search = "") {
  // `user: null` is the whole point: reviewers have no account and never will.
  return renderWithProviders(<ReviewPage />, {
    user: null,
    route: `/review/${TOKEN}${search}`,
    path: "/review/:token",
  });
}

describe("ReviewPage", () => {
  describe("rendering the estimate", () => {
    it("shows the estimate with no signed-in user at all", async () => {
      serveReview();
      renderReview();

      expect(
        await screen.findByRole("heading", { name: "Water damage — kitchen" }),
      ).toBeVisible();
      expect(screen.getByText("CLM-100200")).toBeVisible();
      expect(screen.getByText("Jordan Homeowner")).toBeVisible();
      expect(screen.getByText("Drywall")).toBeVisible();
      expect(screen.getByLabelText("Estimate total")).toHaveTextContent("$25.00");
    });

    it("sends no Authorization header", async () => {
      serveReview();
      const calls = captureDecisions();
      const { user } = renderReview();

      await screen.findByRole("button", { name: "Approve" });
      await user.click(screen.getByRole("button", { name: "Approve" }));
      await user.click(screen.getAllByRole("button", { name: "Approve" })[1]!);

      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]!.auth).toBeNull();
    });

    it("renders an estimate with no line items rather than an empty page", async () => {
      serveReview(makeReviewEstimate({ rooms: [], room_count: 0, item_count: 0, total: "0.00" }));
      renderReview();

      expect(await screen.findByText("This estimate has no line items.")).toBeVisible();
    });

    it("shows a note the reviewer previously left", async () => {
      serveReview(makeReviewEstimate({ review_note: "Itemise the flooring separately." }));
      renderReview();

      expect(await screen.findByText("Itemise the flooring separately.")).toBeVisible();
    });
  });

  describe("unusable links", () => {
    it("tells a reviewer they already decided, rather than showing a generic error", async () => {
      server.use(
        http.get(url(`/public/reviews/${TOKEN}`), () =>
          apiError(410, "gone", "This estimate has already been approved."),
        ),
      );
      renderReview();

      expect(
        await screen.findByRole("heading", { name: "This estimate has already been reviewed" }),
      ).toBeVisible();
      expect(screen.getByText("This estimate has already been approved.")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    });

    it("distinguishes an invalid link from a spent one", async () => {
      server.use(
        http.get(url(`/public/reviews/${TOKEN}`), () =>
          apiError(404, "not_found", "This review link is not valid."),
        ),
      );
      renderReview();

      expect(
        await screen.findByRole("heading", { name: "This review link is not valid" }),
      ).toBeVisible();
    });

    it("falls back to a plain explanation for anything else", async () => {
      server.use(
        http.get(url(`/public/reviews/${TOKEN}`), () =>
          apiError(500, "internal_error", "Something went wrong."),
        ),
      );
      renderReview();

      expect(
        await screen.findByRole("heading", { name: "This estimate could not be loaded" }),
      ).toBeVisible();
    });
  });

  describe("emailed ?action links", () => {
    it("opens the approve confirmation without approving anything", async () => {
      serveReview();
      const calls = captureDecisions();
      renderReview("?action=approve");

      // The confirmation is open — but nothing has been sent. This is the whole reason
      // these endpoints moved from GET to POST: a prefetching email client or security
      // scanner must not be able to approve an estimate by following a link.
      expect(
        await screen.findByRole("heading", { name: "Approve this estimate?" }),
      ).toBeVisible();
      expect(calls).toHaveLength(0);
    });

    it("opens the reject confirmation without rejecting anything", async () => {
      serveReview();
      const calls = captureDecisions();
      renderReview("?action=reject");

      expect(await screen.findByRole("heading", { name: "Reject this estimate?" })).toBeVisible();
      expect(calls).toHaveLength(0);
    });

    it("opens the changes form without sending anything", async () => {
      serveReview();
      const calls = captureDecisions();
      renderReview("?action=changes");

      expect(await screen.findByLabelText(/What needs to change\?/)).toBeVisible();
      expect(calls).toHaveLength(0);
    });

    it("ignores an action it does not recognise", async () => {
      serveReview();
      renderReview("?action=delete-everything");

      await screen.findByRole("button", { name: "Approve" });
      expect(
        screen.queryByRole("heading", { name: "Approve this estimate?" }),
      ).not.toBeInTheDocument();
    });
  });

  describe("recording a decision", () => {
    it("approves only after an explicit confirmation, and shows a receipt", async () => {
      serveReview();
      const calls = captureDecisions();
      const { user } = renderReview();

      await user.click(await screen.findByRole("button", { name: "Approve" }));
      expect(calls).toHaveLength(0);

      // The second "Approve" is the one inside the confirmation dialog.
      await user.click(screen.getAllByRole("button", { name: "Approve" })[1]!);

      await waitFor(() => expect(calls.map((c) => c.path)).toEqual(["approve"]));
      expect(await screen.findByText(/has been approved/)).toBeVisible();
      expect(screen.queryByRole("button", { name: "Request changes" })).not.toBeInTheDocument();
    });

    it("rejects after confirmation", async () => {
      serveReview();
      const calls = captureDecisions();
      const { user } = renderReview();

      await user.click(await screen.findByRole("button", { name: "Reject" }));
      await user.click(screen.getAllByRole("button", { name: "Reject" })[1]!);

      await waitFor(() => expect(calls.map((c) => c.path)).toEqual(["reject"]));
    });

    it("sends the note with a change request", async () => {
      serveReview();
      const calls = captureDecisions();
      const { user } = renderReview();

      await user.click(await screen.findByRole("button", { name: "Request changes" }));
      await user.type(
        screen.getByLabelText(/What needs to change\?/),
        "Itemise the flooring separately.",
      );
      await user.click(screen.getByRole("button", { name: "Send request" }));

      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]!.path).toBe("request-changes");
      expect(calls[0]!.body).toEqual({ notes: "Itemise the flooring separately." });
    });

    it("will not send an empty change request, which the API rejects as 422", async () => {
      serveReview();
      const { user } = renderReview();

      await user.click(await screen.findByRole("button", { name: "Request changes" }));

      expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
      await user.type(screen.getByLabelText(/What needs to change\?/), "   ");
      expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
    });

    it("keeps a failure on the page — a reviewer has no session to fall back on", async () => {
      serveReview();
      server.use(
        http.post(url(`/public/reviews/${TOKEN}/approve`), () =>
          apiError(410, "gone", "This estimate has already been approved."),
        ),
      );
      const { user } = renderReview();

      await user.click(await screen.findByRole("button", { name: "Approve" }));
      await user.click(screen.getAllByRole("button", { name: "Approve" })[1]!);

      expect(
        await screen.findByText("This estimate has already been approved."),
      ).toBeVisible();
      // Still on the estimate, so they can see what they were deciding on.
      expect(screen.getByRole("heading", { name: "Water damage — kitchen" })).toBeVisible();
    });
  });

  describe("an estimate already decided", () => {
    it("offers no buttons when the decision is no longer pending", async () => {
      serveReview(makeReviewEstimate({ decision_pending: false, status: "approved" }));
      renderReview();

      expect(await screen.findByText(/already Approved/)).toBeVisible();
      expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
    });

    it("ignores an ?action link once a decision exists", async () => {
      serveReview(makeReviewEstimate({ decision_pending: false, status: "approved" }));
      renderReview("?action=approve");

      await screen.findByText(/already Approved/);
      expect(
        screen.queryByRole("heading", { name: "Approve this estimate?" }),
      ).not.toBeInTheDocument();
    });
  });
});
