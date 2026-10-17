/**
 * The assistant's panel: what is being said, what it is doing, and what it is asking
 * permission for.
 *
 * A card with four fixed zones, top to bottom:
 *
 *   1  header    the orb, the status, the time left, the way out
 *   2  body      the only zone that scrolls: the conversation, or a view that replaces it
 *   3  dock      only when there is work: the steps and the approval card, pinned
 *   4  controls  the text box, the voice controls, End
 *
 * On a phone it fills the screen, or folds down to a bar along the foot (`compact`) so
 * the app can be seen: the header, the dock and the controls, and no conversation. A
 * staged change is shown that way, with its approval card pinned under the form.
 *
 * It stays fully usable while the app beside it is locked. Stop, Approve, Reject and the
 * text box are the user's controls over the assistant, so they are never the thing that
 * is disabled, and no animation here delays, hides or moves one that could be pressed.
 *
 * This file is the composition and nothing else decides behaviour here: what a frame
 * means, when the app locks, and what Approve, Reject, Stop and End do all live in the
 * provider and the reducer, and are unchanged by how any of it is drawn.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useAuth } from "@/auth/useAuth";
import { Alert } from "@/components/feedback";
import { cn } from "@/lib/cn";
import { HistoryView } from "./AgentHistory";
import { useAgent, type AgentContextValue } from "./AgentProvider";
import { Controls } from "./Controls";
import { Conversation, Notice } from "./Conversation";
import { Dock } from "./Dock";
import {
  ConnectingContent,
  EndedCard,
  Hero,
  IdleContent,
  ListeningContent,
  SpentContent,
} from "./HeroState";
import { ArrowDownIcon } from "./icons";
import { kindTitle } from "./kinds";
import { MOTION, slideFrom, travel } from "./motion";
import { PanelHeader } from "./PanelHeader";
import { describePresence } from "./presence";
import { dockNeeded, useSettling } from "./settling";
import { usePresence } from "./usePresence";

/** How long a dropped conversation can be got back. The server's figure. */
const RECONNECT_WINDOW_S = 60;
/** How near the foot of the conversation counts as following it. */
const FOLLOW_SLACK_PX = 32;

export function AgentPanel({
  closing = false,
  compact = false,
  firstName,
  showHistory,
}: {
  /** The panel has been closed and is on its way out. */
  closing?: boolean;
  /** Folded down to a bar on a phone: everything but the conversation. */
  compact?: boolean;
  /** Who to greet. Left out, it is the signed-in person's first name. */
  firstName?: string | null;
  /**
   * Open on the history view: `null` for the list, an id for one conversation. For the
   * gallery of states. Left out, the panel opens on the conversation as it always does.
   */
  showHistory?: string | null;
}) {
  const current = useAgent();
  // Closing the panel resets the conversation at once. What is leaving the screen is
  // the panel as it was, not an idle one fading out in its place.
  const shown = useRef(current);
  if (current && !closing) shown.current = current;
  const agent = closing ? shown.current : current;
  if (!agent) return null;
  return (
    <Panel
      agent={agent}
      closing={closing}
      compact={compact}
      firstName={firstName}
      showHistory={showHistory}
    />
  );
}

/** Seconds left to get a dropped conversation back, counted here for the header. */
function useReconnectCountdown(reconnecting: boolean): number | null {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!reconnecting) {
      setLeft(null);
      return;
    }
    const until = Date.now() + RECONNECT_WINDOW_S * 1000;
    const update = () => setLeft(Math.max(0, (until - Date.now()) / 1000));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [reconnecting]);
  return left;
}

function useFirstName(override: string | null | undefined): string | null {
  const { profile } = useAuth();
  if (override !== undefined) return override;
  return profile?.full_name?.trim().split(/\s+/)[0] || null;
}

