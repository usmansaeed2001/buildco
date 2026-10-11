/**
 * The moment a change is saved, or is not, and whether the dock has anything to hold.
 */
import { useEffect, useState } from "react";
import type { AgentState } from "./agentState";
import { MOTION, reducedMotion } from "./motion";
import type { Proposal } from "./protocol";

/** How long "Saved" stays on the card before the card gives way to its receipt. */
const HOLD_MS = MOTION.slower + 400;

export interface Settling {
  proposal: Proposal;
  settled: "saved" | "failed";
}

/**
 * Keeps the approval card on screen for a moment after its outcome arrives.
 *
 * The reducer drops the proposal the instant its result arrives, which is right: nothing
 * about the conversation waits. This keeps the card a little longer with the outcome on
 * it, so that violet can be seen to become green, and then lets it go. It is decoration
 * only. It starts on the result and never before; a new proposal cuts it short; and with
 * reduced motion it does not happen at all, and the receipt is simply there.
 */
export function useSettling(state: AgentState): Settling | null {
  const [was, setWas] = useState(state.proposal);
  const [held, setHeld] = useState<Settling | null>(null);

  // Decided during render, so there is no frame with neither the card nor its receipt.
  if (state.proposal !== was) {
    setWas(state.proposal);
    const result = state.receipts[state.receipts.length - 1];
    const settled =
      result?.status === "committed" ? "saved" : result?.status === "failed" ? "failed" : null;
    const showIt =
      !state.proposal && was && result?.id === was.id && settled !== null && !reducedMotion();
    setHeld(showIt ? { proposal: was, settled } : null);
  }

  useEffect(() => {
    if (!held) return;
    const timer = window.setTimeout(() => setHeld(null), HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [held]);

  return held;
}

/** Whether there is anything for the dock to hold. */
export function dockNeeded(state: AgentState, locked: boolean, settling: Settling | null): boolean {
  return (
    locked ||
    state.proposal !== null ||
    settling !== null ||
    (state.phase === "live" && state.paused === "approval")
  );
}
