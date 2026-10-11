/**
 * The panel's header: who is speaking, what it is doing, how much of today is left, and
 * the way out.
 *
 * The status under the title is the two-word answer to "what is it doing?". It is real
 * text in a polite live region, and it is what a screen reader is given; the orb beside
 * it is the same answer drawn, and is hidden from one.
 *
 * Before the conversation has started the orb is in the body, large, and not here: the
 * panel never shows two. When it arrives the title makes room (`AgentPanel`).
 */
import { useEffect, useState, type Ref } from "react";
import { cn } from "@/lib/cn";
import { ClockIcon, CloseIcon } from "./icons";
import { MOTION, reducedMotion } from "./motion";
import { Orb } from "./Orb";
import { clock, describeTimeLeft, resetTime, type Presence } from "./presence";

/** The length of the small ring that shows the share of the day left. */
const SHARE_RING = 2 * Math.PI * 6;

/** The status line. The old words rise out as the new ones rise in. */
function StatusLabel({ label, tone }: { label: string | null; tone: Presence["tone"] }) {
  const [shown, setShown] = useState(label);
  const [leaving, setLeaving] = useState<string | null>(null);

  // A countdown inside the label ("Reconnecting… 0:42") is the same label ticking, not
  // a new one arriving.
  const kind = (text: string | null) => text?.replace(/\d+:\d+/, "") ?? null;
  if (label !== shown) {
    setShown(label);
    setLeaving(kind(label) !== kind(shown) && !reducedMotion() ? shown : null);
  }
  useEffect(() => {
    if (leaving === null) return;
    const timer = window.setTimeout(() => setLeaving(null), MOTION.fast);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  return (
    <p
      role="status"
      aria-label="Assistant status"
      className={cn(
        "tnum relative h-4 text-xs leading-4",
        tone === "amber" ? "font-medium text-warning-600 dark:text-warning-400" : "text-gray-500",
      )}
    >
      {leaving !== null && (
        <span aria-hidden="true" className="ast-label-out">
          {leaving}
        </span>
      )}
      {label !== null && (
        <span key={kind(label)} className="ast-label-in inline-block">
          {label}
        </span>
      )}
    </p>
  );
}

/**
 * How much of today is left. "8 min" with a ring for the share of the day; a countdown in
 * amber under two minutes; nothing at zero, where the body explains. It is a button:
 * pressing it says what is left of how much, and when there is more.
 */
function TimeLeft({
  remaining,
  dailyLimit,
  open,
  onToggle,
}: {
  remaining: number;
  dailyLimit: number | null;
  open: boolean;
  onToggle: () => void;
}) {
  const low = remaining < 120;
  const share = dailyLimit ? Math.min(1, remaining / dailyLimit) : 1;
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="ast-press flex h-11 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium hover:bg-gray-100"
    >
      <svg viewBox="0 0 16 16" fill="none" strokeWidth="2" aria-hidden="true" className="size-4 -rotate-90">
        <circle cx="8" cy="8" r="6" className="stroke-gray-200" />
        <circle
          cx="8"
          cy="8"
          r="6"
          strokeLinecap="round"
          strokeDasharray={`${SHARE_RING * share} ${SHARE_RING}`}
          className={low ? "stroke-warning-500" : "stroke-gray-400"}
        />
      </svg>
      {low ? (
        <span role="timer" aria-label="Time left today" className="tnum text-warning-600 dark:text-warning-400">
          {clock(remaining)}
        </span>
      ) : (
        <span className="tnum text-gray-500">{Math.floor(remaining / 60)} min</span>
      )}
      <span className="sr-only"> left today</span>
    </button>
  );
}

function HeaderButton({
  label,
  hint,
  onClick,
  children,
}: {
  label: string;
  /** Shown on hover and focus, under the button. */
  hint?: string | undefined;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      {...(hint ? { "aria-description": hint } : {})}
      onClick={onClick}
      className="ast-press group relative grid size-11 shrink-0 place-items-center rounded-full text-gray-500 hover:text-gray-900"
    >
      <span className="grid size-8 place-items-center rounded-full transition-colors duration-150 group-hover:bg-gray-100">
        {children}
      </span>
      {hint && (
        <span
          role="tooltip"
          className="pointer-events-none absolute top-full right-0 z-10 -mt-0.5 rounded-md bg-gray-900 px-2 py-1 text-xs font-medium whitespace-nowrap text-surface opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          {hint}
        </span>
      )}
    </button>
  );
}

export function PanelHeader({
  presence,
  showOrb,
  orbRef,
  titleRef,
  live,
  remaining,
  dailyLimit,
  resetsAt,
  onHistory,
  onClose,
}: {
  presence: Presence;
  /** False while the large orb is showing in the body. */
  showOrb: boolean;
  orbRef?: Ref<HTMLSpanElement>;
  titleRef?: Ref<HTMLDivElement>;
  /** A conversation is live, or being restored: closing would end it. */
  live: boolean;
  remaining: number | null;
  dailyLimit: number | null;
  resetsAt: string | null;
  /** Open the history view. Left out while a conversation is live. */
  onHistory?: (() => void) | undefined;
  onClose: () => void;
}) {
  const [timeOpen, setTimeOpen] = useState(false);
  const back = resetTime(resetsAt);

  return (
    <header className="relative shrink-0 border-b border-gray-200">
      <div className="flex h-14 items-center gap-1 pr-1.5 pl-4">
        {showOrb && (
          <span ref={orbRef} className="mr-2 flex shrink-0">
            <Orb size={32} state={presence.orb} answering={presence.answering} />
          </span>
        )}
        <div ref={titleRef} className="min-w-0 flex-1">
          <h2
            tabIndex={-1}
            data-assistant-title
            className="truncate font-display text-[15px] leading-5 font-semibold text-gray-900 outline-none"
          >
            BuildCo Assistant
          </h2>
          <StatusLabel label={presence.label} tone={presence.tone} />
        </div>

        {remaining !== null && remaining > 0 && (
          <TimeLeft
            remaining={remaining}
            dailyLimit={dailyLimit}
            open={timeOpen}
            onToggle={() => setTimeOpen((open) => !open)}
          />
        )}
        {onHistory && (
          <HeaderButton label="Past conversations" onClick={onHistory}>
            <ClockIcon />
          </HeaderButton>
        )}
        <HeaderButton
          label="Close assistant"
          hint={live ? "Closing ends the conversation" : undefined}
          onClick={onClose}
        >
          <CloseIcon />
        </HeaderButton>
      </div>

      {timeOpen && remaining !== null && remaining > 0 && (
        <p className="ast-rise tnum border-t border-gray-100 px-4 py-2 text-xs leading-4 text-gray-600">
          {describeTimeLeft(remaining, dailyLimit)}.{back ? ` Resets at ${back}.` : ""}
        </p>
      )}
    </header>
  );
}
