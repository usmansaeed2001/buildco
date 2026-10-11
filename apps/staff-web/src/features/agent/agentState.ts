/**
 * What the panel knows, as a reducer.
 *
 * Everything the server says arrives as a frame and is folded into this state by a pure
 * function. The provider owns the socket and the audio; nothing here touches either, so
 * every transition can be tested by handing it frames.
 */
import type {
  AgentMode,
  Proposal,
  ProposalOutcome,
  RememberedMemory,
  ServerFrame,
  Target,
} from "./protocol";

/**
 * `reconnecting` is a conversation whose connection dropped and is being restored. It
 * is still the same conversation: the transcript and any staged proposal stay put.
 */
export type Phase = "idle" | "connecting" | "live" | "reconnecting" | "ended";

export interface TranscriptLine {
  id: number;
  role: "user" | "assistant";
  text: string;
  /** False while the words are still arriving. */
  final: boolean;
  /** The proposal this turn read back, if it was a read-back. */
  readbackFor?: string;
  /** The user talked over it, so it stops where it was cut off. */
  cut?: boolean;
}

/**
 * One line of the conversation that nobody said: a page was opened, the microphone
 * paused, the connection came back. `after` is the transcript line it follows.
 */
export interface Mark {
  id: number;
  after: number;
  text: string;
}

/** Something the assistant has said it will remember, and where in the conversation. */
export type Remembered = RememberedMemory & { after: number };

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
  /** What a commit created or changed, so the panel can link to it. */
  target: Target | null;
  /** What kind of change it was, for the receipt's title. */
  kind: string | null;
  /** The record by name and, for a meeting, when: as the proposal gave them. */
  name: string | null;
  when: string | null;
  /** The transcript line it followed, which is where its receipt is shown. */
  after: number;
}

export interface AgentState {
  phase: Phase;
  mode: AgentMode;
  conversationId: string | null;
  /** Whether this conversation was started with the microphone. */
  microphone: boolean;
  muted: boolean;
  speakerOn: boolean;
  /**
   * Why the microphone is off although the conversation is live, if it is. `approval`:
   * nobody answered the read-back, and Tap to talk brings it back. `allowance`: the
   * day's time ran out with a proposal still waiting, and only the buttons work.
   */
  paused: "approval" | "allowance" | null;
  /** Seconds of today's allowance left when the conversation last heard. */
  remainingSeconds: number | null;
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
  /** What became of the last proposal, until the next one. What pages read. */
  lastResult: ProposalResult | null;
  /**
   * What became of every proposal in this conversation, in order. Each is a receipt left
   * in the transcript where it happened, and unlike `lastResult` none is ever replaced.
   */
  receipts: ProposalResult[];
  /** The proposal whose read-back has finished playing, so a spoken yes can now count. */
  readbackPlayed: string | null;
  /** Counts commits, so a page can notice one even when the same record is hit twice. */
  commits: number;
  /** What the assistant has just said it will remember, newest last. */
  remembered: Remembered[];
  /** The lines of the conversation that nobody said, in order. */
  marks: Mark[];
  /** Seconds this conversation's audio has been live. */
  elapsed: number;
  /** One line about time running short or the conversation going quiet. */
  notice: string | null;
  problem: string | null;
  endedReason: string | null;
  endedDetail: string | null;
}

export const initialState: AgentState = {
  phase: "idle",
  mode: "conversing",
  conversationId: null,
  microphone: false,
  muted: false,
  speakerOn: true,
  paused: null,
  remainingSeconds: null,
  transcript: [],
  steps: [],
  proposal: null,
  staged: null,
  handover: null,
  lastResult: null,
  receipts: [],
  readbackPlayed: null,
  commits: 0,
  remembered: [],
  marks: [],
  elapsed: 0,
  notice: null,
  problem: null,
  endedReason: null,
  endedDetail: null,
};

