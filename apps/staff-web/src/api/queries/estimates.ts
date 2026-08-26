/**
 * Estimate reads and writes.
 *
 * The one rule worth stating: update payloads are built field by field, never by
 * spreading a fetched `EstimateOut`. Request schemas set `extra="forbid"`, so a single
 * unexpected key — `id`, `status`, `created_at` — makes the whole request a 422.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "./keys";
import type {
  Ack,
  EstimateCreate,
  EstimateOut,
  EstimatePage,
  EstimateUpdate,
  SubmitForReviewOut,
  SubmitForReviewRequest,
} from "../types";
import type { EstimateStatus } from "@/domain/enums";
import type { TransitionAction } from "@/domain/estimateRules";

export interface EstimateListFilters {
  trash?: boolean;
  status?: EstimateStatus | undefined;
  q?: string | undefined;
  limit?: number;
  offset?: number;
}

export function useEstimates(filters: EstimateListFilters) {
  const query = {
    trash: filters.trash ?? false,
    status: filters.status,
    q: filters.q,
    limit: filters.limit ?? 50,
    offset: filters.offset ?? 0,
  };

  return useQuery({
    queryKey: queryKeys.estimates.list(query),
    queryFn: () => apiFetch<EstimatePage>("/estimates", { query }),
  });
}

export function useEstimate(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.estimates.detail(id ?? ""),
    queryFn: () => apiFetch<EstimateOut>(`/estimates/${id}`),
    enabled: Boolean(id),
  });
}

/**
 * `Partial`, because every field on `EstimateCreate` has a server-side default and
 * `POST /estimates` accepts an empty body — that is how "New estimate" creates a blank
 * one. openapi-typescript marks a property with a `default` as required, which is
 * right for a response (it will always be present) but wrong for a request body.
 * Widening here rather than regenerating with `--default-non-nullable false`, which
 * would make every *response* field optional and push the problem everywhere else.
 */
export type EstimateCreateBody = Partial<EstimateCreate>;

export function useCreateEstimate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: EstimateCreateBody) =>
      apiFetch<EstimateOut>("/estimates", { method: "POST", body }),
    onSuccess: (created) => {
      // Seed the detail cache so navigating straight into the editor renders
      // immediately rather than flashing a loading state for data we already hold.
      client.setQueryData(queryKeys.estimates.detail(created.id), created);
      void client.invalidateQueries({ queryKey: queryKeys.estimates.all });
    },
  });
}

export function useUpdateEstimate(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: EstimateUpdate) =>
      apiFetch<EstimateOut>(`/estimates/${id}`, { method: "PATCH", body }),
    onSuccess: (updated) => {
      client.setQueryData(queryKeys.estimates.detail(id), updated);
      // The list carries project name, status, and totals, all of which this may have
      // changed. Invalidate rather than patch: the list is filtered and sorted
      // server-side, so a local edit cannot know whether the row still belongs.
      void client.invalidateQueries({ queryKey: queryKeys.estimates.all });
    },
  });
}

export function useEstimateTransition(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (action: TransitionAction) =>
      apiFetch<EstimateOut>(`/estimates/${id}/transitions`, {
        method: "POST",
        body: { action },
      }),
    onSuccess: (updated) => {
      client.setQueryData(queryKeys.estimates.detail(id), updated);
      void client.invalidateQueries({ queryKey: queryKeys.estimates.all });
    },
  });
}

export function useSubmitForReview(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: SubmitForReviewRequest) =>
      apiFetch<SubmitForReviewOut>(`/estimates/${id}/submit`, { method: "POST", body }),
    onSuccess: (result) => {
      client.setQueryData(queryKeys.estimates.detail(id), result.estimate);
      void client.invalidateQueries({ queryKey: queryKeys.estimates.all });
    },
  });
}

/** Soft delete — moves the estimate to the trash, where it is restorable. */
export function useTrashEstimate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<EstimateOut>(`/estimates/${id}`, { method: "DELETE" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.estimates.all }),
  });
}

export function useRestoreEstimate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<EstimateOut>(`/estimates/${id}/restore`, { method: "POST" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.estimates.all }),
  });
}

/** Irreversible. Elevated roles only, and the caller must confirm first. */
export function useDeleteEstimatePermanently() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<Ack>(`/estimates/${id}/permanent`, { method: "DELETE" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.estimates.all }),
  });
}
