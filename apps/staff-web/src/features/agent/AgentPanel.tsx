/**
 * The assistant's panel: what is being said, what it is doing, and what it is asking
 * permission for.
 *
 * It stays fully usable while the app beside it is locked. Stop, Approve, Reject and the
 * text box are the user's controls over the assistant, so they are never the thing that
 * is disabled.
 *
 * The approval card shows the server's summary word for word. That text is what is being
 * approved: the agent's spoken version is a paraphrase by a voice model, and the screen
 * is the authority.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/Button";
import { Alert } from "@/components/feedback";
import { cn } from "@/lib/cn";
import { describeEnding, describeSeconds, type ProposalResult } from "./agentState";
import { AgentHistory } from "./AgentHistory";
import { useAgent } from "./AgentProvider";
import { KIND_TITLES, linkTo } from "./kinds";
import type { Proposal } from "./protocol";

const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export function AgentPanel() {
  const agent = useAgent();
  if (!agent) return null;
  const { state } = agent;
  const live = state.phase === "live";
  const between = state.phase === "idle" || state.phase === "ended";
  const spent = between && agent.remainingToday !== null && agent.remainingToday <= 0;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-gray-200 px-4 py-3">
        <h2 className="font-display text-base font-semibold text-gray-900">BuildCo Assistant</h2>
        <button
          type="button"
          onClick={agent.closePanel}
          aria-label="Close assistant"
          title={live ? "Closing ends the conversation" : "Close"}
          className="-m-1 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
        >
          <svg className="size-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
          </svg>
        </button>
      </header>

      {agent.locked && (
        <div className="flex items-center justify-between gap-3 border-b border-brand-100 bg-brand-50 px-4 py-2.5">
          <p className="text-sm font-medium text-brand-700 dark:text-brand-300">
            Working in the app. It is locked until this is done.
          </p>
          <Button size="sm" variant="danger" onClick={agent.stop}>
            Stop
          </Button>
        </div>
      )}

      {state.phase === "reconnecting" && (
        <p
          role="status"
          className="border-b border-warning-100 bg-warning-50 px-4 py-2.5 text-sm text-warning-600"
        >
          The connection dropped. Reconnecting…
        </p>
      )}

      {live && state.paused === "approval" && (
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 bg-gray-50 px-4 py-2.5">
          <p role="status" className="text-sm text-gray-700">
            Microphone paused while you read. Nothing is being sent or timed.
          </p>
          <Button size="sm" variant="primary" onClick={agent.resume}>
            Tap to talk
          </Button>
        </div>
      )}
      {live && state.paused === "allowance" && (
        <p role="status" className="border-b border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-700">
          Today&rsquo;s time has been used, so the audio has stopped. You can still approve
          or reject what is waiting.
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        {state.problem && <Alert tone="danger">{state.problem}</Alert>}

        {state.phase === "idle" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-gray-600">
              Ask about supplements, meetings and projects, or ask for a meeting or a
              supplement to be set up or changed. Nothing is saved until you approve exactly
              what is on screen.
            </p>
            <TimeLeft seconds={agent.remainingToday} resetsAt={agent.resetsAt} />
            <Button variant="primary" onClick={agent.startVoice} disabled={spent}>
              Start talking
            </Button>
          </div>
        )}

        {state.phase === "connecting" && (
          <p role="status" className="text-sm text-gray-500">
            Connecting…
          </p>
        )}

        <Transcript />

        {state.remembered.map((memory) => (
          <Remembered key={memory.id} content={memory.content} onUndo={() => agent.forget(memory.id)} />
        ))}

        {state.steps.length > 0 && agent.locked && (
          <ol aria-label="What the assistant is doing" className="flex flex-col gap-1 text-sm">
            {state.steps.map((step) => (
              <li
                key={step.id}
                className={cn(
                  "flex items-center gap-2",
                  step.status === "done" ? "text-gray-500" : "font-medium text-gray-900",
                )}
              >
                <span aria-hidden="true">{step.status === "done" ? "✓" : "•"}</span>
                {step.label}
              </li>
            ))}
          </ol>
        )}

        {state.proposal && (
          <ApprovalCard
            proposal={state.proposal}
            // Nothing can be approved over a dead connection. The card stays, so that
            // what was being asked is still in front of the user when it comes back.
            disabled={state.phase !== "live"}
            onApprove={agent.approve}
            onReject={agent.reject}
          />
        )}

        {state.lastResult && !state.proposal && <Outcome result={state.lastResult} />}

        {live && state.notice && (
          <p role="status" className="text-sm text-gray-600">
            {state.notice}
          </p>
        )}

        {state.phase === "ended" && (
          <div className="flex flex-col gap-3 border-t border-gray-100 pt-3">
            <p className="text-sm text-gray-600">
              {describeEnding(state.endedReason, state.endedDetail)}
            </p>
            <TimeLeft seconds={agent.remainingToday} resetsAt={agent.resetsAt} />
            <Button variant="primary" onClick={agent.startVoice} disabled={spent}>
              Start a new conversation
            </Button>
          </div>
        )}

        {between && <AgentHistory />}
      </div>

      <footer className="flex flex-col gap-2 border-t border-gray-200 px-4 py-3">
        {live && (
          <div className="flex items-center gap-2">
            {state.microphone && (
              <>
                <Button
                  size="sm"
                  aria-pressed={state.muted}
                  onClick={() => agent.setMuted(!state.muted)}
                >
                  {state.muted ? "Unmute" : "Mute"}
                </Button>
                <MicMeter level={agent.micLevel} muted={state.muted || state.paused !== null} />
              </>
            )}
            <Button
              size="sm"
              aria-pressed={!state.speakerOn}
              onClick={() => agent.setSpeaker(!state.speakerOn)}
            >
              {state.speakerOn ? "Speaker on" : "Speaker off"}
            </Button>
            <Countdown seconds={state.remainingSeconds} />
            <Button size="sm" className="ml-auto" onClick={agent.end}>
              End
            </Button>
          </div>
        )}
        {state.phase !== "connecting" && state.phase !== "reconnecting" && (
          <Composer
            onSend={agent.sendText}
            disabled={spent || state.paused === "allowance"}
          />
        )}
      </footer>
    </div>
  );
}

/** Before a conversation: how much of today is left, or when there will be more. */
function TimeLeft({ seconds, resetsAt }: { seconds: number | null; resetsAt: string | null }) {
  if (seconds === null) return null;
  if (seconds > 0) {
    return <p className="text-sm text-gray-500">{describeSeconds(seconds)} left today.</p>;
  }
  // 00:00 UTC, shown as the time it is here: mid-afternoon on the west coast.
  const when = resetsAt ? TIME.format(new Date(resetsAt)) : null;
  return (
    <Alert tone="info">
      Today&rsquo;s time with the assistant has been used.
      {when ? ` More is available from ${when}.` : ""} Your past conversations and what it
      remembers are still here.
    </Alert>
  );
}