export type AgentAction =
  | { type: "start"; microphone: boolean; speakerOn: boolean }
  | { type: "frame"; frame: ServerFrame }
  /** A message the user typed, shown at once without waiting for the server. */
  | { type: "typed"; text: string }
  | { type: "failed"; message: string }
  /** The socket closed. `message` only when it closed without the server saying why. */
  | { type: "closed"; message: string | null }
  /** The socket went away unannounced and the browser is trying to get it back. */
  | { type: "reconnecting" }
  | { type: "mute"; muted: boolean }
  | { type: "speaker"; on: boolean }
  | { type: "handover_taken" }
  /** A second went by with the audio live. */
  | { type: "tick" }
  /** The server was told this proposal's read-back has been heard, or shown, in full. */
  | { type: "readback_played"; id: string }
  /** A memory announced in this conversation was undone. */
  | { type: "forgotten"; id: string }
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

/** The id of the newest transcript line: where whatever happens next belongs. */
function latest(state: AgentState): number {
  return state.transcript[state.transcript.length - 1]?.id ?? 0;
}

function mark(state: AgentState, text: string): Mark[] {
  const last = state.marks[state.marks.length - 1];
  return [...state.marks, { id: (last?.id ?? 0) + 1, after: latest(state), text }];
}

/** The page a route is, as the navigation names it. */
function pageName(to: string): string {
  const path = to.split("?")[0] ?? "";
  if (path.startsWith("/estimates/")) return "the supplement";
  if (path.startsWith("/estimates")) return "Supplements";
  if (path.startsWith("/projects/")) return "the project";
  if (path.startsWith("/projects")) return "Projects";
  if (path.startsWith("/calendar")) return "Calendar";
  if (path.startsWith("/team")) return "Team";
  if (path.startsWith("/profile")) return "Profile";
  if (path.startsWith("/settings")) return "Settings";
  return "the page";
}

