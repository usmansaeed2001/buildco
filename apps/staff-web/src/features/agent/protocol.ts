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

/**
 * One thing a proposal would save, laid out for the approval card: a label and the value
 * exactly as it should be read. The server formats it, so the browser never works out a
 * date or looks a person up itself.
 */
export interface ProposalFact {
  label: string;
  value: string;
  /** What it is now, for an edit. */
  was?: string;
  /** Where the value came from: `memory`, `catalogue`, `stated` or `differs`. */
  source?: string;
}

/** Why a proposal can only be approved by a click. */
export type ApprovalReason = "sends_email" | "changes_access" | "readback_unverified";

/** What a staged screen shows that the payload alone does not say. */
export interface ProposalLabels {
  /**
   * The facts for the approval card, in order. Not sent yet: until it is, the card is
   * drawn from the labels below.
   */
  facts?: ProposalFact[];
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
  /**
   * What a user on a phone says back to approve it by voice. Absent for anything only a
   * click approves.
   */
  confirm?: { line: string };
  /** Lines being added to a supplement, each as it would be saved. */
  lines?: AddedLineLabel[];
  /** Rooms the added lines create. */
  new_rooms?: string[];
  /** The supplement's total before and after, as decimal strings. */
  old_total?: string;
  new_total?: string;
}

/** One line a proposal would add. Money and quantities are decimal strings. */
export interface AddedLineLabel {
  room: string;
  room_index: number;
  new_room: boolean;
  name: string;
  quantity: string;
  unit: string;
  category: string;
  unit_cost: string;
  /** The catalogue's price, when the user stated a different one. */
  catalogue_unit_cost: string | null;
  /** `catalogue`, `stated` or `differs`. */
  source: string;
  total: string;
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
  /** Why it needs a click, when it does. Not sent yet: the card has a neutral line. */
  approval_reason?: ApprovalReason;
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

/** The part of the record that is selected, for "this room". */
export interface ViewedSelection {
  room_position: number;
  room_name: string;
}

/** How the app is laid out: a panel beside it, or the assistant filling a phone. */
export type Layout = "phone" | "wide";

export type ClientFrame =
  | { type: "text"; text: string }
  | {
      type: "context";
      route: string;
      dialog_open: boolean;
      entity?: ViewedRecord | null;
      selection?: ViewedSelection | null;
      editor_save_state?: string | null;
      layout?: Layout;
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
