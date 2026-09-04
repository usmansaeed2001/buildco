/**
 * Meetings.
 *
 * The calendar is **no longer shared across the team**. `GET /meetings` returns what you
 * created and what you were invited to; `scope=all` is honoured only for owners and
 * admins and silently clamped for everyone else, so the UI hiding that option is a
 * convenience rather than the mechanism. Anyone may create a meeting; only its creator,
 * or an elevated user, may change or cancel it.
 *
 * `google_access_token` is a short-lived OAuth token from the Firebase Google provider
 * with the `calendar.events` scope. It is used once, server-side, to create the Meet
 * conference, and never stored. Omitting it produces a perfectly valid meeting with no
 * Meet link — so it is passed when available and its absence is never an error.
 *
 * The token lives only in React state (`AuthProvider`), deliberately never persisted,
 * and in Testing mode Google refresh tokens expire after 7 days — see `BACKLOG.md` §5.
 * A meeting created without one is the normal case, not a degraded one.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "./keys";
import type { MeetingCreate, MeetingOut, MeetingUpdate } from "../types";
import type { TimeWindow } from "@/domain/calendar";

export interface MeetingFilters extends Partial<TimeWindow> {
  project_id?: string | undefined;
  /** Whose meetings to return. The server clamps `all` for a non-elevated caller. */
  scope?: "mine" | "invited" | "all" | undefined;
  limit?: number | undefined;
}

export function useMeetings(filters: MeetingFilters) {
  // `from` and `to` are the API's own aliases for the window parameters.
  const query = {
    from: filters.from,
    to: filters.to,
    project_id: filters.project_id,
    scope: filters.scope,
    limit: filters.limit,
  };

  return useQuery({
    queryKey: queryKeys.meetings.list(query),
    queryFn: () => apiFetch<MeetingOut[]>("/meetings", { query }),
    // Paging back and forth through months should not refetch a window already held.
    staleTime: 30_000,
  });
}

function useMeetingMutation<TVariables, TData>(
  mutationFn: (variables: TVariables) => Promise<TData>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    // Every window is potentially affected: moving a meeting changes which month it
    // belongs to, so invalidating only the current window would leave it in both.
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.meetings.all }),
  });
}

export type MeetingCreateBody = Omit<MeetingCreate, "attendee_ids"> & {
  attendee_ids?: string[];
};

export function useCreateMeeting() {
  return useMeetingMutation((body: MeetingCreateBody) =>
    apiFetch<MeetingOut>("/meetings", { method: "POST", body }),
  );
}

export function useUpdateMeeting() {
  return useMeetingMutation(({ id, body }: { id: string; body: MeetingUpdate }) =>
    apiFetch<MeetingOut>(`/meetings/${id}`, { method: "PATCH", body }),
  );
}

/** Sends a cancellation ICS to everyone who was invited. */
export function useDeleteMeeting() {
  return useMeetingMutation(
    ({ id, googleAccessToken }: { id: string; googleAccessToken?: string | null }) =>
      apiFetch<{ ok: boolean }>(`/meetings/${id}`, {
        method: "DELETE",
        ...(googleAccessToken ? { query: { google_access_token: googleAccessToken } } : {}),
      }),
  );
}
