/**
 * Fixed states for the gallery of the assistant's looks (`AgentGallery`).
 *
 * The reducer is pure, so every state the panel can be in is a list of frames handed to
 * it. Nothing here is a mock of the reducer: these are the frames the server sends, and
 * the states are whatever the real reducer makes of them.
 *
 * Development only. Nothing in the app imports this.
 */
import type { AgentConversationOut, AgentHistoryPage } from "@/api/types";
import { agentReducer, initialState, isLocked, type AgentState } from "./agentState";
import type { AgentContextValue } from "./AgentProvider";
import { createLevels } from "./levels";
import type { Proposal, ServerFrame } from "./protocol";

const noop = () => {};

export function stateFrom(frames: ServerFrame[], microphone = true): AgentState {
  const started = agentReducer(initialState, { type: "start", microphone, speakerOn: true });
  return frames.reduce((state, frame) => agentReducer(state, { type: "frame", frame }), started);
}

export const READY: ServerFrame = {
  type: "ready",
  conversation_id: "c-gallery",
  limits: { max_session_seconds: 1800, remaining_seconds: 480 },
};

const inTwoMinutes = () => new Date(Date.now() + 100_000).toISOString();
const inTenMinutes = () => new Date(Date.now() + 600_000).toISOString();

export const MEETING: Proposal = {
  id: "p-meeting",
  kind: "meeting.create",
  summary:
    "I am about to create the meeting Site visit with Maria Lopez on Thursday, 15 October 2026 at 2:00 PM, for 45 minutes. Maria Lopez and j.smith@acme.com will be emailed an invite. Press Approve when you are ready.",
  payload: {
    title: "Site visit with Maria Lopez",
    location: "",
    description: "",
    start_time: "2026-10-15T14:00:00",
    end_time: "2026-10-15T14:45:00",
  },
  labels: {
    when: "Thu 15 Oct 2026, 2:00–2:45 PM",
    attendees: [{ label: "Maria Lopez" }, { label: "j.smith@acme.com", note: "outside guest" }],
  },
  warnings: ["j.smith@acme.com is outside the team", "45 minutes is from memory"],
  approval: "click",
  expires_at: inTenMinutes(),
};

/** The same meeting once the server sends the facts and the reason itself. */
export const MEETING_WITH_FACTS: Proposal = {
  ...MEETING,
  id: "p-meeting-facts",
  approval_reason: "sends_email",
  labels: {
    ...MEETING.labels,
    facts: [
      { label: "When", value: "Thu 15 Oct 2026, 2:00–2:45 PM", source: "memory" },
      { label: "Where", value: "1420 Oak Street" },
      { label: "Who", value: "Maria Lopez\nj.smith@acme.com" },
    ],
  },
};

export const VOICE_MEETING: Proposal = {
  ...MEETING,
  id: "p-voice",
  summary:
    "I am about to create the meeting Site visit on Thursday, 15 October 2026 at 2:00 PM, for 45 minutes. Nobody will be emailed.",
  payload: { ...MEETING.payload, title: "Site visit" },
  labels: {
    when: "Thu 15 Oct 2026, 2:00–2:45 PM",
    confirm: { line: "Site visit, Thursday 15 October at 2:00 PM" },
  },
  warnings: [],
  approval: "voice_or_click",
};

export const DETAILS: Proposal = {
  id: "p-details",
  kind: "supplement.update_details",
  summary:
    "I am about to change the details of the supplement Hendricks roof, claim ID CLM-4471: the client from Acme Insurance to Beacon Mutual.",
  payload: { supplement_id: "est-1" },
  labels: {
    name: "Hendricks roof · CLM-4471",
    changes: [
      { field: "client_name", label: "Client", old: "Acme Insurance", new: "Beacon Mutual" },
      { field: "pm_name", label: "Project manager", old: "", new: "Dana Reyes" },
    ],
  },
  warnings: [],
  approval: "voice_or_click",
  expires_at: inTenMinutes(),
};

