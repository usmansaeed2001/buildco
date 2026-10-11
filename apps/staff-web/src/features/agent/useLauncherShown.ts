/**
 * Whether the assistant's launcher is on screen.
 */
import { useEffect, useState } from "react";
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

/**
 * True while the launcher is showing. The shell gives the page room at its foot while it
 * is, so the button does not sit on whatever a page puts in that corner.
 *
 * `hidden` is for the moment after the panel is closed, while it is still on its way
 * out: the launcher returns once it has gone.
 */
export function useLauncherShown(hidden = false): boolean {
  const agent = useAgent();
  const wide = useWideWindow();
  return Boolean(agent && agent.available && !agent.panelOpen && wide && !hidden);
}