/** During one: shown only when it is nearly gone. */
function Countdown({ seconds }: { seconds: number | null }) {
  if (seconds === null || seconds >= 120) return null;
  return (
    <span role="timer" aria-label="Time left today" className="text-xs font-medium text-warning-600">
      {describeSeconds(seconds)} left
    </span>
  );
}

function Remembered({ content, onUndo }: { content: string; onUndo: () => Promise<void> }) {
  const [failed, setFailed] = useState(false);
  return (
    <p className="rounded-card bg-gray-50 px-3 py-2 text-sm text-gray-700">
      <span className="font-medium">Remembered:</span> {content}{" "}
      <button
        type="button"
        className="text-brand-700 underline dark:text-brand-300"
        onClick={() => void onUndo().catch(() => setFailed(true))}
      >
        Undo
      </button>
      {failed && <span className="text-danger-600"> Could not undo that.</span>}
    </p>
  );
}

function Transcript() {
  const agent = useAgent();
  const lines = agent?.state.transcript ?? [];
  const end = useRef<HTMLDivElement>(null);

  // Keep the latest words in view, as a chat does.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [lines]);

  if (lines.length === 0) return null;
  return (
    <div role="log" aria-label="Conversation" className="flex flex-col gap-2">
      {lines.map((line) => (
        <p
          key={line.id}
          className={cn(
            "max-w-[90%] rounded-card px-3 py-2 text-sm",
            line.role === "user"
              ? "self-end bg-brand-600 text-white"
              : "self-start bg-gray-100 text-gray-900",
            !line.final && "opacity-70",
          )}
        >
          <span className="sr-only">{line.role === "user" ? "You: " : "Assistant: "}</span>
          {line.text}
        </p>
      ))}
      <div ref={end} />
    </div>
  );
}

