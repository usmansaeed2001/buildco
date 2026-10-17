/**
 * Whether the assistant's launcher is on screen, and whether it is laid out for a phone.
 */
import { useEffect, useState } from "react";
import { useAgent } from "./AgentProvider";

/**
 * Below this width there is no room for a panel beside the app, so the assistant fills
 * the screen instead, and staged changes are shown with the assistant folded down to a
 * bar under them.
 */
const PHONE = "(max-width: 1023px)";

/**
 * Whether the window is narrow enough for the phone layout. Follows the window as it is
 * resized or turned. Without `matchMedia` it is not a phone.
 */
export function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia?.(PHONE).matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.(PHONE);
    if (!query) return;
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return phone;
}

/**
 * True while the launcher is showing. The shell gives the page room at its foot while it
 * is, so the button does not sit on whatever a page puts in that corner.
 *
 * Offered at every width: on a phone the panel fills the screen rather than sitting
 * beside the app.
 *
 * `hidden` is for the moment after the panel is closed, while it is still on its way
 * out: the launcher returns once it has gone.
 */
export function useLauncherShown(hidden = false): boolean {
  const agent = useAgent();
  return Boolean(agent && agent.available && !agent.panelOpen && !hidden);
}
