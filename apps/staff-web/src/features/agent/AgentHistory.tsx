/**
 * Past conversations, read-only.
 *
 * A list grouped by day, and one conversation opened from it: what was said, with what
 * was proposed and what became of it shown in place. It is drawn with the same turns and
 * the same receipts as a live conversation, so the two look alike. There is no way to
 * carry on a past conversation, by design.
 *
 * A person sees only their own. After 90 days the words are deleted and the conversation
 * stays in the list with its date and its actions, marked as expired: the record of what
 * was done on someone's behalf is kept, the record of what was said in passing is not.
 *
 * Two things a row no longer says, because both were true and both read as broken. A
 * duration under five seconds is left out: the figure is metered audio time, so a typed
 * conversation honestly lasted "0 s". And a conversation with no title is named for when
 * it was, not "Untitled".
 */
import { useAgentConversation, useAgentHistory } from "@/api/queries/agent";
import type {
  AgentActionOut,
  AgentConversationOut,
  AgentConversationSummaryOut,
} from "@/api/types";
import { Badge } from "@/components/Badge";
import { Alert } from "@/components/feedback";
import { Notice, Turn } from "./Conversation";
import { BackIcon, ChatIcon, CheckIcon } from "./icons";
import { kindTitle, linkTo, receiptStatus } from "./kinds";
import { describeVoice } from "./presence";
import { Receipt } from "./Receipt";

const DAY = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const DAY_AND_YEAR = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function dayOf(row: AgentConversationSummaryOut): string {
  if (!row.started_at) return "Earlier";
  const when = new Date(row.started_at);
  const today = new Date();
  const days = Math.round(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() -
      new Date(when.getFullYear(), when.getMonth(), when.getDate()).getTime()) /
      86_400_000,
  );
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return when.getFullYear() === today.getFullYear() ? DAY.format(when) : DAY_AND_YEAR.format(when);
}

function titleOf(row: AgentConversationSummaryOut): string {
  if (row.transcript_expired) return "Transcript expired";
  if (row.title.trim()) return row.title;
  return row.started_at ? `Conversation at ${TIME.format(new Date(row.started_at))}` : "Conversation";
}

function Row({ row, onOpen }: { row: AgentConversationSummaryOut; onOpen: (id: string) => void }) {
  const saved = row.action_count > 0;
  const voice = describeVoice(row.duration_seconds);
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(row.id)}
        className="flex min-h-11 w-full items-start gap-2.5 rounded-card px-2 py-2 text-left transition-colors duration-150 hover:bg-gray-100"
      >
        {saved ? (
          <CheckIcon className="mt-px size-[18px] text-success-600 dark:text-success-400" />
        ) : (
          <ChatIcon className="mt-px size-[18px] text-gray-400" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-gray-900">{titleOf(row)}</span>
          <span className="tnum mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-gray-500">
            {row.started_at && <span>{TIME.format(new Date(row.started_at))}</span>}
            {saved ? (
              <Badge tone="success">{row.action_count} saved</Badge>
            ) : (
              <span>· nothing saved</span>
            )}
            {voice && <span>· {voice}</span>}
          </span>
        </span>
      </button>
    </li>
  );
}

function Heading({ children }: { children: string }) {
  return (
    <h3 className="px-2 font-sans text-xs font-semibold tracking-wide text-gray-500 uppercase">
      {children}
    </h3>
  );
}

/** The three newest, on the idle screen, and the way to all of them. */
export function RecentConversations({
  onOpen,
  onAll,
}: {
  onOpen: (id: string) => void;
  onAll: () => void;
}) {
  const history = useAgentHistory(true);
  const rows = (history.data?.items ?? []).slice(0, 3);
  if (rows.length === 0) return null;

  return (
    <section aria-label="Recent conversations" className="flex w-full flex-col gap-1 text-left">
      <Heading>Recent</Heading>
      <ul className="flex flex-col">
        {rows.map((row) => (
          <Row key={row.id} row={row} onOpen={onOpen} />
        ))}
      </ul>
      <button
        type="button"
        onClick={onAll}
        className="flex h-11 items-center self-start px-2 text-sm font-medium text-brand-700 hover:underline dark:text-brand-300"
      >
        All conversations
      </button>
    </section>
  );
}

