/**
 * BuildCo Assistant: the REST half.
 *
 * Only what starts a conversation and reads one back. The conversation itself is a
 * WebSocket to a different service, opened with the ticket `createAgentSession` returns;
 * see `features/agent`.
 */
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "./keys";
import type { AgentSessionOut, AgentStatusOut } from "../types";

/**
 * Whether the assistant is offered to this person. The launcher is drawn from it.
 *
 * False while it is switched off, and false for anyone outside the pilot list. Never
 * retried and treated as "no" on failure: an assistant that cannot say whether it is
 * available should not put a button on every page.
 */
export function useAgentStatus() {
  return useQuery({
    queryKey: queryKeys.agent.status,
    queryFn: () => apiFetch<AgentStatusOut>("/agent/status"),
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Start a conversation. Not a mutation hook: it is called once, from inside the click
 * that also has to unlock audio, and nothing is cached or invalidated by it.
 */
export function createAgentSession(clientTimezone: string): Promise<AgentSessionOut> {
  return apiFetch<AgentSessionOut>("/agent/sessions", {
    method: "POST",
    body: { client_timezone: clientTimezone },
  });
}