function ApprovalCard({
  proposal,
  disabled,
  onApprove,
  onReject,
}: {
  proposal: Proposal;
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { labels } = proposal;
  const attendees = labels.attendees ?? [];
  const clickOnly = proposal.approval === "click";
  const isMeeting = proposal.kind.startsWith("meeting.");
  const isMemory = proposal.kind === "memory.change";

  return (
    <section
      aria-label="Waiting for your approval"
      className="flex flex-col gap-3 rounded-card bg-surface p-3 ring-2 ring-brand-500"
    >
      <h3 className="text-sm font-semibold text-gray-900">
        {KIND_TITLES[proposal.kind] ?? "Proposed change"}
      </h3>
      <p className="text-sm text-gray-700">{proposal.summary}</p>

      {isMeeting && attendees.length > 0 && (
        <div className="text-sm">
          <p className="font-medium text-gray-700">On the meeting</p>
          <ul className="mt-1 flex flex-col gap-0.5 text-gray-600">
            {attendees.map((attendee) => (
              <li key={attendee.label}>
                {attendee.label}
                {attendee.note && <span className="text-gray-500"> ({attendee.note})</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(labels.changes ?? []).length > 0 && (
        <dl className="flex flex-col gap-1.5 text-sm">
          {(labels.changes ?? []).map((change) => (
            <div key={change.field}>
              <dt className="font-medium text-gray-700">{change.label}</dt>
              <dd className="text-gray-600">
                <span className="line-through">{change.old || "blank"}</span>{" "}
                <span aria-hidden="true">→</span>{" "}
                <span className="text-gray-900">{change.new || "blank"}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}

      {isMemory && (
        <dl className="flex flex-col gap-1.5 text-sm">
          <div>
            <dt className="font-medium text-gray-700">Now</dt>
            <dd className="text-gray-600">{labels.old}</dd>
          </div>
          <div>
            <dt className="font-medium text-gray-700">Would become</dt>
            <dd className="text-gray-900">{labels.new ?? "Forgotten"}</dd>
          </div>
        </dl>
      )}

      {proposal.warnings.map((warning) => (
        <Alert key={warning} tone="warning">
          {warning}
        </Alert>
      ))}

      <p className="text-xs text-gray-500">
        {clickOnly
          ? "This one needs a click. Saying yes will not approve it."
          : "Say yes once you have heard it, or press Approve."}
      </p>

      <div className="flex justify-end gap-2">
        <Button onClick={onReject} disabled={disabled}>
          Reject
        </Button>
        <Button variant="primary" onClick={onApprove} disabled={disabled}>
          Approve
        </Button>
      </div>
    </section>
  );
}

function Outcome({ result }: { result: ProposalResult }) {
  if (result.status === "committed") {
    const to = linkTo(result.target);
    return (
      <Alert tone="success">
        Saved.{" "}
        {to && (
          <Link to={to} className="underline">
            Open it
          </Link>
        )}
      </Alert>
    );
  }
  if (result.status === "failed") {
    return <Alert tone="danger">Not saved. {result.error ?? "Something went wrong."}</Alert>;
  }
  if (result.status === "handed_over") {
    return <Alert tone="info">Stopped. Nothing was saved. It is yours to finish by hand.</Alert>;
  }
  if (result.status === "expired") {
    return <Alert tone="warning">That proposal expired. Nothing was saved.</Alert>;
  }
  return <Alert tone="info">Nothing was saved.</Alert>;
}

function MicMeter({ level, muted }: { level: number; muted: boolean }) {
  return (
    <span
      role="meter"
      aria-label="Microphone level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(Math.min(1, level * 4) * 100)}
      className="h-2 w-16 overflow-hidden rounded-full bg-gray-200"
    >
      <span
        className={cn("block h-full", muted ? "bg-gray-400" : "bg-success-500")}
        style={{ width: `${Math.min(100, level * 400)}%` }}
      />
    </span>
  );
}

function Composer({ onSend, disabled }: { onSend: (text: string) => void; disabled: boolean }) {
  const [text, setText] = useState("");

  function submit() {
    if (!text.trim() || disabled) return;
    onSend(text);
    setText("");
  }

  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        aria-label="Message the assistant"
        placeholder="Type a message"
        disabled={disabled}
        className="h-9 min-w-0 flex-1 rounded-md border border-gray-300 bg-surface px-3 text-sm text-gray-900 disabled:bg-gray-100"
      />
      <Button type="submit" variant="primary" disabled={disabled || !text.trim()}>
        Send
      </Button>
    </form>
  );
}
