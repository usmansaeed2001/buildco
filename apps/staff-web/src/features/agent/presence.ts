/**
 * What the assistant is doing right now, as a drawing and two words.
 *
 * "State first": at a glance, without reading, is it listening, thinking, speaking,
 * working, waiting for me, or stopped? Everything here is worked out from what the panel
 * already knows. Nothing new is asked of the server.
 */
import { describeSeconds, type AgentState } from "./agentState";
import type { OrbState } from "./Orb";

export interface Presence {
  orb: OrbState;
  /** Two words at most. Null when there is nothing to say: idle, and ended. */
  label: string | null;
  /** Amber is "look at this": reconnecting, and time running out. */
  tone: "plain" | "amber";
  /** The time a spoken answer has is running. */
  answering: boolean;
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** "5:00 PM": when today's time starts again, where the user is. */
export function resetTime(resetsAt: string | null): string | null {
  if (!resetsAt) return null;
  const when = new Date(resetsAt);
  return Number.isNaN(when.getTime()) ? null : TIME.format(when);
}

/**
 * Shorter than this, a duration says nothing worth reading. The figure is metered audio
 * time, so a typed or very short conversation honestly lasted "0 s", and looked broken.
 */
export const SHORTEST_SHOWN_S = 5;

/** "1 min 18 s of voice", or nothing when there was next to none. */
export function describeVoice(seconds: number): string | null {
  return seconds >= SHORTEST_SHOWN_S ? `${describeSeconds(seconds)} of voice` : null;
}

/** "8 of 10 minutes left today". */
export function describeTimeLeft(remaining: number, limit: number | null): string {
  const left = remaining >= 120 ? String(Math.floor(remaining / 60)) : describeSeconds(remaining);
  if (limit === null) return remaining >= 120 ? `${left} minutes left today` : `${left} left today`;
  return `${left} of ${Math.round(limit / 60)} minutes left today`;
}

/** "0:42", for a countdown. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function describePresence(
  state: AgentState,
  facts: {
    /** The assistant's voice is playing. */
    speaking: boolean;
    /** Today's allowance is used and no conversation is live. */
    spent: boolean;
    resetsAt: string | null;
    /** Seconds left to get a dropped conversation back. */
    reconnectIn?: number | null;
  },
): Presence {
  const plain = (orb: OrbState, label: string | null): Presence => ({
    orb,
    label,
    tone: "plain",
    answering: false,
  });

  if (state.phase === "connecting") return plain("connecting", "Connecting");
  if (state.phase === "reconnecting") {
    const left = facts.reconnectIn;
    return {
      orb: "reconnecting",
      label: left == null ? "Reconnecting…" : `Reconnecting… ${clock(left)}`,
      tone: "amber",
      answering: false,
    };
  }
  if (state.phase !== "live") {
    if (!facts.spent) return plain("resting", null);
    const back = resetTime(facts.resetsAt);
    return plain("spent", back ? `Back at ${back}` : "Time used");
  }

  if (state.paused === "allowance") return plain("spent", "Time used");
  if (state.paused === "approval") return plain("paused", "Microphone paused");

  const last = state.transcript[state.transcript.length - 1];
  // With the speaker off nothing plays, and the words arriving are the speaking.
  const speaking = facts.speaking || (last?.role === "assistant" && !last.final);
  if (speaking) return plain("speaking", "Speaking");

  if (state.proposal) {
    return {
      orb: "waiting",
      label: "Waiting for you",
      tone: "plain",
      answering:
        state.proposal.approval === "voice_or_click" &&
        state.readbackPlayed === state.proposal.id,
    };
  }
  if (state.mode === "working") return plain("working", "Working");
  if (state.microphone && state.muted) return plain("muted", "Muted");
  // From the user's last word until the assistant's first.
  if (last?.role === "user" && last.final) return plain("thinking", "Thinking");
  // A conversation started by typing has no microphone to be listening with.
  return state.microphone ? plain("listening", "Listening") : plain("resting", "Ready");
}
