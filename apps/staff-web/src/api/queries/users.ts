/**
 * The team roster.
 *
 * `GET /users` is open to any authenticated user, not just elevated ones — assigning a
 * project and inviting people to a meeting both need the list, and neither is an
 * elevated action. What the roster does *not* carry is anything sensitive: the response
 * is `UserOut`, which is name, email, role, status and avatar.
 *
 * Role changes and bans live in the team screen and are added with it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "./keys";
import type { ApprovalRequestOut, UserOut, UserUpdate } from "../types";
import type { Role } from "@/domain/enums";

export function useUsers() {
  return useQuery({
    queryKey: queryKeys.users,
    queryFn: () => apiFetch<UserOut[]>("/users"),
    // The roster changes when someone joins or is removed, which is rare. Refetching it
    // on every screen that shows an assignee dropdown is pure noise.
    staleTime: 5 * 60_000,
  });
}

/** The signed-in user's own profile. Distinct from `AuthProvider`'s copy, which is
 *  seeded once per identity per page load and does not refetch after an edit. */
export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: () => apiFetch<UserOut>("/users/me"),
  });
}

export function useUpdateMe() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (body: UserUpdate) =>
      apiFetch<UserOut>("/users/me", { method: "PATCH", body }),
    onSuccess: (updated) => {
      client.setQueryData(queryKeys.me, updated);
      // The roster shows the same name.
      void client.invalidateQueries({ queryKey: queryKeys.users });
    },
  });
}

/**
 * Change someone's role.
 *
 * The backend decides who may do this (`user_rules.can_assign_role`): only an owner may
 * create another owner, and nobody may change their own role. The UI mirrors those so
 * it does not offer a control that comes back 403.
 */
export function useAssignRole() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      apiFetch<UserOut>(`/users/${userId}/role`, { method: "PATCH", body: { role } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.users }),
  });
}

/** Removes team access and disables the Firebase user, so it takes effect at once. */
export function useBanUser() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch<UserOut>(`/users/${userId}/ban`, { method: "POST" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.users }),
  });
}

/** Access requests filed automatically when a removed user tries to sign in. */
export function useApprovalRequests(status = "pending") {
  return useQuery({
    queryKey: queryKeys.approvalRequests(status),
    queryFn: () => apiFetch<ApprovalRequestOut[]>("/approval-requests", { query: { status } }),
  });
}

export function useReviewApprovalRequest() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approve" | "deny" }) =>
      apiFetch<ApprovalRequestOut>(`/approval-requests/${id}/${decision}`, { method: "POST" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["approval-requests"] });
      // Approving restores the account, so the roster's status changed too.
      void client.invalidateQueries({ queryKey: queryKeys.users });
    },
  });
}

/** Only the active members, for pickers — a banned account should not be assignable. */
export function useAssignableUsers() {
  const query = useUsers();
  return {
    ...query,
    data: query.data?.filter((user) => user.status === "active"),
  };
}
