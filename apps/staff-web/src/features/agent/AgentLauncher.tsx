/**
 * The button that opens the assistant, and the pieces of the shell that only exist
 * because of it: the banner over the locked app, and the tint on a record it has just
 * saved.
 */
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useAppFrame } from "@/components/AppFrame";
import { Button } from "@/components/Button";
import { useAgent } from "./AgentProvider";
import { reducedMotion } from "./motion";
import { Orb } from "./Orb";
import { resetTime } from "./presence";
import { useLauncherShown } from "./useLauncherShown";

const SEEN_KEY = "buildco.assistant.launcher-seen";
/** How long the banner says how to take over, after a click on the locked app. */
const HINT_MS = 3000;
/** How long a saved record keeps its tint, and how long it is looked for. */
const TINT_MS = 2600;
const FIND_FOR_MS = 3000;

/** True the first time the launcher is shown in a session, and never again. */
function useFirstVisit(): boolean {
  const [first] = useState(() => {
    try {
      if (sessionStorage.getItem(SEEN_KEY)) return false;
      sessionStorage.setItem(SEEN_KEY, "1");
      return true;
    } catch {
      return false;
    }
  });
  return first;
}

export function AgentLauncher({
  hidden = false,
  takeFocus = false,
  onFocused,
}: {
  /** The panel is still on its way out. The launcher returns once it has gone. */
  hidden?: boolean;
  /** The panel was just closed, so focus comes back to where it was opened from. */
  takeFocus?: boolean;
  onFocused?: () => void;
}) {
  const shown = useLauncherShown(hidden);
  if (!shown) return null;
  return <Launcher takeFocus={takeFocus} onFocused={onFocused} />;
}

function Launcher({
  takeFocus,
  onFocused,
}: {
  takeFocus: boolean;
  onFocused?: (() => void) | undefined;
}) {
  const agent = useAgent();
  const first = useFirstVisit();
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!takeFocus) return;
    button.current?.focus({ preventScroll: true });
    onFocused?.();
    // Once, as it comes back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!agent) return null;
  const spent = agent.remainingToday !== null && agent.remainingToday <= 0;
  const back = spent ? resetTime(agent.resetsAt) : null;

  return (
    <button
      ref={button}
      type="button"
      onClick={agent.openPanel}
      aria-label="Ask BuildCo Assistant"
      {...(back ? { "aria-description": `Back at ${back}` } : {})}
      {...(first ? { "data-first": "" } : {})}
      className="ast-launcher"
    >
      {/* Still at rest; it wakes when hovered or focused. It still opens the panel when
          today's time is used, because history and memory still work. */}
      <Orb size={56} state={spent ? "spent" : "resting"} />
      <span
        aria-hidden="true"
        className="ast-launcher-label rounded-full bg-surface px-3.5 py-2 text-sm font-medium whitespace-nowrap text-gray-900 shadow-float ring-1 ring-gray-200"
      >
        {back ? `Back at ${back}` : "Ask BuildCo Assistant"}
      </span>
    </button>
  );
}

/** What sits over the locked app while the assistant is working. */
export function AgentLockBanner() {
  const agent = useAgent();
  const frame = useAppFrame();
  const clicks = frame?.lockedClicks ?? 0;
  const [hinting, setHinting] = useState(false);
  const seen = useRef(clicks);

  // A click on the locked app used to do nothing and say nothing. Now the banner
  // answers it: it nudges once and says how to take over.
  useEffect(() => {
    if (clicks === seen.current) return;
    seen.current = clicks;
    setHinting(true);
    const timer = window.setTimeout(() => setHinting(false), HINT_MS);
    return () => window.clearTimeout(timer);
  }, [clicks]);

  if (!agent) return null;
  const steps = agent.state.steps;
  const step = steps.find((candidate) => candidate.status === "active") ?? steps[steps.length - 1];

  return (
    <div
      // Remounted by each click, so the nudge plays again.
      key={hinting ? `nudge-${clicks}` : "still"}
      {...(hinting ? { "data-nudge": "" } : {})}
      className="ast-lock-banner flex max-w-full items-center gap-2.5 rounded-full bg-assistant-600 py-1 pr-1 pl-3 text-sm text-white shadow-float"
    >
      <Orb size={20} state="working" />
      <span className="font-semibold whitespace-nowrap">BuildCo Assistant is working</span>
      {(hinting || step) && (
        <span role={hinting ? "status" : undefined} className="min-w-0 truncate text-white/80">
          {hinting ? "Press Stop to take over" : step?.label}
        </span>
      )}
      <Button size="sm" variant="secondary" className="ast-press h-11! shrink-0 rounded-full! px-4!" onClick={agent.stop}>
        Stop
      </Button>
      <kbd className="mr-2 shrink-0 rounded border border-white/30 px-1.5 py-0.5 font-sans text-[11px] text-white/80">
        Esc
      </kbd>
    </div>
  );
}

/**
 * After a save, the saved record is tinted green for a moment: the meeting on the
 * calendar, the row in the list, the header of the supplement. Violet became green in
 * the panel at the same instant, so "not saved yet" visibly turns into "saved" in both
 * places.
 *
 * A page marks what it shows with `data-agent-record="meeting:<id>"`. The record may not
 * be on the page yet when the commit lands, because the list is still being fetched
 * again, so it is looked for briefly. It draws nothing itself.
 */
export function AgentSavedTint() {
  const agent = useAgent();
  const commits = agent?.state.commits ?? 0;
  const last = agent?.state.lastResult;
  const target = last?.status === "committed" ? last.target : null;
  const key = target ? `${target.type}:${target.id}` : null;
  const seen = useRef(commits);

  useEffect(() => {
    if (commits === seen.current) return;
    seen.current = commits;
    if (!key) return;

    const started = Date.now();
    let tinted: Element | null = null;
    let clear = 0;
    const look = window.setInterval(() => {
      const named = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(key) : key;
      const record = document.querySelector(`[data-agent-record="${named}"]`);
      if (!record) {
        if (Date.now() - started > FIND_FOR_MS) window.clearInterval(look);
        return;
      }
      window.clearInterval(look);
      const box = record.getBoundingClientRect();
      if (box.bottom < 0 || box.top > window.innerHeight) {
        record.scrollIntoView?.({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
      }
      tinted = record;
      // The tint is drawn over the record, so the record has to be what it is placed
      // against. One that is already placed (an event on the time grid) is left alone.
      const placed = window.getComputedStyle(record).position !== "static";
      record.classList.add("ast-saved", ...(placed ? [] : ["ast-saved-rel"]));
      clear = window.setTimeout(
        () => record.classList.remove("ast-saved", "ast-saved-rel"),
        TINT_MS,
      );
    }, 120);

    return () => {
      window.clearInterval(look);
      window.clearTimeout(clear);
      tinted?.classList.remove("ast-saved", "ast-saved-rel");
    };
  }, [commits, key]);

  return null;
}

/**
 * Tells the assistant what the user is looking at: the page, and whether they have a
 * dialog of their own open. Rendered inside the frame because that is where the count of
 * open dialogs lives. It draws nothing.
 */
export function AgentContextReporter() {
  const agent = useAgent();
  const frame = useAppFrame();
  const { pathname } = useLocation();
  const dialogOpen = (frame?.openDialogs ?? 0) > 0;
  const report = agent?.reportContext;

  useEffect(() => {
    report?.({ route: pathname, dialogOpen });
  }, [report, pathname, dialogOpen]);

  return null;
}
