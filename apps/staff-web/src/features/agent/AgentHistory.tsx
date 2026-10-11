/**
 * Past conversations, read-only.
 *
 * A list, newest first, and one conversation opened from it: what was said, with what
 * was proposed and what became of it shown in place. There is no way to carry on a past
 * conversation, by design.
 *
 * A person sees only their own. After 90 days the words are deleted and the conversation
 * stays in the list with its date and its actions, marked as expired: the record of what
 * was done on someone's behalf is kept, the record of what was said in passing is not.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useAgentConversation, useAgentHistory } from "@/api/queries/agent";
import type { AgentActionOut, AgentConversationOut } from "@/api/types";
import { Alert } from "@/components/feedback";
import { cn } from "@/lib/cn";
import { describeSeconds } from "./agentState";
import { KIND_TITLES, linkTo } from "./kinds";

const DAY = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

const OUTCOMES: Record<string, string> = {
  proposed: "Was waiting for an answer",
  committed: "Saved",
  cancelled: "Rejected",
  superseded: "Replaced by a correction",
  expired: "Expired unanswered",
  handed_over: "Taken over by hand",
  failed: "Not saved",
};

export function AgentHistory() {
  const [opened, setOpened] = useState<string | null>(null);
  const history = useAgentHistory(true);
  const rows = history.data?.items ?? [];

  if (opened) return <PastConversation id={opened} onBack={() => setOpened(null)} />;
  if (rows.length === 0) return null;

  return (
    <section aria-label="Past conversations" className="flex flex-col gap-2 border-t border-gray-100 pt-3">
      <h3 className="text-xs font-semibold tracking-wide text-gray-500 uppercase">
        Past conversations
      </h3>
      <ul className="flex flex-col">
        {rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => setOpened(row.id)}
              className="flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left hover:bg-gray-100"
            >
              <span className="truncate text-sm text-gray-900">
                {row.transcript_expired ? "Transcript expired" : row.title || "Untitled"}
              </span>
              <span className="text-xs text-gray-500">
                {row.started_at ? DAY.format(new Date(row.started_at)) : ""}
                {" · "}
                {describeSeconds(row.duration_seconds)}
                {" · "}
                {row.action_count === 1 ? "1 change saved" : `${row.action_count} changes saved`}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PastConversation({ id, onBack }: { id: string; onBack: () => void }) {
  const { data, isPending, error } = useAgentConversation(id);

  return (
    <section aria-label="Past conversation" className="flex flex-col gap-3 border-t border-gray-100 pt-3">
      <button
        type="button"
        onClick={onBack}
        className="self-start text-sm text-brand-700 underline dark:text-brand-300"
      >
        Back to past conversations
      </button>
      {isPending && (
        <p role="status" className="text-sm text-gray-500">
          Loading…
        </p>
      )}
      {error && <Alert tone="danger">That conversation could not be loaded.</Alert>}
      {data && <Record conversation={data} />}
    </section>
  );
}

type Entry =
  | { at: string; kind: "line"; role: string; text: string; key: string }
  | { at: string; kind: "action"; action: AgentActionOut; key: string };

function Record({ conversation }: { conversation: AgentConversationOut }) {
  // Said and done, in the order they happened.
  const entries: Entry[] = [
    ...(conversation.messages ?? []).map(
      (message): Entry => ({
        at: message.created_at,
        kind: "line",
        role: message.role,
        text: message.text,
        key: `line-${message.seq}`,
      }),
    ),
    ...(conversation.actions ?? []).map(
      (action): Entry => ({
        at: action.created_at,
        kind: "action",
        action,
        key: `action-${action.id}`,
      }),
    ),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <>
      <p className="text-xs text-gray-500">
        {conversation.started_at
          ? `${DAY.format(new Date(conversation.started_at))}, ${TIME.format(new Date(conversation.started_at))}`
          : ""}
      </p>
      {conversation.transcript_expired && (
        <Alert tone="info">
          The transcript of this conversation has expired and been deleted. What was done in
          it is still shown.
        </Alert>
      )}
      <div className="flex flex-col gap-2">
        {entries.map((entry) =>
          entry.kind === "line" ? (
            <p
              key={entry.key}
              className={cn(
                "max-w-[90%] rounded-card px-3 py-2 text-sm",
                entry.role === "user"
                  ? "self-end bg-brand-600 text-white"
                  : "self-start bg-gray-100 text-gray-900",
              )}
            >
              <span className="sr-only">{entry.role === "user" ? "You: " : "Assistant: "}</span>
              {entry.text}
            </p>
          ) : (
            <PastAction key={entry.key} action={entry.action} />
          ),
        )}
      </div>
    </>
  );
}

function PastAction({ action }: { action: AgentActionOut }) {
  const result = action.result as { type?: string; id?: string } | null;
  const to =
    action.status === "committed" && result?.type && result.id
      ? linkTo({ type: result.type, id: result.id })
      : null;
  return (
    <article className="flex flex-col gap-1 rounded-card bg-surface p-3 text-sm ring-1 ring-gray-200">
      <h4 className="font-medium text-gray-900">{KIND_TITLES[action.kind] ?? "Proposed change"}</h4>
      <p className="text-gray-600">{action.summary}</p>
      <p className="text-xs text-gray-500">
        {OUTCOMES[action.status] ?? action.status}
        {action.status === "committed" && action.approved_via
          ? `, approved by ${action.approved_via}`
          : ""}
        {action.error ? `: ${action.error}` : ""}
        {to && (
          <>
            {" · "}
            <Link to={to} className="underline">
              Open it
            </Link>
          </>
        )}
      </p>
    </article>
  );
}
