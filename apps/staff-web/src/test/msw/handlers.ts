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
  makeSettings,
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
  // Before `/estimates/:id`, which would otherwise match `ids` as a path parameter and
  // hand back a single estimate object where the caller expects an array. MSW matches in
  // order, exactly as FastAPI does — the real router declares these the same way round.
  http.get(url("/estimates/ids"), () => HttpResponse.json([])),
  // This default exists so an unrelated screen navigating here does not fail on an
  // unhandled request.
  http.get(url("/estimates/:id"), () => HttpResponse.json(makeEstimate())),
  http.get(url("/projects"), () => HttpResponse.json(makeProjectPage([]))),
  http.get(url("/meetings"), () => HttpResponse.json([])),
  // The shell asks this on every page. Off by default, as it is in an environment with
  // nothing configured, so the assistant is absent unless a test asks for it.
  http.get(url("/agent/status"), () =>
    HttpResponse.json({
      enabled: false,
      max_session_seconds: 1800,
      daily_limit_seconds: 600,
      used_seconds: 0,
      remaining_seconds: 600,
      resets_at: "2026-10-15T00:00:00Z",
    }),
  ),
  http.get(url("/agent/conversations"), () =>
    HttpResponse.json({ items: [], total: 0, limit: 20, offset: 0 }),
  ),
  http.get(url("/agent/memories"), () => HttpResponse.json([])),
  http.get(url("/catalogue-items"), () => HttpResponse.json([])),
  http.get(url("/settings"), () => HttpResponse.json(makeSettings())),
  http.get(url("/approval-requests"), () => HttpResponse.json([])),
  http.get(url("/projects/:id"), () =>
    HttpResponse.json({ project: makeProject(), milestones: [], supplements: [], activity: [] }),
  ),
];
