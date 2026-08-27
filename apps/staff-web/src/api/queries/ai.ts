/**
 * AI note parsing.
 *
 * `POST /ai/parse-estimate` returns a **draft**. Nothing is persisted server-side — the
 * response is a proposal the editor loads, the user reviews, and the ordinary autosave
 * then writes. So there is no cache to invalidate and no query key: this is a mutation
 * whose result is handed straight to the caller.
 *
 * Two failure modes matter and are distinguishable by status:
 *
 * - **503** — Groq is unconfigured or unreachable. Nothing the user did.
 * - **422** — the model produced something that could not be coerced into a valid
 *   estimate, most often no rooms at all. `ParsedEstimate` requires at least one, which
 *   is the guardrail that keeps a hallucination out of someone's document.
 */
import { useMutation } from "@tanstack/react-query";
import { apiFetch } from "../client";
import type { ParsedEstimate } from "../types";

export function useParseNotes() {
  return useMutation({
    mutationFn: (notes: string) =>
      apiFetch<ParsedEstimate>("/ai/parse-estimate", {
        method: "POST",
        body: { notes },
      }),
  });
}