export const LOCK: Proposal = {
  id: "p-lock",
  kind: "supplement.transition",
  summary: "I am about to lock the supplement Hendricks roof, claim ID CLM-4471.",
  payload: { supplement_id: "est-1", action: "lock" },
  labels: { name: "Hendricks roof · CLM-4471", action: "lock", action_label: "Lock" },
  warnings: [],
  approval: "click",
  approval_reason: "changes_access",
  expires_at: inTenMinutes(),
};

export const SUBMIT: Proposal = {
  id: "p-submit",
  kind: "supplement.submit",
  summary:
    "I am about to send the supplement Hendricks roof, claim ID CLM-4471, for review. The total is $4,210.00. Dana Reyes will be emailed.",
  payload: { supplement_id: "est-1" },
  labels: {
    name: "Hendricks roof · CLM-4471",
    total: "$4,210.00",
    reviewer: { name: "Dana Reyes", email: "dana@buildco.example" },
  },
  warnings: ["This supplement has no photos"],
  approval: "click",
  approval_reason: "readback_unverified",
  expires_at: inTwoMinutes(),
};

export const MEMORY: Proposal = {
  id: "p-memory",
  kind: "memory.change",
  summary: "I am about to change what I remember from Prefers Sam to Prefers Samantha.",
  payload: { memory_id: "m-1" },
  labels: { old: "Prefers to be called Sam", new: "Prefers to be called Samantha" },
  warnings: [],
  approval: "voice_or_click",
  expires_at: inTenMinutes(),
};

/** A short conversation, as frames. */
export const TALK: ServerFrame[] = [
  READY,
  { type: "transcript", role: "user", text: "Can you set up a site visit with Maria on Thursday at two?", final: true },
  {
    type: "transcript",
    role: "assistant",
    text: "Sure. How long should it be, and should I invite anyone else?",
    final: true,
  },
  { type: "turn_complete", spoke: true, readback_for: null },
  { type: "transcript", role: "user", text: "The usual, and add j.smith@acme.com.", final: true },
];

export const WORKING: ServerFrame[] = [
  ...TALK,
  { type: "mode", mode: "working" },
  { type: "step", id: "s1", label: "Open the calendar", status: "done" },
  { type: "step", id: "s2", label: "Fill in the meeting", status: "active" },
];

export function proposing(proposal: Proposal, readBack = true): ServerFrame[] {
  return [
    ...TALK,
    { type: "mode", mode: "working" },
    { type: "step", id: "s1", label: "Open the calendar", status: "done" },
    { type: "step", id: "s2", label: "Fill in the meeting", status: "done" },
    { type: "step", id: "s3", label: "Waiting for your approval", status: "active" },
    { type: "ui", directive_id: "d-1", action: "stage", proposal },
    { type: "proposal", ...proposal },
    ...(readBack
      ? ([
          { type: "transcript", role: "assistant", text: proposal.summary, final: true },
          { type: "turn_complete", spoke: true, readback_for: proposal.id },
        ] satisfies ServerFrame[])
      : []),
  ];
}

export const SAVED: ServerFrame[] = [
  ...proposing(MEETING),
  { type: "proposal_result", id: MEETING.id, status: "committed", target: { type: "meeting", id: "m-1" } },
  { type: "ui", directive_id: "d-2", action: "unstage" },
  { type: "mode", mode: "conversing" },
  { type: "transcript", role: "assistant", text: "It is saved, and the invites have gone out.", final: true },
  { type: "turn_complete", spoke: true, readback_for: null },
];

/** One conversation that left every kind of receipt. */
export const EVERY_RECEIPT: ServerFrame[] = [
  READY,
  { type: "transcript", role: "user", text: "Show me every outcome.", final: true },
  ...(["committed", "failed", "cancelled", "handed_over", "expired"] as const).flatMap(
    (status, index): ServerFrame[] => {
      const proposal = { ...MEETING, id: `p-${status}` };
      return [
        { type: "proposal", ...proposal },
        {
          type: "proposal_result",
          id: proposal.id,
          status,
          ...(status === "committed" ? { target: { type: "meeting", id: `m-${index}` } } : {}),
          ...(status === "failed" ? { error: "That time is in the past." } : {}),
        },
      ];
    },
  ),
  { type: "ui", directive_id: "d-nav", action: "navigate", to: "/calendar" },
  { type: "memory", event: "remembered", memory: { id: "m-1", category: "work_habit", content: "Site visits are usually 45 minutes" } },
];

