/**
 * The public review flow.
 *
 * Every request here passes `anonymous: true`, so no Authorization header is attached
 * and a 401 does not trigger the sign-out path in `client.ts`. Reviewers are external —
 * an insurance adjuster opening a link from an email — and have no account at all.
 *
 * The token in the URL *is* the credential, which is why these are the only endpoints
 * whose responses expose nothing about the team: no user ids, no author, no other
 * estimates.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "./keys";
import type { RequestChangesRequest, ReviewDecisionOut, ReviewEstimateOut } from "../types";

export function useReviewEstimate(token: string | undefined) {
  return useQuery({
    queryKey: queryKeys.review(token ?? ""),
    queryFn: () =>
      apiFetch<ReviewEstimateOut>(`/public/reviews/${token}`, { anonymous: true }),
    enabled: Boolean(token),
    // A spent link returns 410 and an invalid one 404. Neither is worth retrying, and
    // retrying makes the reviewer stare at a spinner before being told the same thing.
    retry: false,
  });
}

export type ReviewDecision = "approve" | "reject" | "request-changes";

/**
 * Record the reviewer's decision.
 *
 * All three are POST. As GET links — which is what the legacy `submit.js` served — any
 * email client or security scanner that prefetched the URL approved the estimate on the
 * reviewer's behalf.
 */
export function useSubmitReviewDecision(token: string) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ decision, notes }: { decision: ReviewDecision; notes?: string }) =>
      apiFetch<ReviewDecisionOut>(`/public/reviews/${token}/${decision}`, {
        method: "POST",
        anonymous: true,
        ...(decision === "request-changes"
          ? { body: { notes: notes ?? "" } satisfies RequestChangesRequest }
          : {}),
      }),
    onSuccess: () => {
      // Approve and reject spend the token, so the next read is a 410 rather than the
      // estimate. Requesting changes leaves it live and the estimate has moved on.
      // Either way the cached copy is now wrong.
      void client.invalidateQueries({ queryKey: queryKeys.review(token) });
    },
  });
}
