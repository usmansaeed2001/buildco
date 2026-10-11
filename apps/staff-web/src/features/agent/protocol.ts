/**
 * The assistant's WebSocket protocol, as the browser sees it.
 *
 * Binary frames are audio: 16 kHz PCM up from the microphone, 24 kHz PCM down for the
 * agent's voice. Text frames are JSON, one of the shapes below, discriminated on `type`.
 *
 * This mirrors `apps/api/app/agent/conversation.py`. The server is the authority; if the
 * two disagree, the server is right and this file is stale.
 */

export type AgentMode = "conversing" | "working";

/** How a proposal may be approved. `click` means saying yes does not approve it. */
export type ApprovalPolicy = "voice_or_click" | "click";

export interface StagedAttendeeLabel {
  label: string;
  note?: string;
}

/** One detail of a supplement as it is and as it would be. */
export interface StagedChange {
  field: string;
  label: string;
  old: string;
  new: string;
}

/** What a staged screen shows that the payload alone does not say. */
export interface ProposalLabels {
  /** Where in the app it is staged. Absent for a change shown only in the panel. */
  route?: string;
  when?: string;
  attendees?: StagedAttendeeLabel[];
  /** The whole meeting form as it would be after an edit. */
  form?: Record<string, unknown>;
  /** Removed people an edit takes off a meeting. */
  dropped?: string[];
  /** A supplement, named as it is said aloud. */
  name?: string;
  changes?: StagedChange[];
  action?: string;
  action_label?: string;
  status?: string;
  total?: string;
  reviewer?: { name: string; email: string };
  /** A memory as it is, and as it would be. `null` for the new text means forget it. */
  old?: string;
  new?: string | null;
  warnings?: string[];
}

/** A change the assistant has staged and is waiting to be told to save, or not. */
export interface Proposal {
  id: string;
  /** What it would do, e.g. `meeting.create`. */
  kind: string;
  /** The read-back, word for word as the server wrote it. */
  summary: string;
  /** Exactly what would be saved. */
  payload: Record<string, unknown>;
  labels: ProposalLabels;
  warnings: string[];
  approval: ApprovalPolicy;
  expires_at: string;
}

export type ProposalOutcome =
  | "committed"
  | "cancelled"
  | "failed"
  | "superseded"
  | "expired"
  | "handed_over";

/** The record a committed proposal created or changed. */
export interface Target {
  type: string;
  id: string;
}

export interface RememberedMemory {
  id: string;
  category: string;
  content: string;
}

// ── Down: server to browser ─────────────────────────────────────────────────

export type ServerFrame =
  | {
      type: "ready";
      conversation_id: string;
      limits: { max_session_seconds: number; remaining_seconds?: number };
      /** True when this socket picked up a conversation whose connection had dropped. */
      resumed?: boolean;
    }
  | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean }
  /** The user spoke over the agent. Audio already received must not be played. */
  | { type: "interrupted" }
  /**
   * The agent finished a turn. `readback_for` names a proposal when that turn was its
   * read-back; the browser reports back once the audio has actually played.
   */
  | { type: "turn_complete"; spoke: boolean; readback_for: string | null }
  | { type: "mode"; mode: AgentMode }
  /**
   * `paused` means the microphone must stop: nobody answered a read-back, or the day's
   * allowance ran out with a proposal still waiting. Nothing is streamed or metered.
   */
  | { type: "audio"; state: "live" | "paused"; reason?: "approval" | "allowance" }
  | { type: "step"; id: string; label: string; status: "active" | "done" }
  | { type: "ui"; directive_id: string; action: "stage"; proposal: Proposal }
  | { type: "ui"; directive_id: string; action: "unstage" }
  | { type: "ui"; directive_id: string; action: "navigate"; to: string }
  /** Make sure this supplement's editor, if it is open, has finished saving. */
  | { type: "ui"; directive_id: string; action: "prepare"; supplement_id: string }
  | { type: "ui"; directive_id: string; action: "refresh"; keys: string[]; target?: Target }
  | ({ type: "proposal" } & Proposal)
  | {
      type: "proposal_result";
      id: string;
      status: ProposalOutcome;
      target?: Target;
      error?: string | null;
    }
  | { type: "memory"; event: "remembered"; memory: RememberedMemory }
  | { type: "notice"; kind: string; seconds?: number }
  | { type: "error"; code: string; message: string }
  | { type: "ended"; reason: string; detail?: string | null };

// ── Up: browser to server ───────────────────────────────────────────────────

/** The record on screen, for "this one". */
export interface ViewedRecord {
  type: "supplement" | "meeting" | "project";
  id: string;
  label?: string;
}

export type ClientFrame =
  | { type: "text"; text: string }
  | {
      type: "context";
      route: string;
      dialog_open: boolean;
      entity?: ViewedRecord | null;
      editor_save_state?: string | null;
    }
  /** The read-back finished playing, or with the speaker off, was shown in full. */
  | { type: "readback_played"; proposal_id: string }
  /** Tap to talk: end an approval pause. */
  | { type: "resume" }
  | { type: "approval"; proposal_id: string; decision: "approve" | "reject" }
  | { type: "stop" }
  | { type: "ui_ack"; directive_id: string; ok: boolean; reason?: string }
  | { type: "end" };

/** Why the socket was refused, from its close code. Mirrors `app/agent/live.py`. */
export function closeReason(code: number): string | null {
  if (code === 4401) return "That session could not be opened. Please try again.";
  if (code === 4403) return "The assistant cannot be used from this address.";
  return null;
}
