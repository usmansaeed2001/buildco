/**
 * Default MSW handlers.
 *
 * These cover the reads every screen performs on mount, so a test only declares the
 * endpoint it is actually exercising. Anything not handled here is an *error*, not an
 * empty response — `server.ts` sets `onUnhandledRequest: "error"` so a forgotten stub
 * fails loudly instead of surfacing later as a confusing empty state.
 *
 * `API_BASE` is a same-origin `/api/v1`, and jsdom resolves that against the
 * `testEnvironmentOptions.url` in `vite.config.ts`.
 */
import { http, HttpResponse } from "msw";
import { API_BASE } from "@/api/client";
import {
  makeEstimate,
  makeEstimatePage,
  makeProject,
  makeProjectPage,
  makeUser,
} from "../factories";

export const url = (path: string): string => `${API_BASE}${path}`;

/** The error envelope every non-2xx response uses (`app/errors.py`). */
export function apiError(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return HttpResponse.json(
    { error: { code, message, ...(details ? { details } : {}) } },
    { status, headers: { "X-Request-ID": "test-request-id" } },
  );
}

export const handlers = [
  http.get(url("/users/me"), () => HttpResponse.json(makeUser())),
  http.get(url("/users"), () => HttpResponse.json([makeUser()])),
  http.post(url("/auth/session"), () =>
    HttpResponse.json({ user: makeUser(), created: false, linked: false }),
  ),
  http.get(url("/estimates"), () => HttpResponse.json(makeEstimatePage([]))),
  // A per-test override is the norm for the editor, which needs a specific document.
  // This default exists so an unrelated screen navigating here does not fail on an
  // unhandled request.
  http.get(url("/estimates/:id"), () => HttpResponse.json(makeEstimate())),
  http.get(url("/projects"), () => HttpResponse.json(makeProjectPage([]))),
  http.get(url("/meetings"), () => HttpResponse.json([])),
  http.get(url("/catalogue-items"), () => HttpResponse.json([])),
  http.get(url("/settings"), () =>
    HttpResponse.json({
      custom_units: [],
      custom_categories: [],
      notification_prefs: { estimate_locked: true, member_joined: true, member_removed: true },
      updated_at: "2026-02-01T09:00:00Z",
      updated_by: null,
    }),
  ),
  http.get(url("/approval-requests"), () => HttpResponse.json([])),
  http.get(url("/projects/:id"), () =>
    HttpResponse.json({ project: makeProject(), milestones: [], supplements: [], activity: [] }),
  ),
];
