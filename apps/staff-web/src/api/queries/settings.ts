/**
 * Team settings and the shared rate catalogue.
 *
 * These replace `localStorage`. In the legacy app the rate list was per-browser and
 * per-device — two estimators on the same job saw different prices, and clearing site
 * data lost the lot — and the notification toggles gated nothing at all, because the
 * emails were sent server-side and the browser was never consulted.
 *
 * Reads are open to any authenticated user; the estimate editor needs the catalogue and
 * the custom units to render a line. Writes are elevated, because one person changing a
 * rate changes what everyone quotes.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "./keys";
import type {
  CatalogueItemCreate,
  CatalogueItemOut,
  CatalogueItemUpdate,
  TeamSettingsOut,
  TeamSettingsUpdate,
} from "../types";

export function useTeamSettings() {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => apiFetch<TeamSettingsOut>("/settings"),
    // Read by the estimate editor on every open. It changes rarely, and the API
    // materialises the row on first read so this never 404s.
    staleTime: 5 * 60_000,
  });
}

export function useUpdateTeamSettings() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (body: TeamSettingsUpdate) =>
      apiFetch<TeamSettingsOut>("/settings", { method: "PATCH", body }),
    // The response is the whole resolved settings object, so it can seed the cache
    // directly rather than provoking a refetch.
    onSuccess: (updated) => client.setQueryData(queryKeys.settings, updated),
  });
}

export function useCatalogue() {
  return useQuery({
    queryKey: queryKeys.catalogue,
    queryFn: () => apiFetch<CatalogueItemOut[]>("/catalogue-items"),
    staleTime: 5 * 60_000,
  });
}

function useCatalogueMutation<TVariables, TData>(
  mutationFn: (variables: TVariables) => Promise<TData>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.catalogue }),
  });
}

export function useCreateCatalogueItem() {
  return useCatalogueMutation((body: CatalogueItemCreate) =>
    apiFetch<CatalogueItemOut>("/catalogue-items", { method: "POST", body }),
  );
}

export function useUpdateCatalogueItem() {
  return useCatalogueMutation(({ id, body }: { id: string; body: CatalogueItemUpdate }) =>
    apiFetch<CatalogueItemOut>(`/catalogue-items/${id}`, { method: "PATCH", body }),
  );
}

/** Estimates already priced from this rate keep their prices — they store values, not
 *  a live reference. Deleting changes what can be added next, never what was quoted. */
export function useDeleteCatalogueItem() {
  return useCatalogueMutation((id: string) =>
    apiFetch<{ ok: boolean }>(`/catalogue-items/${id}`, { method: "DELETE" }),
  );
}
