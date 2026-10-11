/**
 * The dock: what the assistant is working on, pinned above the controls.
 *
 * In Release 1 the step list and the approval card sat in the transcript, and a few more
 * lines of conversation pushed the thing being approved off the screen while the
 * assistant was still asking about it. Here they cannot scroll away. The dock is there
 * only when there is work, takes at most 60% of the card, and when it is that tall its
 * own content scrolls while Reject and Approve stay at its foot.
 *
 * Stop lives in its header, and in the pill over the app, and nowhere else: one in each
 * place a person may be looking. It is the secondary button in both, not red. Stop hands
 * the form over; it does not destroy anything.
 */
import { useState } from "react";
import { Button } from "@/components/Button";
import { cn } from "@/lib/cn";
import type { AgentState, Step } from "./agentState";
import { ApprovalCard } from "./ApprovalCard";
import { ArcIcon, CheckIcon, DrawnCheck, PauseIcon } from "./icons";
import type { Settling } from "./settling";

/** How many steps are listed. Earlier ones fold into one line. */
const SHOWN_STEPS = 4;

export function StepList({ steps }: { steps: Step[] }) {
  const [showEarlier, setShowEarlier] = useState(false);
  const earlier = Math.max(0, steps.length - SHOWN_STEPS);
  const shown = showEarlier ? steps : steps.slice(earlier);

  return (
    <div className="flex flex-col">
      {earlier > 0 && (
        <button
          type="button"
          aria-expanded={showEarlier}
          onClick={() => setShowEarlier((open) => !open)}
          className="-mt-1 flex h-11 items-center self-start pl-7 text-xs text-gray-500 hover:text-gray-700"
        >
          {showEarlier
            ? "Hide earlier steps"
            : `${earlier} earlier ${earlier === 1 ? "step" : "steps"}`}
        </button>
      )}
      <ol aria-label="What the assistant is doing" className="flex flex-col text-sm leading-5">
        {shown.map((step, index) => {
          const done = step.status === "done";
          return (
            <li
              key={step.id}
              className={cn(
                "relative flex items-start gap-2 pb-2 last:pb-0",
                done ? "text-gray-500" : "font-medium text-gray-900",
              )}
            >
              {done ? (
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-gray-100 text-gray-500">
                  <DrawnCheck className="size-3.5" />
                </span>
              ) : (
                <ArcIcon className="text-assistant-600 dark:text-assistant-300" />
              )}
              {/* The line to the next step, which fills downward once this one is done. */}
              {done && index < shown.length - 1 && (
                <span
                  aria-hidden="true"
                  className="ast-step-line absolute top-5 bottom-0 left-[9.5px] w-px bg-gray-300"
                />
              )}
              <span className="min-w-0">
                <span className="sr-only">{done ? "Done: " : "Now: "}</span>
                {step.label}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The one line at the top of the dock whenever the app is locked. It carries Stop. */
function DockHeader({
  steps,
  folded,
  onStop,
}: {
  steps: Step[];
  /** A proposal is waiting, so the steps are behind it: say how many, not which. */
  folded: boolean;
  onStop: () => void;
}) {
  const current = steps.find((step) => step.status === "active") ?? steps[steps.length - 1];
  return (
    <div className="flex items-center gap-2">
      {folded ? (
        <p className="flex min-w-0 flex-1 items-center gap-2 text-sm text-gray-600">
          <CheckIcon className="size-[18px] text-gray-500" />
          {steps.length === 1 ? "1 step" : `${steps.length} steps`}
        </p>
      ) : (
        <p className="flex min-w-0 flex-1 items-center gap-2 text-sm text-gray-600">
          <ArcIcon className="size-[18px] text-assistant-600 dark:text-assistant-300" />
          <span className="truncate">
            <span className="font-semibold text-gray-900">Working</span>
            {current && <span aria-hidden="true"> · {current.label}</span>}
          </span>
        </p>
      )}
      <Button size="sm" className="ast-press h-11! shrink-0 px-4!" onClick={onStop}>
        Stop
      </Button>
      <kbd className="shrink-0 rounded border border-gray-200 px-1.5 py-0.5 font-sans text-[11px] text-gray-500">
        Esc
      </kbd>
    </div>
  );
}

export function Dock({
  state,
  locked,
  speaking,
  settling,
  closing = false,
  onStop,
  onApprove,
  onReject,
  onResume,
}: {
  state: AgentState;
  locked: boolean;
  speaking: boolean;
  settling: Settling | null;
  /** On its way out. It can be seen and cannot be pressed. */
  closing?: boolean;
  onStop: () => void;
  onApprove: () => void;
  onReject: () => void;
  onResume: () => void;
}) {
  const proposal = state.proposal ?? settling?.proposal ?? null;
  const settled = state.proposal ? null : (settling?.settled ?? null);

  return (
    <div
      {...(closing ? { "data-closing": "", inert: true } : {})}
      className="ast-dock flex max-h-[60%] min-h-0 shrink-0 flex-col gap-2 border-t border-gray-200 p-3"
    >
      {locked && (
        <DockHeader steps={state.steps} folded={state.proposal !== null} onStop={onStop} />
      )}

      {locked && state.steps.length > 0 && (
        <div className="ast-fold" {...(state.proposal ? {} : { "data-open": "" })}>
          <div inert={state.proposal !== null}>
            <StepList steps={state.steps} />
          </div>
        </div>
      )}

      {proposal && (
        <ApprovalCard
          proposal={proposal}
          // Nothing can be approved over a dead connection. The card stays, so that
          // what was being asked is still in front of the user when it comes back.
          reconnecting={state.phase === "reconnecting"}
          paused={state.paused}
          speaking={speaking}
          readbackPlayed={state.readbackPlayed === proposal.id}
          settled={settled}
          onApprove={onApprove}
          onReject={onReject}
          onResume={onResume}
        />
      )}

      {/* The microphone can pause with nothing on the card to hang the button on. */}
      {!proposal && state.paused === "approval" && (
        <div className="flex items-center justify-between gap-3">
          <p className="flex items-center gap-1.5 text-sm text-gray-600">
            <PauseIcon className="size-4" />
            Microphone paused. Nothing is being sent or timed.
          </p>
          <Button size="sm" className="ast-press h-11! shrink-0 px-4!" onClick={onResume}>
            Tap to talk
          </Button>
        </div>
      )}
    </div>
  );
}
