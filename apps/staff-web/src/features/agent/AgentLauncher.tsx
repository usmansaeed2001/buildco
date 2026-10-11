/**
 * The round button that opens the assistant, and the two small pieces of the shell that
 * only exist because of it.
 */
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useAppFrame } from "@/components/AppFrame";
import { Button } from "@/components/Button";
import { useAgent } from "./AgentProvider";

/** The width from which the launcher is offered. Below it there is no room for a panel. */
const WIDE = "(min-width: 1024px)";

/**
 * Whether the window is wide enough to *offer* the assistant.
 *
 * This decides only whether the launcher is shown. A conversation already under way is
 * never hidden by the window getting narrower: the panel stays and overlays the app.
 */
function useWideWindow(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia?.(WIDE).matches ?? true);
  useEffect(() => {
    const query = window.matchMedia?.(WIDE);
    if (!query) return;
    const update = () => setWide(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return wide;
}

export function AgentLauncher() {
  const agent = useAgent();
  const wide = useWideWindow();
  if (!agent || !agent.available || agent.panelOpen || !wide) return null;

  return (
    <button
      type="button"
      onClick={agent.openPanel}
      aria-label="Ask BuildCo Assistant"
      title="Ask BuildCo Assistant"
      className="fixed bottom-4 left-4 z-40 flex size-12 items-center justify-center rounded-full bg-brand-600 text-white shadow-lg hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" className="size-6">
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" strokeLinecap="round" />
      </svg>
    </button>
  );
}

/** What sits over the locked app while the assistant is working. */
export function AgentLockBanner() {
  const agent = useAgent();
  if (!agent) return null;
  return (
    <div className="flex items-center gap-3 rounded-full bg-brand-600 py-1.5 pr-1.5 pl-4 text-sm font-medium text-white shadow-lg">
      BuildCo Assistant is working
      <Button size="sm" variant="secondary" onClick={agent.stop}>
        Stop
      </Button>
    </div>
  );
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
