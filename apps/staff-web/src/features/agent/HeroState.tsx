/**
 * The body before anything has been said: one large orb, and under it whatever fits the
 * moment.
 *
 * Idle, connecting and listening are three steps of one continuous scene. `Hero` is
 * drawn once and kept through all three, so the orb stays exactly where it is, still
 * drifting, and only what is under it changes: pressing Start does not rearrange the
 * panel, the orb simply wakes. When the first line of the conversation appears, it
 * travels to the header (`AgentPanel`).
 *
 * This is the answer to a live conversation with nothing said yet being a blank panel,
 * which is the first thing every new user saw after pressing Start. A live microphone is
 * now the largest, most alive thing on the screen.
 */
import { useEffect, useState, type ReactNode, type Ref } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/cn";
import { describeEnding, describeSeconds } from "./agentState";
import { RecentConversations } from "./AgentHistory";
import { MicIcon } from "./icons";
import { Orb } from "./Orb";
import { SHORTEST_SHOWN_S, describeTimeLeft, resetTime, type Presence } from "./presence";

/** How long "Connecting" is shown before the wait gets more words. */
const WAKING_AFTER_MS = 4000;

/** Whether the browser is about to ask for the microphone, as far as it will say. */
function useMicrophonePrompt(asking: boolean): boolean {
  const [prompting, setPrompting] = useState(false);
  useEffect(() => {
    if (!asking) {
      setPrompting(false);
      return;
    }
    let current = true;
    navigator.permissions
      ?.query({ name: "microphone" as PermissionName })
      .then((status) => current && setPrompting(status.state === "prompt"))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [asking]);
  return prompting;
}

/** The large orb on its aura, and whatever goes under it. */
export function Hero({
  presence,
  orbRef,
  children,
}: {
  presence: Presence;
  orbRef?: Ref<HTMLDivElement> | undefined;
  children: ReactNode;
}) {
  return (
    <div className="isolate flex flex-col items-center px-2 pt-8 pb-2 text-center">
      <div ref={orbRef} className="relative grid size-24 place-items-center">
        <span
          aria-hidden="true"
          className="ast-aura-hero"
          {...(presence.orb === "spent" ? { "data-off": "" } : {})}
        />
        <Orb size={96} state={presence.orb} />
      </div>
      {children}
    </div>
  );
}

/** Idle: a greeting, one sentence, the way to start, and what was said before. */
export function IdleContent({
  firstName,
  remaining,
  dailyLimit,
  alert,
  onStart,
  onOpenConversation,
  onAllConversations,
}: {
  /** From the profile, not from memory. */
  firstName: string | null;
  remaining: number | null;
  dailyLimit: number | null;
  /** Something that went wrong starting the last one. */
  alert?: ReactNode;
  onStart: () => void;
  onOpenConversation: (id: string) => void;
  onAllConversations: () => void;
}) {
  return (
    <div className="ast-stagger mt-5 flex w-full flex-col items-center gap-4">
      <div className="flex flex-col items-center gap-1.5">
        <h3 className="font-display text-xl font-semibold text-gray-900">
          {firstName ? `Hi ${firstName}` : "Hello"}
        </h3>
        <p className="max-w-[19rem] text-sm leading-5 text-gray-600">
          Ask about your work, or have a meeting or a supplement set up. Nothing is saved until
          you approve it.
        </p>
      </div>

      {alert}

      <div className="flex w-full flex-col items-center gap-1.5">
        <button
          type="button"
          onClick={onStart}
          className="ast-press flex h-12 w-full items-center justify-center gap-2 rounded-full bg-brand-600 text-sm font-semibold text-white hover:bg-brand-700"
        >
          <MicIcon />
          Start talking
        </button>
        <p className="text-xs text-gray-500">or type below</p>
        {remaining !== null && (
          <p className="tnum text-xs text-gray-500">{describeTimeLeft(remaining, dailyLimit)}</p>
        )}
      </div>

      <RecentConversations onOpen={onOpenConversation} onAll={onAllConversations} />
    </div>
  );
}

/** Today's time is used. History and memories still work, and it says when there is more. */
export function SpentContent({
  dailyLimit,
  resetsAt,
  alert,
  onOpenConversation,
  onAllConversations,
}: {
  dailyLimit: number | null;
  resetsAt: string | null;
  alert?: ReactNode;
  onOpenConversation: (id: string) => void;
  onAllConversations: () => void;
}) {
  const back = resetTime(resetsAt);
  return (
    <div className="ast-stagger mt-5 flex w-full flex-col items-center gap-4">
      <div className="flex flex-col items-center gap-1.5">
        <h3 className="font-sans text-[15px] font-semibold text-gray-900">
          {dailyLimit === null
            ? "You have used today's time."
            : `You have used today's ${Math.round(dailyLimit / 60)} minutes.`}
        </h3>
        <p className="max-w-[19rem] text-sm leading-5 text-gray-600">
          {/* 00:00 UTC, shown as the time it is here: mid-afternoon on the west coast. */}
          {back ? `More is available at ${back}. ` : ""}
          Your past conversations and what the assistant remembers are still here.
        </p>
      </div>
      {alert}
      <RecentConversations onOpen={onOpenConversation} onAll={onAllConversations} />
      <Link
        to="/profile"
        className="flex h-11 items-center text-sm font-medium text-brand-700 hover:underline dark:text-brand-300"
      >
        What the assistant remembers
      </Link>
    </div>
  );
}

/** Connecting: the orb takes its arc, and a wait of any length has words. */
export function ConnectingContent({
  microphone,
}: {
  /** This conversation asks for the microphone. */
  microphone: boolean;
}) {
  const [waking, setWaking] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setWaking(true), WAKING_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, []);
  const prompting = useMicrophonePrompt(microphone);

  return (
    <div className="mt-5 flex flex-col items-center gap-1.5">
      <p key={String(waking)} role="status" className="ast-rise text-[15px] font-semibold text-gray-900">
        {waking ? "Waking the assistant…" : "Connecting"}
      </p>
      {prompting && (
        <p className="ast-fade max-w-[19rem] text-sm leading-5 text-gray-600">
          Allow the microphone in the browser&rsquo;s prompt.
        </p>
      )}
    </div>
  );
}

