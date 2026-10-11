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
import { Button } from "@/components/Button";
import { Alert } from "@/components/feedback";
import { cn } from "@/lib/cn";
import { describeEnding, type ProposalResult } from "./agentState";
import { useAgent } from "./AgentProvider";
import type { Proposal } from "./protocol";

const KIND_TITLES: Record<string, string> = {
  "meeting.create": "New meeting",
};

export function AgentPanel() {
  const agent = useAgent();
  if (!agent) return null;
  const { state } = agent;
  const live = state.phase === "live";

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

      {state.mode === "working" && (
        <div className="flex items-center justify-between gap-3 border-b border-brand-100 bg-brand-50 px-4 py-2.5">
          <p className="text-sm font-medium text-brand-700 dark:text-brand-300">
            Working in the app. It is locked until this is done.
          </p>
          <Button size="sm" variant="danger" onClick={agent.stop}>
            Stop
          </Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        {state.problem && <Alert tone="danger">{state.problem}</Alert>}

        {state.phase === "idle" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-gray-600">
              Ask for a meeting to be scheduled, by voice or by typing. Nothing is saved until
              you approve exactly what is on screen.
            </p>
            <Button variant="primary" onClick={agent.startVoice}>
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

        {state.steps.length > 0 && state.mode === "working" && (
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
            onApprove={agent.approve}
            onReject={agent.reject}
          />
        )}

        {state.lastResult && !state.proposal && <Outcome result={state.lastResult} />}

        {state.phase === "ended" && (
          <div className="flex flex-col gap-3 border-t border-gray-100 pt-3">
            <p className="text-sm text-gray-600">{describeEnding(state.endedReason)}</p>
            <Button variant="primary" onClick={agent.startVoice}>
              Start a new conversation
            </Button>
          </div>
        )}
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
                <MicMeter level={agent.micLevel} muted={state.muted} />
              </>
            )}
            <Button
              size="sm"
              aria-pressed={!state.speakerOn}
              onClick={() => agent.setSpeaker(!state.speakerOn)}
            >
              {state.speakerOn ? "Speaker on" : "Speaker off"}
            </Button>
            <Button size="sm" className="ml-auto" onClick={agent.end}>
              End
            </Button>
          </div>
        )}
        {state.phase !== "connecting" && <Composer onSend={agent.sendText} />}
      </footer>
    </div>
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
  onApprove,
  onReject,
}: {
  proposal: Proposal;
  onApprove: () => void;
  onReject: () => void;
}) {
  const attendees = proposal.labels.attendees ?? [];
  const clickOnly = proposal.approval === "click";

  return (
    <section
      aria-label="Waiting for your approval"
      className="flex flex-col gap-3 rounded-card bg-surface p-3 ring-2 ring-brand-500"
    >
      <h3 className="text-sm font-semibold text-gray-900">
        {KIND_TITLES[proposal.kind] ?? "Proposed change"}
      </h3>
      <p className="text-sm text-gray-700">{proposal.summary}</p>

      {attendees.length > 0 && (
        <div className="text-sm">
          <p className="font-medium text-gray-700">Will be emailed</p>
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

      {proposal.warnings.map((warning) => (
        <Alert key={warning} tone="warning">
          {warning}
        </Alert>
      ))}

      <p className="text-xs text-gray-500">
        {clickOnly
          ? "This sends email, so it needs a click. Saying yes will not approve it."
          : "Say yes once you have heard it, or press Approve."}
      </p>

      <div className="flex justify-end gap-2">
        <Button onClick={onReject}>Reject</Button>
        <Button variant="primary" onClick={onApprove}>
          Approve
        </Button>
      </div>
    </section>
  );
}

function Outcome({ result }: { result: ProposalResult }) {
  if (result.status === "committed") return <Alert tone="success">Saved.</Alert>;
  if (result.status === "failed") {
    return <Alert tone="danger">Not saved. {result.error ?? "Something went wrong."}</Alert>;
  }
  if (result.status === "handed_over") {
    return (
      <Alert tone="info">
        Stopped. Nothing was saved. The form is yours to finish and save by hand.
      </Alert>
    );
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

function Composer({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState("");

  function submit() {
    if (!text.trim()) return;
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
        className="h-9 min-w-0 flex-1 rounded-md border border-gray-300 bg-surface px-3 text-sm text-gray-900"
      />
      <Button type="submit" variant="primary" disabled={!text.trim()}>
        Send
      </Button>
    </form>
  );
}