/** The history view: every conversation by day, or one of them. */
export function HistoryView({
  opened,
  returning = false,
  onOpen,
  onBack,
}: {
  /** The conversation being read, or null for the list. */
  opened: string | null;
  /** The list is being come back to, so it arrives from the other side. */
  returning?: boolean;
  onOpen: (id: string) => void;
  /** Back: from one conversation to the list, and from the list to the panel. */
  onBack: () => void;
}) {
  if (opened) return <PastConversation id={opened} onBack={onBack} />;
  return <HistoryList returning={returning} onOpen={onOpen} onBack={onBack} />;
}

function BackButton({ label, onBack, children }: { label: string; onBack: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onBack}
      className="-ml-1.5 flex h-11 items-center gap-1 self-start pr-2 text-sm font-medium text-brand-700 hover:underline dark:text-brand-300"
    >
      <BackIcon className="size-[18px]" />
      {children}
    </button>
  );
}

function HistoryList({
  returning,
  onOpen,
  onBack,
}: {
  returning: boolean;
  onOpen: (id: string) => void;
  onBack: () => void;
}) {
  const history = useAgentHistory(true);
  const rows = history.data?.items ?? [];

  const days: { day: string; rows: AgentConversationSummaryOut[] }[] = [];
  for (const row of rows) {
    const day = dayOf(row);
    const group = days[days.length - 1];
    if (group?.day === day) group.rows.push(row);
    else days.push({ day, rows: [row] });
  }

  return (
    <section
      aria-label="Past conversations"
      className="ast-view flex flex-col gap-3"
      {...(returning ? { "data-back": "" } : {})}
    >
      <BackButton label="Back to the assistant" onBack={onBack}>
        Back
      </BackButton>
      {history.isPending && (
        <p role="status" className="px-2 text-sm text-gray-500">
          Loading…
        </p>
      )}
      {history.error && <Alert tone="danger">Your conversations could not be loaded.</Alert>}
      {!history.isPending && !history.error && rows.length === 0 && (
        <p className="px-2 text-sm text-gray-500">
          Nothing yet. Conversations you have with the assistant are listed here.
        </p>
      )}
      {days.map((group) => (
        <div key={group.day} className="flex flex-col gap-1">
          <Heading>{group.day}</Heading>
          <ul className="flex flex-col">
            {group.rows.map((row) => (
              <Row key={row.id} row={row} onOpen={onOpen} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function PastConversation({ id, onBack }: { id: string; onBack: () => void }) {
  const { data, isPending, error } = useAgentConversation(id);

  return (
    <section aria-label="Past conversation" className="ast-view flex flex-col gap-3">
      <BackButton label="Back to past conversations" onBack={onBack}>
        All conversations
      </BackButton>
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
      <p className="tnum text-xs text-gray-500">
        {conversation.started_at
          ? `${DAY_AND_YEAR.format(new Date(conversation.started_at))}, ${TIME.format(new Date(conversation.started_at))}`
          : ""}
      </p>
      {conversation.transcript_expired && (
        <Notice>
          Transcript expired. What was said has been deleted; what was done is still shown.
        </Notice>
      )}
      <div className="flex flex-col gap-3">
        {entries.map((entry) =>
          entry.kind === "line" ? (
            <Turn
              key={entry.key}
              role={entry.role === "user" ? "user" : "assistant"}
              text={entry.text}
            />
          ) : (
            <PastAction key={entry.key} action={entry.action} />
          ),
        )}
      </div>
    </>
  );
}

function PastAction({ action }: { action: AgentActionOut }) {
  const status = receiptStatus(action.status);
  if (!status) return null;
  const result = action.result as { type?: string; id?: string } | null;
  const to =
    status === "committed" && result?.type && result.id
      ? linkTo({ type: result.type, id: result.id })
      : null;
  return (
    <Receipt
      status={status}
      title={kindTitle(action.kind)}
      detail={action.summary}
      error={action.error}
      note={status === "committed" && action.approved_via ? `Approved by ${action.approved_via}` : null}
      to={to}
    />
  );
}
