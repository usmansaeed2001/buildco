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

/** A change the assistant has staged and is waiting to be told to save, or not. */
export interface Proposal {
  id: string;
  /** What it would do, e.g. `meeting.create`. */
  kind: string;
  /** The read-back, word for word as the server wrote it. */
  summary: string;
  /** Exactly what would be saved. */
  payload: Record<string, unknown>;
  /** What the payload does not say by itself, such as the name behind an attendee id. */
  labels: { when?: string; attendees?: StagedAttendeeLabel[] } & Record<string, unknown>;
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

// ── Down: server to browser ─────────────────────────────────────────────────

export type ServerFrame =
  | { type: "ready"; conversation_id: string; limits: { max_session_seconds: number } }
  | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean }
  /** The user spoke over the agent. Audio already received must not be played. */
  | { type: "interrupted" }
  /**
   * The agent finished a turn. `readback_for` names a proposal when that turn was its
   * read-back; the browser reports back once the audio has actually played.
   */
  | { type: "turn_complete"; spoke: boolean; readback_for: string | null }
  | { type: "mode"; mode: AgentMode }
  | { type: "step"; id: string; label: string; status: "active" | "done" }
  | { type: "ui"; directive_id: string; action: "stage"; proposal: Proposal }
  | { type: "ui"; directive_id: string; action: "unstage" }
  | { type: "ui"; directive_id: string; action: "refresh"; keys: string[] }
  | ({ type: "proposal" } & Proposal)
  | {
      type: "proposal_result";
      id: string;
      status: ProposalOutcome;
      target?: { type: string; id: string };
      error?: string | null;
    }
  | { type: "notice"; kind: string }
  | { type: "error"; code: string; message: string }
  | { type: "ended"; reason: string };

// ── Up: browser to server ───────────────────────────────────────────────────

export type ClientFrame =
  | { type: "text"; text: string }
  | { type: "context"; route: string; dialog_open: boolean }
  /** The read-back finished playing, or with the speaker off, was shown in full. */
  | { type: "readback_played"; proposal_id: string }
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