/** Live, and nothing said yet. */
export function ListeningContent({ presence }: { presence: Presence }) {
  return (
    <div className="mt-5 flex flex-col items-center gap-1.5">
      <p className="ast-rise text-[15px] font-semibold text-gray-900">{presence.label}</p>
      <p className="ast-fade max-w-[19rem] text-sm leading-5 text-gray-600">
        {presence.orb === "listening" ? "Say something, or type below." : "Type below."}
      </p>
    </div>
  );
}

/**
 * The closing card, after the last line of an ended conversation: why it ended, what it
 * saved, and the way to start another. The receipts above it already say what was
 * saved, and the history list is not repeated underneath: it is behind the clock in the
 * header.
 */
export function EndedCard({
  reason,
  detail,
  saved,
  seconds,
  spent,
  resetsAt,
  className,
  onStart,
}: {
  reason: string | null;
  detail: string | null;
  /** How many changes this conversation saved. */
  saved: number;
  /** Seconds its audio was live. */
  seconds: number;
  /** Today's time is used, so another cannot be started. */
  spent: boolean;
  resetsAt: string | null;
  className?: string;
  onStart: () => void;
}) {
  const back = resetTime(resetsAt);
  const meta = [
    saved === 0 ? "Nothing saved" : `${saved} saved`,
    seconds >= SHORTEST_SHOWN_S ? describeSeconds(seconds) : null,
  ].filter(Boolean);

  return (
    <section
      aria-label="Conversation ended"
      className={cn(
        "ast-rise flex flex-col gap-3 rounded-card bg-surface p-3 text-left ring-1 ring-gray-200",
        className,
      )}
    >
      <div>
        <h3 className="font-sans text-sm font-semibold text-gray-900">Conversation ended</h3>
        <p className="mt-0.5 text-sm leading-5 text-gray-600">{describeEnding(reason, detail)}</p>
        <p className="tnum mt-0.5 text-xs text-gray-500">{meta.join(" · ")}</p>
      </div>
      {spent ? (
        <p className="text-sm leading-5 text-gray-600">
          {back ? `More time is available at ${back}.` : "Today's time has been used."}
        </p>
      ) : (
        <button
          type="button"
          onClick={onStart}
          className="ast-press flex h-11 w-full items-center justify-center gap-2 rounded-full bg-brand-600 text-sm font-semibold text-white hover:bg-brand-700"
        >
          <MicIcon />
          Start a new conversation
        </button>
      )}
    </section>
  );
}