function Panel({
  agent,
  closing,
  compact,
  firstName: greet,
  showHistory,
}: {
  agent: AgentContextValue;
  closing: boolean;
  compact: boolean;
  firstName?: string | null | undefined;
  showHistory?: string | null | undefined;
}) {
  const { state, locked, levels } = agent;
  const firstName = useFirstName(greet);
  const speaking = useSyncExternalStore(levels.subscribe, levels.speaking);

  // The levels are written on this element, for the orb and the microphone button.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    levels.attach(root.current);
    return () => levels.attach(null);
  }, [levels]);

  // Opening the panel moves focus to its title: never to anything that acts.
  useEffect(() => {
    // Unless something in it already has focus: an approval card that was waiting
    // when the panel was drawn has taken it to its own title.
    if (root.current?.contains(document.activeElement)) return;
    root.current?.querySelector<HTMLElement>("[data-assistant-title]")?.focus({ preventScroll: true });
  }, []);

  const live = state.phase === "live";
  const between = state.phase === "idle" || state.phase === "ended";
  const spent = between && agent.remainingToday !== null && agent.remainingToday <= 0;
  const reconnectIn = useReconnectCountdown(state.phase === "reconnecting");
  const presence = describePresence(state, {
    speaking,
    spent,
    resetsAt: agent.resetsAt,
    reconnectIn,
  });

  // History replaces the body, and only between conversations.
  const [history, setHistory] = useState<{ opened: string | null; returning: boolean } | null>(
    showHistory === undefined ? null : { opened: showHistory, returning: false },
  );
  const view = between ? history : null;

  const nothingSaid =
    state.transcript.length === 0 &&
    state.receipts.length === 0 &&
    state.remembered.length === 0 &&
    state.marks.length === 0;
  const settling = useSettling(state);
  const needsDock = dockNeeded(state, locked, settling);
  // The large orb is the centre of the body until something has been said. After a
  // conversation has ended there is something to read instead: why, and what next.
  const hero =
    !compact &&
    view === null &&
    nothingSaid &&
    !needsDock &&
    (state.phase === "idle" || state.phase === "connecting" || live);

  // ── The orb travels from the centre of the body to the header on the first words ──
  const heroOrb = useRef<HTMLDivElement>(null);
  const headerOrb = useRef<HTMLSpanElement>(null);
  const title = useRef<HTMLDivElement>(null);
  const heroAt = useRef<DOMRect | null>(null);
  const wasHero = useRef(hero);
  useLayoutEffect(() => {
    if (hero) heroAt.current = heroOrb.current?.getBoundingClientRect() ?? null;
  });
  useLayoutEffect(() => {
    if (wasHero.current && !hero && view === null) {
      travel(headerOrb.current, heroAt.current);
      slideFrom(title.current, -42);
    }
    wasHero.current = hero;
  }, [hero, view]);

  // ── The dock leaves visibly, with what was in it ──
  const dock = usePresence(needsDock, MOTION.fast);
  const dockWas = useRef({ state, locked, settling });
  if (needsDock) dockWas.current = { state, locked, settling };
  const inDock = dockWas.current;

  // ── The body follows the newest line until the user scrolls away from it ──
  const scroller = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const scrollIdle = useRef(0);
  const measure = () => {
    const element = scroller.current;
    if (!element) return true;
    const below = element.scrollHeight - element.scrollTop - element.clientHeight;
    element.toggleAttribute("data-more-above", element.scrollTop > 2);
    element.toggleAttribute("data-more-below", below > 2);
    return below < FOLLOW_SLACK_PX;
  };
  const toLatest = () => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
    measure();
  };
  const last = state.transcript[state.transcript.length - 1];
  const grown = [
    state.transcript.length,
    last?.text.length ?? 0,
    state.receipts.length,
    state.marks.length,
    state.remembered.length,
    state.notice,
    state.problem,
    state.phase,
    settling?.proposal.id ?? "",
    dock.mounted,
  ].join("|");
  useLayoutEffect(() => {
    if (following) toLatest();
    else measure();
    // What is in the body changed. Whether to follow is read, not reacted to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grown, view]);

  // ── What a screen reader is told, beyond the status and the conversation itself ──
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (locked) setAnnouncement("App locked. Press Escape to stop.");
  }, [locked]);
  const waiting = state.proposal;
  const waitingId = waiting?.id;
  useEffect(() => {
    if (!waiting) return;
    setAnnouncement(
      `Waiting for your approval: ${kindTitle(waiting.kind, waiting.labels.action_label)}`,
    );
    // Once per proposal, not each time the server sends the same card again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingId]);
  const receipts = state.receipts.length;
  useEffect(() => {
    const newest = state.receipts[state.receipts.length - 1];
    if (!newest) return;
    setAnnouncement(newest.status === "committed" ? "Saved." : "Not saved.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipts]);

  const saved = state.receipts.filter((result) => result.status === "committed").length;
  const alert = state.problem ? <Alert tone="danger">{state.problem}</Alert> : undefined;
  const openHistory = (opened: string | null) => setHistory({ opened, returning: false });

  let body: ReactNode;
  if (view) {
    body = (
      <HistoryView
        key={view.opened ?? "list"}
        opened={view.opened}
        returning={view.returning}
        onOpen={openHistory}
        onBack={() => setHistory(view.opened ? { opened: null, returning: true } : null)}
      />
    );
  } else if (hero) {
    // One orb, drawn once and kept through idle, connecting and listening. Only what
    // is under it changes.
    body = (
      <>
        <Hero presence={presence} orbRef={heroOrb}>
          {state.phase === "connecting" ? (
            <ConnectingContent microphone={state.microphone} />
          ) : live ? (
            <ListeningContent presence={presence} />
          ) : spent ? (
            <SpentContent
              dailyLimit={agent.dailyLimit}
              resetsAt={agent.resetsAt}
              alert={alert}
              onOpenConversation={openHistory}
              onAllConversations={() => openHistory(null)}
            />
          ) : (
            <IdleContent
              firstName={firstName}
              remaining={agent.remainingToday}
              dailyLimit={agent.dailyLimit}
              alert={alert}
              onStart={agent.startVoice}
              onOpenConversation={openHistory}
              onAllConversations={() => openHistory(null)}
            />
          )}
        </Hero>
        {live && alert}
        {live && state.notice && <Notice live>{state.notice}</Notice>}
      </>
    );
  } else {
    body = (
      <>
        <div
          className={cn(
            "transition-opacity duration-[480ms]",
            // Still the same conversation, and not one that can be carried on yet.
            state.phase === "reconnecting" && "opacity-60",
          )}
        >
          <Conversation
            state={state}
            speaking={speaking}
            settling={settling?.proposal.id ?? null}
            onForget={agent.forget}
          />
        </div>
        {alert}
        {live && state.paused === "allowance" && (
          <Notice live>
            Today&apos;s time has been used. You can still approve or reject this.
          </Notice>
        )}
        {live && state.notice && state.paused !== "allowance" && (
          <Notice live>{state.notice}</Notice>
        )}
        {state.phase === "ended" && (
          <EndedCard
            reason={state.endedReason}
            detail={state.endedDetail}
            saved={saved}
            seconds={state.elapsed}
            spent={spent}
            resetsAt={agent.resetsAt}
            onStart={agent.startVoice}
          />
        )}
      </>
    );
  }

  const aura = live ? "violet" : state.phase === "reconnecting" ? "amber" : null;

  return (
    <div
      ref={root}
      data-assistant-panel
      inert={closing}
      onKeyDown={(event) => {
        // Escape closes a view. It never closes the panel: closing ends the
        // conversation, so nothing may do it by accident.
        if (event.key !== "Escape" || !view || locked) return;
        event.preventDefault();
        setHistory(view.opened ? { opened: null, returning: true } : null);
      }}
      className={cn("relative flex flex-col", compact ? "max-h-[80dvh]" : "h-full")}
    >
      <span aria-hidden="true" className="ast-aura-top" data-tone="violet" {...(aura === "violet" ? { "data-on": "" } : {})} />
      <span aria-hidden="true" className="ast-aura-top" data-tone="amber" {...(aura === "amber" ? { "data-on": "" } : {})} />

      <PanelHeader
        presence={presence}
        showOrb={!hero}
        orbRef={headerOrb}
        titleRef={title}
        live={!between}
        remaining={agent.remainingToday}
        dailyLimit={agent.dailyLimit}
        resetsAt={agent.resetsAt}
        onHistory={between && !view && !compact ? () => openHistory(null) : undefined}
        onFold={agent.phone && !compact ? () => agent.setPhoneView("mini") : undefined}
        onExpand={agent.phone && compact ? () => agent.setPhoneView("full") : undefined}
        onClose={agent.closePanel}
      />

      <div className={cn("relative flex min-h-0 flex-1 flex-col", compact && "hidden")}>
        <div
          ref={scroller}
          onScroll={() => {
            const element = scroller.current;
            const atFoot = measure();
            if (atFoot !== following) setFollowing(atFoot);
            if (!element) return;
            element.setAttribute("data-scrolling", "");
            window.clearTimeout(scrollIdle.current);
            scrollIdle.current = window.setTimeout(
              () => element.removeAttribute("data-scrolling"),
              800,
            );
          }}
          className="ast-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
        >
          {body}
        </div>

        {!following && !view && !hero && (
          <button
            type="button"
            onClick={() => {
              toLatest();
              setFollowing(true);
            }}
            className="ast-pop absolute bottom-2 left-1/2 -ml-11 flex h-11 w-[5.5rem] items-center justify-center gap-1 rounded-full bg-surface text-xs font-semibold text-gray-700 shadow-float ring-1 ring-gray-200"
          >
            <ArrowDownIcon className="size-4" />
            Latest
          </button>
        )}
      </div>

      {dock.mounted && (
        <Dock
          compact={compact}
          phone={agent.phone}
          state={inDock.state}
          locked={inDock.locked}
          speaking={speaking}
          settling={inDock.settling}
          closing={dock.closing}
          onStop={agent.stop}
          onApprove={agent.approve}
          onReject={agent.reject}
          onResume={agent.resume}
        />
      )}

      {state.phase !== "connecting" && (
        <Controls
          live={live}
          ending={state.phase === "reconnecting"}
          microphone={state.microphone}
          muted={state.muted}
          micPaused={state.paused !== null}
          speakerOn={state.speakerOn}
          voiceOff={state.paused === "allowance"}
          textOff={spent || state.paused === "allowance"}
          placeholder={
            spent || state.paused === "allowance"
              ? "No time left today"
              : state.proposal
                ? "Type a correction"
                : "Type a message"
          }
          onMute={agent.setMuted}
          onSpeaker={agent.setSpeaker}
          onEnd={agent.end}
          onSend={agent.sendText}
        />
      )}

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
