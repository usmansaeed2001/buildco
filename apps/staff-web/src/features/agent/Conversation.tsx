/**
 * The conversation: what was said, and everything that happened along the way, in the
 * order it happened.
 *
 * The assistant's words are plain text on the card: the orb in the header is the
 * speaker, so there is no bubble and no avatar. The user's are a neutral bubble on the
 * right. There is no saturated colour in here at all. Colour in the panel is kept for
 * things to act on.
 *
 * A past conversation is drawn with these same pieces (`AgentHistory`).
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import type { AgentState, Mark, ProposalResult, Remembered } from "./agentState";
import { InfoIcon } from "./icons";
import { kindTitle, linkTo, receiptStatus } from "./kinds";
import { Orb } from "./Orb";
import { Receipt } from "./Receipt";

export function Turn({
  role,
  text,
  final = true,
  cut = false,
  readback = false,
  speaking = false,
}: {
  role: "user" | "assistant";
  text: string;
  /** False while the words are still arriving. */
  final?: boolean;
  /** The user talked over it. Not an error, and not drawn as one. */
  cut?: boolean;
  /**
   * This turn read back a proposal that is still waiting in the dock. The card there
   * holds the server's own summary in full, so the same paragraph is not shown twice:
   * the turn is kept to two lines, with a way to see all of it.
   */
  readback?: boolean;
  /** The assistant is saying this line now. */
  speaking?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  // How much of the line was already on screen, so only what is new fades in.
  const shown = useRef(0);
  const from = final ? text.length : Math.min(shown.current, text.length);
  useEffect(() => {
    shown.current = text.length;
  }, [text]);

  if (role === "user") {
    return (
      <p className="ast-bubble max-w-[85%] self-end rounded-[18px] rounded-br-md bg-gray-100 px-3.5 py-2 text-sm leading-5 whitespace-pre-wrap text-gray-900">
        <span className="sr-only">You: </span>
        {text}
      </p>
    );
  }

  const clamped = readback && !expanded;
  return (
    <div className="flex flex-col gap-1">
      {readback && (
        <p className="text-xs font-medium text-assistant-700 dark:text-assistant-300">Read-back</p>
      )}
      <p
        // Announced once, when the line is whole, and not word by word as it arrives.
        aria-hidden={final ? undefined : true}
        className={cn(
          "text-sm leading-5 whitespace-pre-wrap transition-colors duration-200",
          final ? "text-gray-900" : "text-gray-500",
          clamped && "line-clamp-2",
        )}
      >
        <span className="sr-only">Assistant: </span>
        {text.slice(0, from)}
        {from < text.length && (
          <span key={from} className="ast-fragment">
            {text.slice(from)}
          </span>
        )}
        {cut && <span className="text-gray-400"> —</span>}
        {speaking && !final && <span aria-hidden="true" className="ast-dot" />}
      </p>
      {readback && (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          className="-my-3 flex h-11 items-center self-start text-xs font-medium text-brand-700 hover:underline dark:text-brand-300"
        >
          {expanded ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

/** One centred line that nobody said: a page was opened, the microphone paused. */
export function Notice({ children, live = false }: { children: string; live?: boolean }) {
  return (
    <p
      {...(live ? { role: "status" } : {})}
      className="ast-fade flex items-start justify-center gap-1.5 px-4 text-center text-xs leading-4 text-gray-500"
    >
      <InfoIcon className="size-4" />
      <span>{children}</span>
    </p>
  );
}

function RememberedRow({ content, onUndo }: { content: string; onUndo: () => Promise<void> }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="ast-rise flex items-start gap-2 text-sm leading-5">
      <Orb size={20} />
      <p className="min-w-0 flex-1 text-gray-700">
        <span className="text-gray-500">Remembered: </span>
        {content}
        {failed && <span className="text-danger-600 dark:text-danger-400"> Could not undo that.</span>}
      </p>
      <button
        type="button"
        onClick={() => void onUndo().catch(() => setFailed(true))}
        className="-my-3 flex h-11 shrink-0 items-center px-1 text-sm font-medium text-brand-700 hover:underline dark:text-brand-300"
      >
        Undo
      </button>
    </div>
  );
}

function LiveReceipt({ result }: { result: ProposalResult }) {
  const status = receiptStatus(result.status);
  if (!status) return null;
  const kind = result.kind ? kindTitle(result.kind) : null;
  return (
    <Receipt
      status={status}
      title={[kind, result.name].filter(Boolean).join(" · ") || null}
      detail={result.when}
      error={result.error}
      to={status === "committed" ? linkTo(result.target) : null}
    />
  );
}

type Entry =
  | { key: string; type: "mark"; mark: Mark }
  | { key: string; type: "memory"; memory: Remembered }
  | { key: string; type: "receipt"; result: ProposalResult };

export function Conversation({
  state,
  speaking,
  settling = null,
  onForget,
}: {
  state: AgentState;
  speaking: boolean;
  /**
   * A proposal whose outcome is still being shown on its card. Its receipt waits for
   * the card to go, so that "Saved" is not on screen twice.
   */
  settling?: string | null;
  onForget: (memoryId: string) => Promise<void>;
}) {
  const { transcript, marks, remembered, receipts } = state;

  // Everything that is not speech sits after the line it followed.
  const entriesAfter = (line: number): Entry[] => [
    ...marks
      .filter((mark) => mark.after === line)
      .map((mark): Entry => ({ key: `mark-${mark.id}`, type: "mark", mark })),
    ...remembered
      .filter((memory) => memory.after === line)
      .map((memory): Entry => ({ key: `memory-${memory.id}`, type: "memory", memory })),
    ...receipts
      .filter((result) => result.after === line && result.id !== settling)
      .map((result): Entry => ({ key: `receipt-${result.id}`, type: "receipt", result })),
  ];

  const draw = (entry: Entry) =>
    entry.type === "mark" ? (
      <Notice key={entry.key}>{entry.mark.text}</Notice>
    ) : entry.type === "memory" ? (
      <RememberedRow
        key={entry.key}
        content={entry.memory.content}
        onUndo={() => onForget(entry.memory.id)}
      />
    ) : (
      <LiveReceipt key={entry.key} result={entry.result} />
    );

  const last = transcript[transcript.length - 1];
  return (
    <div role="log" aria-label="Conversation" className="flex flex-col gap-3">
      {entriesAfter(0).map(draw)}
      {transcript.map((line) => [
        <Turn
          key={`line-${line.id}`}
          role={line.role}
          text={line.text}
          final={line.final}
          cut={line.cut === true}
          readback={line.readbackFor !== undefined && line.readbackFor === state.proposal?.id}
          speaking={speaking && line === last}
        />,
        ...entriesAfter(line.id).map(draw),
      ])}
    </div>
  );
}
