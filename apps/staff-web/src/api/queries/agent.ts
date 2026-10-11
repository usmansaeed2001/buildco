/**
 * BuildCo Assistant: the REST half.
 *
 * What starts a conversation, what reads one back, and what the assistant remembers. The
 * conversation itself is a WebSocket to a different service, opened with the ticket
 * `createAgentSession` returns; see `features/agent`.
 *
 * Everything here is the caller's own. Nobody sees another person's conversations or
 * memories, owners and admins included.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "./keys";
import type {
  AgentConversationOut,
  AgentHistoryPage,
  AgentMemoryOut,
  AgentSessionOut,
  AgentStatusOut,
} from "../types";

/**
 * Whether the assistant is offered to this person, and how much of today is left.
 *
 * The launcher is drawn from it. False while it is switched off, and false for anyone
 * outside the pilot list. Never retried and treated as "no" on failure: an assistant
 * that cannot say whether it is available should not put a button on every page.
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

/**
 * A fresh ticket for a conversation whose connection dropped. Refused once a minute has
 * passed, and for a conversation that has ended: there is no resuming one.
 */
export function reconnectAgentSession(conversationId: string): Promise<AgentSessionOut> {
  return apiFetch<AgentSessionOut>(`/agent/sessions/${conversationId}/reconnect`, {
    method: "POST",
  });
}

/** One conversation, read once. How the panel learns what became of the last action. */
export function fetchAgentConversation(conversationId: string): Promise<AgentConversationOut> {
  return apiFetch<AgentConversationOut>(`/agent/conversations/${conversationId}`);
}

export function useAgentHistory(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.agent.history,
    queryFn: () =>
      apiFetch<AgentHistoryPage>("/agent/conversations", {
        query: { limit: 20 },
      }),
    enabled,
  });
}

export function useAgentConversation(conversationId: string | null) {
  return useQuery({
    queryKey: queryKeys.agent.conversation(conversationId ?? ""),
    queryFn: () => fetchAgentConversation(conversationId ?? ""),
    enabled: conversationId !== null,
  });
}

export function useAgentMemories() {
  return useQuery({
    queryKey: queryKeys.agent.memories,
    queryFn: () => apiFetch<AgentMemoryOut[]>("/agent/memories"),
  });
}

export function deleteAgentMemory(memoryId: string): Promise<unknown> {
  return apiFetch(`/agent/memories/${memoryId}`, { method: "DELETE" });
}

export function useDeleteAgentMemory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: deleteAgentMemory,
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.agent.memories }),
  });
}
