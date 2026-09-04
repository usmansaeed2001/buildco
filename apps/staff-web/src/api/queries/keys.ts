/**
 * Query keys, in one place.
 *
 * Collected here rather than written inline so that invalidating after a mutation is
 * a matter of naming the same key, not re-deriving an array literal that has to match
 * character for character. A typo in an inline key does not fail — it just silently
 * fails to invalidate, and the UI shows stale data until the next refetch.
 */
export const queryKeys = {
  me: ["me"] as const,
  users: ["users"] as const,
  approvalRequests: (status: string) => ["approval-requests", status] as const,

  estimates: {
    all: ["estimates"] as const,
    list: (filters: Record<string, unknown>) => ["estimates", "list", filters] as const,
    ids: ["estimates", "ids"] as const,
    detail: (id: string) => ["estimates", "detail", id] as const,
    attachments: (id: string) => ["estimates", "detail", id, "attachments"] as const,
  },

  projects: {
    all: ["projects"] as const,
    list: (filters: Record<string, unknown>) => ["projects", "list", filters] as const,
    detail: (id: string) => ["projects", "detail", id] as const,
    milestones: (id: string) => ["projects", "detail", id, "milestones"] as const,
    supplements: (id: string) => ["projects", "detail", id, "supplements"] as const,
    activity: (id: string) => ["projects", "detail", id, "activity"] as const,
  },

  meetings: {
    all: ["meetings"] as const,
    list: (filters: Record<string, unknown>) => ["meetings", "list", filters] as const,
    detail: (id: string) => ["meetings", "detail", id] as const,
  },

  review: (token: string) => ["review", token] as const,

  settings: ["settings"] as const,
  catalogue: ["catalogue-items"] as const,
} as const;