/** The assistant's context, drawn from a fixed state with nothing behind it. */
export function previewOf(
  state: AgentState,
  over: Partial<AgentContextValue> = {},
): AgentContextValue {
  return {
    available: true,
    remainingToday: state.phase === "idle" || state.phase === "ended" ? 480 : state.remainingSeconds,
    dailyLimit: 600,
    resetsAt: "2026-10-12T00:00:00Z",
    state,
    locked: isLocked(state),
    panelOpen: true,
    phone: false,
    phoneView: "full",
    setPhoneView: noop,
    levels: createLevels(),
    openPanel: noop,
    closePanel: noop,
    startVoice: noop,
    sendText: noop,
    approve: noop,
    reject: noop,
    stop: noop,
    resume: noop,
    end: noop,
    setMuted: noop,
    setSpeaker: noop,
    forget: async () => {},
    confirmStaged: noop,
    takeHandover: noop,
    reportContext: noop,
    viewRecord: noop,
    viewSelection: noop,
    registerEditor: noop,
    ...over,
  };
}

const today = new Date();
const at = (daysAgo: number, hour: number, minute: number) =>
  new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo, hour, minute).toISOString();

export const HISTORY: AgentHistoryPage = {
  total: 5,
  limit: 20,
  offset: 0,
  items: [
    { id: "c-1", status: "ended", title: "Set up a site visit with Maria on Thursday", started_at: at(0, 14, 14), ended_at: at(0, 14, 16), end_reason: "user_closed", duration_seconds: 78, action_count: 1, transcript_expired: false },
    { id: "c-2", status: "ended", title: "", started_at: at(0, 9, 2), ended_at: at(0, 9, 2), end_reason: "user_closed", duration_seconds: 0, action_count: 0, transcript_expired: false },
    { id: "c-3", status: "ended", title: "What is the total on the Hendricks roof?", started_at: at(1, 16, 40), ended_at: at(1, 16, 41), end_reason: "idle_timeout", duration_seconds: 31, action_count: 0, transcript_expired: false },
    { id: "c-4", status: "ended", title: "Archive the two Schuyler supplements", started_at: at(6, 11, 5), ended_at: at(6, 11, 9), end_reason: "user_closed", duration_seconds: 212, action_count: 2, transcript_expired: false },
    { id: "c-5", status: "ended", title: "", started_at: at(120, 10, 0), ended_at: at(120, 10, 3), end_reason: "user_closed", duration_seconds: 140, action_count: 1, transcript_expired: true },
  ],
};

export const PAST: AgentConversationOut = {
  id: "c-1",
  status: "ended",
  title: "Set up a site visit with Maria on Thursday",
  started_at: at(0, 14, 14),
  ended_at: at(0, 14, 16),
  end_reason: "user_closed",
  transcript_expired: false,
  messages: [
    { seq: 1, role: "user", source: "voice", text: "Set up a site visit with Maria on Thursday at two.", created_at: at(0, 14, 14) },
    { seq: 2, role: "assistant", source: "voice", text: "For 45 minutes, as usual?", created_at: at(0, 14, 14).replace(":00.000Z", ":10.000Z") },
    { seq: 3, role: "user", source: "voice", text: "Yes.", created_at: at(0, 14, 14).replace(":00.000Z", ":20.000Z") },
    { seq: 4, role: "assistant", source: "voice", text: "It is saved.", created_at: at(0, 14, 15) },
  ],
  actions: [
    {
      id: "a-1",
      kind: "meeting.create",
      status: "committed",
      summary: "Site visit with Maria Lopez on Thursday, 15 October 2026 at 2:00 PM, for 45 minutes.",
      approval_policy: "click",
      approved_via: "click",
      result: { type: "meeting", id: "m-1" },
      error: null,
      created_at: at(0, 14, 14).replace(":00.000Z", ":40.000Z"),
      resolved_at: at(0, 14, 15),
    },
  ],
};