function words(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

const NOTICES: Record<string, string> = {
  idle_warning: "Still there? The conversation ends soon if nothing is said.",
  time_limit_warning: "This conversation reaches its 30-minute limit in about two minutes.",
  allowance_low: "About a minute of today's time with the assistant is left.",
  allowance_exhausted: "Today's time with the assistant has been used.",
  model_reconnected: "The assistant lost its place for a moment and has picked it up again.",
};

function onFrame(state: AgentState, frame: ServerFrame): AgentState {
  switch (frame.type) {
    case "ready":
      return {
        ...state,
        phase: "live",
        problem: null,
        // A socket that picked a conversation up again says afresh whether it is
        // working. Until it does, nothing is: a lock left over from before the drop
        // would otherwise outlive the proposal it was for.
        mode: frame.resumed ? "conversing" : state.mode,
        conversationId: frame.conversation_id,
        remainingSeconds: frame.limits.remaining_seconds ?? state.remainingSeconds,
        // A new socket starts with the microphone live, whatever the old one was doing.
        paused: null,
        marks: frame.resumed ? mark(state, "Reconnected") : state.marks,
      };

    case "transcript":
      return {
        ...state,
        notice: frame.role === "user" ? null : state.notice,
        transcript: addLine(state.transcript, frame.role, frame.text, frame.final),
      };

    case "interrupted": {
      const last = state.transcript[state.transcript.length - 1];
      if (!last || last.final) return state;
      return {
        ...state,
        transcript: [...state.transcript.slice(0, -1), { ...last, final: true, cut: true }],
      };
    }

    case "turn_complete": {
      const transcript = settle(state.transcript);
      const last = transcript[transcript.length - 1];
      if (!frame.readback_for || last?.role !== "assistant") return { ...state, transcript };
      return {
        ...state,
        transcript: [...transcript.slice(0, -1), { ...last, readbackFor: frame.readback_for }],
      };
    }

    case "mode":
      // A new piece of work starts its step list afresh.
      return {
        ...state,
        mode: frame.mode,
        steps: frame.mode === "working" && state.mode !== "working" ? [] : state.steps,
      };

    case "audio": {
      const paused = frame.state === "paused" ? (frame.reason ?? "approval") : null;
      return {
        ...state,
        paused,
        marks:
          paused === "approval" && state.paused !== "approval"
            ? mark(state, "Microphone paused")
            : state.marks,
      };
    }

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
      if (frame.action === "navigate") {
        return { ...state, marks: mark(state, `Opened ${pageName(frame.to)}`) };
      }
      return state;

    case "proposal": {
      const { type: _type, ...proposal } = frame;
      return {
        ...state,
        proposal,
        // Sent again when the read-back check turns a voice approval into a click, and
        // after a reconnect. The staged screen follows the card.
        staged: state.staged?.id === proposal.id || !state.staged ? proposal : state.staged,
        lastResult: null,
      };
    }

    case "proposal_result": {
      const about = state.proposal?.id === frame.id ? state.proposal : state.staged;
      const result: ProposalResult = {
        id: frame.id,
        status: frame.status,
        error: frame.error ?? null,
        summary: about?.id === frame.id ? about.summary : "",
        target: frame.target ?? null,
        kind: about?.id === frame.id ? about.kind : null,
        name:
          about?.id === frame.id
            ? (words(about.labels.name) ??
              words(about.payload["title"]) ??
              words(about.payload["project_name"]))
            : null,
        when: about?.id === frame.id ? words(about.labels.when) : null,
        after: latest(state),
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
        receipts: frame.status === "superseded" ? state.receipts : [...state.receipts, result],
        commits: frame.status === "committed" ? state.commits + 1 : state.commits,
      };
    }

    case "memory":
      return {
        ...state,
        remembered: [...state.remembered, { ...frame.memory, after: latest(state) }],
      };

    case "notice": {
      const text = NOTICES[frame.kind];
      return {
        ...state,
        notice: text ?? state.notice,
        remainingSeconds:
          frame.kind === "allowance_low" && frame.seconds !== undefined
            ? frame.seconds
            : frame.kind === "allowance_exhausted"
              ? 0
              : state.remainingSeconds,
      };
    }

    case "error":
      return { ...state, problem: frame.message };

    case "ended":
      return {
        ...state,
        phase: "ended",
        mode: "conversing",
        paused: null,
        endedReason: frame.reason,
        endedDetail: frame.detail ?? null,
        proposal: null,
        staged: null,
        transcript: settle(state.transcript),
      };
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
      return {
        ...state,
        notice: null,
        transcript: addLine(settle(state.transcript), "user", action.text, true),
      };
    case "failed":
      return {
        ...state,
        phase: "ended",
        mode: "conversing",
        paused: null,
        problem: action.message,
        staged: null,
        proposal: null,
      };
    case "reconnecting":
      // Still the same conversation. The app is unlocked meanwhile: nothing can be
      // staged or approved over a dead connection, and a lock nobody can lift is the
      // worst thing this could leave behind.
      if (state.phase !== "live") return state;
      return { ...state, phase: "reconnecting", transcript: settle(state.transcript) };
    case "closed":
      // The server normally says why first, with an `ended` frame. If the socket just
      // went away, say that, and never leave the app locked behind a dead connection.
      if (state.phase === "ended") return state;
      return {
        ...state,
        phase: "ended",
        mode: "conversing",
        paused: null,
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
    case "tick":
      if (state.phase !== "live" || state.paused) return state;
      return {
        ...state,
        elapsed: state.elapsed + 1,
        remainingSeconds:
          state.remainingSeconds === null ? null : Math.max(0, state.remainingSeconds - 1),
      };
    case "readback_played":
      return { ...state, readbackPlayed: action.id };
    case "forgotten":
      return { ...state, remembered: state.remembered.filter((memory) => memory.id !== action.id) };
    case "reset":
      return { ...initialState, speakerOn: state.speakerOn };
  }
}

/** Whether the app beside the panel should be locked. Never behind a dead connection. */
export function isLocked(state: AgentState): boolean {
  return state.mode === "working" && state.phase === "live";
}

/** Why a conversation ended, in words. */
export function describeEnding(reason: string | null, detail: string | null = null): string {
  if (detail === "allowance") {
    return "Today's time with the assistant has been used, so the conversation ended.";
  }
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

/** "8 min", "1 min 20 s", "45 s": how much time is left, as a person would say it. */
export function describeSeconds(seconds: number): string {
  if (seconds >= 120) return `${Math.floor(seconds / 60)} min`;
  if (seconds >= 60) return `1 min ${seconds - 60} s`;
  return `${Math.max(0, seconds)} s`;
}
