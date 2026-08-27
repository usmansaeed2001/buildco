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
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "./keys";
import type { UserOut } from "../types";

export function useUsers() {
  return useQuery({
    queryKey: queryKeys.users,
    queryFn: () => apiFetch<UserOut[]>("/users"),
    // The roster changes when someone joins or is removed, which is rare. Refetching it
    // on every screen that shows an assignee dropdown is pure noise.
    staleTime: 5 * 60_000,
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
