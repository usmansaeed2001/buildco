/**
 * What the panel knows, as a reducer.
 *
 * Everything the server says arrives as a frame and is folded into this state by a pure
 * function. The provider owns the socket and the audio; nothing here touches either, so
 * every transition can be tested by handing it frames.
 */
import type { AgentMode, Proposal, ProposalOutcome, ServerFrame } from "./protocol";

export type Phase = "idle" | "connecting" | "live" | "ended";

export interface TranscriptLine {
  id: number;
  role: "user" | "assistant";
  text: string;
  /** False while the words are still arriving. */
  final: boolean;
}

export interface Step {
  id: string;
  label: string;
  status: "active" | "done";
}

export interface ProposalResult {
  id: string;
  status: ProposalOutcome;
  error: string | null;
  /** The summary of the proposal this was the outcome of, for the panel to show. */
  summary: string;
}

export interface AgentState {
  phase: Phase;
  mode: AgentMode;
  /** Whether this conversation was started with the microphone. */
  microphone: boolean;
  muted: boolean;
  speakerOn: boolean;
  transcript: TranscriptLine[];
  steps: Step[];
  /** The approval card: what is waiting for a yes or a no. */
  proposal: Proposal | null;
  /** What a page should be showing as a staged form right now. */
  staged: Proposal | null;
  /**
   * A proposal the user took over with Stop. Its page opens it as an ordinary editable
   * form and then clears this.
   */
  handover: Proposal | null;
  /** What became of the last proposal. Shown until the next one. */
  lastResult: ProposalResult | null;
  problem: string | null;
  endedReason: string | null;
}

export const initialState: AgentState = {
  phase: "idle",
  mode: "conversing",
  microphone: false,
  muted: false,
  speakerOn: true,
  transcript: [],
  steps: [],
  proposal: null,
  staged: null,
  handover: null,
  lastResult: null,
  problem: null,
  endedReason: null,
};

export type AgentAction =
  | { type: "start"; microphone: boolean; speakerOn: boolean }
  | { type: "frame"; frame: ServerFrame }
  /** A message the user typed, shown at once without waiting for the server. */
  | { type: "typed"; text: string }
  | { type: "failed"; message: string }
  /** The socket closed. `message` only when it closed without the server saying why. */
  | { type: "closed"; message: string | null }
  | { type: "mute"; muted: boolean }
  | { type: "speaker"; on: boolean }
  | { type: "handover_taken" }
  | { type: "reset" };

function addLine(
  lines: TranscriptLine[],
  role: TranscriptLine["role"],
  text: string,
  final: boolean,
): TranscriptLine[] {
  const last = lines[lines.length - 1];
  // Fragments extend the line being spoken; the final frame carries the whole utterance
  // and replaces it.
  if (last && last.role === role && !last.final) {
    const updated = { ...last, text: final ? text : last.text + text, final };
    return [...lines.slice(0, -1), updated];
  }
  return [...lines, { id: (last?.id ?? 0) + 1, role, text, final }];
}

/** Close any line still being spoken. Used when the speaker is cut off. */
function settle(lines: TranscriptLine[]): TranscriptLine[] {
  const last = lines[lines.length - 1];
  return last && !last.final ? [...lines.slice(0, -1), { ...last, final: true }] : lines;
}

function onFrame(state: AgentState, frame: ServerFrame): AgentState {
  switch (frame.type) {
    case "ready":
      return { ...state, phase: "live", problem: null };

    case "transcript":
      return {
        ...state,
        transcript: addLine(state.transcript, frame.role, frame.text, frame.final),
      };

    case "interrupted":
    case "turn_complete":
      return { ...state, transcript: settle(state.transcript) };

    case "mode":
      // A new piece of work starts its step list afresh.
      return {
        ...state,
        mode: frame.mode,
        steps: frame.mode === "working" && state.mode !== "working" ? [] : state.steps,
      };

    case "step": {
      const step = { id: frame.id, label: frame.label, status: frame.status };
      const known = state.steps.some((existing) => existing.id === frame.id);
      return {
        ...state,
        steps: known
          ? state.steps.map((existing) => (existing.id === frame.id ? step : existing))
          : [...state.steps, step],
      };
    }

    case "ui":
      if (frame.action === "stage") return { ...state, staged: frame.proposal };
      if (frame.action === "unstage") return { ...state, staged: null };
      return state;

    case "proposal": {
      const { type: _type, ...proposal } = frame;
      return { ...state, proposal, lastResult: null };
    }

    case "proposal_result": {
      const about = state.proposal?.id === frame.id ? state.proposal : state.staged;
      const result: ProposalResult = {
        id: frame.id,
        status: frame.status,
        error: frame.error ?? null,
        summary: about?.id === frame.id ? about.summary : "",
      };
      const mine = (proposal: Proposal | null) => (proposal?.id === frame.id ? null : proposal);
      return {
        ...state,
        proposal: mine(state.proposal),
        // A superseded proposal's replacement may already be staged; leave that alone.
        staged: mine(state.staged),
        handover:
          frame.status === "handed_over" && state.staged?.id === frame.id
            ? state.staged
            : state.handover,
        // Being replaced by a correction is not an outcome worth a line of its own.
        lastResult: frame.status === "superseded" ? state.lastResult : result,
      };
    }

    case "error":
      return { ...state, problem: frame.message };

    case "ended":
      return {
        ...state,
        phase: "ended",
        mode: "conversing",
        endedReason: frame.reason,
        proposal: null,
        staged: null,
        transcript: settle(state.transcript),
      };

    case "notice":
      return state;
  }
}

export function agentReducer(state: AgentState, action: AgentAction): AgentState {
  switch (action.type) {
    case "start":
      return {
        ...initialState,
        phase: "connecting",
        microphone: action.microphone,
        speakerOn: action.speakerOn,
      };
    case "frame":
      return onFrame(state, action.frame);
    case "typed":
      return { ...state, transcript: addLine(settle(state.transcript), "user", action.text, true) };
    case "failed":
      return { ...state, phase: "ended", mode: "conversing", problem: action.message, staged: null, proposal: null };
    case "closed":
      // The server normally says why first, with an `ended` frame. If the socket just
      // went away, say that, and never leave the app locked behind a dead connection.
      if (state.phase === "ended") return state;
      return {
        ...state,
        phase: "ended",
        mode: "conversing",
        endedReason: state.endedReason ?? "disconnected",
        problem: action.message ?? state.problem,
        proposal: null,
        staged: null,
        transcript: settle(state.transcript),
      };
    case "mute":
      return { ...state, muted: action.muted };
    case "speaker":
      return { ...state, speakerOn: action.on };
    case "handover_taken":
      return { ...state, handover: null };
    case "reset":
      return { ...initialState, speakerOn: state.speakerOn };
  }
}

/** Why a conversation ended, in words. */
export function describeEnding(reason: string | null): string {
  switch (reason) {
    case "user_closed":
      return "You ended the conversation.";
    case "idle_timeout":
      return "The conversation ended because it had gone quiet.";
    case "time_limit":
      return "The conversation reached its time limit.";
    case "superseded":
      return "The conversation ended because you started another one.";
    case "disconnected":
      return "The connection was lost.";
    default:
      return "The conversation ended.";
  }
}
