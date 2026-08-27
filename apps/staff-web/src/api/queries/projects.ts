/**
 * Project reads and writes.
 *
 * Two rules run through everything here.
 *
 * **`status` and `work_status` are not part of `ProjectUpdate`.** They move through
 * their own endpoints so the rules engine runs on every change, and `closed` /
 * `pending_payment` cannot be set at all — they are conclusions the engine reaches from
 * milestones and closing forms. Sending one is a 422, deliberately, so the stored status
 * can never contradict the facts that determine it.
 *
 * **Almost every mutation can change the project's derived status.** Paying a milestone
 * may close the project; un-paying one reopens it. So mutations invalidate the whole
 * project, not just the collection they touched — the alternative is a status badge that
 * silently disagrees with the milestone list beside it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "./keys";
import type {
  ActivityOut,
  MilestoneCreate,
  MilestoneOut,
  MilestoneUpdate,
  ProjectCreate,
  ProjectDetailOut,
  ProjectOut,
  ProjectPage,
  ProjectUpdate,
  SupplementLinkOut,
} from "../types";
import type { ProjectStatus, WorkStatus } from "@/domain/enums";

export interface ProjectListFilters {
  status?: ProjectStatus | undefined;
  work_status?: WorkStatus | undefined;
  limit?: number;
  offset?: number;
}

export function useProjects(filters: ProjectListFilters) {
  const query = {
    status: filters.status,
    work_status: filters.work_status,
    limit: filters.limit ?? 50,
    offset: filters.offset ?? 0,
  };

  return useQuery({
    queryKey: queryKeys.projects.list(query),
    queryFn: () => apiFetch<ProjectPage>("/projects", { query }),
  });
}

/**
 * A project and everything the detail screen shows, in one request.
 *
 * `?include=` is what makes that possible without forcing the list view to pay for
 * relations it does not use.
 */
export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.projects.detail(id ?? ""),
    queryFn: () =>
      apiFetch<ProjectDetailOut>(`/projects/${id}`, {
        query: { include: "milestones,supplements,activity" },
      }),
    enabled: Boolean(id),
  });
}

/** Every project mutation invalidates the detail *and* the list. */
function useProjectMutation<TVariables, TData>(
  projectId: string,
  mutationFn: (variables: TVariables) => Promise<TData>,
) {
  const client = useQueryClient();

  return useMutation({
    mutationFn,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
      void client.invalidateQueries({ queryKey: queryKeys.projects.all });
    },
  });
}

export function useCreateProject() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (body: Partial<ProjectCreate>) =>
      apiFetch<ProjectOut>("/projects", { method: "POST", body }),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.projects.all }),
  });
}

export function useUpdateProject(projectId: string) {
  return useProjectMutation(projectId, (body: ProjectUpdate) =>
    apiFetch<ProjectOut>(`/projects/${projectId}`, { method: "PATCH", body }),
  );
}

export function useUpdateWorkStatus(projectId: string) {
  return useProjectMutation(projectId, (work_status: WorkStatus) =>
    apiFetch<ProjectOut>(`/projects/${projectId}/work-status`, {
      method: "PATCH",
      body: { work_status },
    }),
  );
}

/** Only `active` and `cancelled`; see `SETTABLE_PROJECT_STATUSES`. */
export function useUpdateProjectStatus(projectId: string) {
  return useProjectMutation(projectId, (status: ProjectStatus) =>
    apiFetch<ProjectOut>(`/projects/${projectId}/status`, { method: "PATCH", body: { status } }),
  );
}

/** Irreversible, and not a soft delete — unlike an estimate, there is no trash. */
export function useDeleteProject() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (projectId: string) =>
      apiFetch<void>(`/projects/${projectId}`, { method: "DELETE" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.projects.all }),
  });
}

// ── Milestones ──────────────────────────────────────────────────────────────

export function useCreateMilestone(projectId: string) {
  return useProjectMutation(projectId, (body: MilestoneCreate) =>
    apiFetch<MilestoneOut>(`/projects/${projectId}/milestones`, { method: "POST", body }),
  );
}

export function useUpdateMilestone(projectId: string) {
  return useProjectMutation(
    projectId,
    ({ milestoneId, body }: { milestoneId: string; body: MilestoneUpdate }) =>
      apiFetch<MilestoneOut>(`/projects/${projectId}/milestones/${milestoneId}`, {
        method: "PATCH",
        body,
      }),
  );
}

export function useDeleteMilestone(projectId: string) {
  return useProjectMutation(projectId, (milestoneId: string) =>
    apiFetch<void>(`/projects/${projectId}/milestones/${milestoneId}`, { method: "DELETE" }),
  );
}

// ── Supplement links ────────────────────────────────────────────────────────

export function useLinkSupplement(projectId: string) {
  return useProjectMutation(projectId, (estimateId: string) =>
    apiFetch<SupplementLinkOut>(`/projects/${projectId}/supplements`, {
      method: "POST",
      body: { estimate_id: estimateId },
    }),
  );
}

export function useUnlinkSupplement(projectId: string) {
  return useProjectMutation(projectId, (estimateId: string) =>
    apiFetch<void>(`/projects/${projectId}/supplements/${estimateId}`, { method: "DELETE" }),
  );
}

// ── Activity ────────────────────────────────────────────────────────────────

/** Only needed when the detail view is not already carrying it via `?include=`. */
export function useProjectActivity(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.projects.activity(projectId ?? ""),
    queryFn: () => apiFetch<ActivityOut[]>(`/projects/${projectId}/activity`),
    enabled: Boolean(projectId),
  });
}
