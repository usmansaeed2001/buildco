/**
 * The panel's state, driven by frames alone.
 *
 * No socket and no audio: the reducer is the part of the assistant that decides what the
 * user is shown, and it is pure, so every frame the server can send is exercised here.
 */
import { describe, expect, it } from "vitest";
import {
  agentReducer,
  describeEnding,
  describeSeconds,
  initialState,
  isLocked,
  type AgentState,
} from "./agentState";
import type { Proposal, ServerFrame } from "./protocol";

const PROPOSAL: Proposal = {
  id: "p-1",
  kind: "meeting.create",
  summary: "I am about to create the meeting Hendricks walkthrough.",
  payload: { title: "Hendricks walkthrough" },
  labels: { attendees: [{ label: "Sam Member" }] },
  warnings: [],
  approval: "voice_or_click",
  expires_at: "2026-10-14T22:00:00Z",
};

function after(frames: ServerFrame[], from: AgentState = live()): AgentState {
  return frames.reduce((state, frame) => agentReducer(state, { type: "frame", frame }), from);
}

function live(): AgentState {
  const started = agentReducer(initialState, { type: "start", microphone: true, speakerOn: true });
  return after(
    [{ type: "ready", conversation_id: "c-1", limits: { max_session_seconds: 1800 } }],
    started,
  );
}

const staged = () =>
  after([
    { type: "mode", mode: "working" },
    { type: "ui", directive_id: "d-1", action: "stage", proposal: PROPOSAL },
    { type: "proposal", ...PROPOSAL },
  ]);

describe("agentReducer", () => {
  it("goes from idle to connecting to live", () => {
    const connecting = agentReducer(initialState, {
      type: "start",
      microphone: false,
      speakerOn: true,
    });

    expect(connecting.phase).toBe("connecting");
    expect(live().phase).toBe("live");
  });

  describe("the transcript", () => {
    it("grows a line as its words arrive and replaces it with the finished utterance", () => {
      const state = after([
        { type: "transcript", role: "assistant", text: "I am about ", final: false },
        { type: "transcript", role: "assistant", text: "to create", final: false },
        { type: "transcript", role: "assistant", text: "I am about to create it.", final: true },
      ]);

      expect(state.transcript).toEqual([
        { id: 1, role: "assistant", text: "I am about to create it.", final: true },
      ]);
    });

    it("keeps the two speakers on separate lines", () => {
      const state = after([
        { type: "transcript", role: "user", text: "Book a meeting.", final: true },
        { type: "transcript", role: "assistant", text: "When?", final: true },
      ]);

      expect(state.transcript.map((line) => line.role)).toEqual(["user", "assistant"]);
    });

    it("closes a line that was cut off, so the next one does not join onto it", () => {
      const state = after([
        { type: "transcript", role: "assistant", text: "I am about to", final: false },
        { type: "interrupted" },
        { type: "transcript", role: "assistant", text: "Sorry, go on.", final: false },
      ]);

      expect(state.transcript.map((line) => line.text)).toEqual([
        "I am about to",
        "Sorry, go on.",
      ]);
    });

    it("shows a typed message at once", () => {
      const state = agentReducer(live(), { type: "typed", text: "make it 4pm" });

      expect(state.transcript[0]).toMatchObject({ role: "user", text: "make it 4pm", final: true });
    });
  });

  describe("a proposal", () => {
    it("is staged on the page and shown on the approval card", () => {
      const state = staged();

      expect(state.mode).toBe("working");
      expect(state.staged).toEqual(PROPOSAL);
      expect(state.proposal).toEqual(PROPOSAL);
    });

    it("clears the card and unlocks when it is committed", () => {
      const state = after(
        [
          { type: "proposal_result", id: "p-1", status: "committed", target: { type: "meeting", id: "m-1" } },
          { type: "ui", directive_id: "d-2", action: "unstage" },
          { type: "mode", mode: "conversing" },
        ],
        staged(),
      );

      expect(state.proposal).toBeNull();
      expect(state.staged).toBeNull();
      expect(state.mode).toBe("conversing");
      expect(state.lastResult).toMatchObject({ status: "committed", summary: PROPOSAL.summary });
    });

    it("keeps the reason when a commit fails", () => {
      const state = after(
        [{ type: "proposal_result", id: "p-1", status: "failed", error: "It had expired." }],
        staged(),
      );

      expect(state.lastResult).toMatchObject({ status: "failed", error: "It had expired." });
      expect(state.proposal).toBeNull();
    });

    it("hands the staged form over when the user stops", () => {
      const state = after(
        [
          { type: "proposal_result", id: "p-1", status: "handed_over" },
          { type: "mode", mode: "conversing" },
        ],
        staged(),
      );

      expect(state.handover).toEqual(PROPOSAL);
      expect(state.staged).toBeNull();
      expect(agentReducer(state, { type: "handover_taken" }).handover).toBeNull();
    });

    it("is replaced by a correction without the old one's outcome being announced", () => {
      const corrected = { ...PROPOSAL, id: "p-2", summary: "At four o'clock instead." };
      const state = after(
        [
          { type: "proposal_result", id: "p-1", status: "superseded" },
          { type: "ui", directive_id: "d-3", action: "stage", proposal: corrected },
          { type: "proposal", ...corrected },
        ],
        staged(),
      );

      expect(state.proposal?.id).toBe("p-2");
      expect(state.staged?.id).toBe("p-2");
      expect(state.lastResult).toBeNull();
    });

    it("does not let a late result for an old proposal clear the current one", () => {
      const state = after(
        [{ type: "proposal_result", id: "p-0", status: "cancelled" }],
        staged(),
      );

      expect(state.proposal?.id).toBe("p-1");
      expect(state.staged?.id).toBe("p-1");
    });
  });

  describe("the step list", () => {
    it("adds steps and updates them in place", () => {
      const state = after([
        { type: "mode", mode: "working" },
        { type: "step", id: "stage", label: "Fill in the meeting", status: "active" },
        { type: "step", id: "stage", label: "Fill in the meeting", status: "done" },
        { type: "step", id: "approval", label: "Waiting for your approval", status: "active" },
      ]);

      expect(state.steps).toEqual([
        { id: "stage", label: "Fill in the meeting", status: "done" },
        { id: "approval", label: "Waiting for your approval", status: "active" },
      ]);
    });

    it("starts afresh for the next piece of work", () => {
      const state = after([
        { type: "mode", mode: "working" },
        { type: "step", id: "stage", label: "Fill in the meeting", status: "done" },
        { type: "mode", mode: "conversing" },
        { type: "mode", mode: "working" },
      ]);

      expect(state.steps).toEqual([]);
    });
  });

  describe("ending", () => {
    it("records why, and drops anything that was waiting", () => {
      const state = after([{ type: "ended", reason: "time_limit" }], staged());

      expect(state.phase).toBe("ended");
      expect(state.endedReason).toBe("time_limit");
      expect(state.proposal).toBeNull();
      expect(state.staged).toBeNull();
    });

    it("never leaves the app locked behind a connection that just went away", () => {
      const state = agentReducer(staged(), { type: "closed", message: null });

      expect(state.phase).toBe("ended");
      expect(state.mode).toBe("conversing");
      expect(state.endedReason).toBe("disconnected");
    });

    it("keeps the server's reason when the socket closes after saying why", () => {
      const ended = after([{ type: "ended", reason: "user_closed" }]);

      expect(agentReducer(ended, { type: "closed", message: null }).endedReason).toBe("user_closed");
    });

    it("says what went wrong when it could not start", () => {
      const state = agentReducer(initialState, { type: "failed", message: "The microphone is blocked." });

      expect(state.phase).toBe("ended");
      expect(state.problem).toBe("The microphone is blocked.");
    });

    it("keeps the speaker preference across a reset", () => {
      const quiet = agentReducer(live(), { type: "speaker", on: false });

      expect(agentReducer(quiet, { type: "reset" })).toMatchObject({ phase: "idle", speakerOn: false });
    });
  });

  it("shows an error without ending the conversation", () => {
    const state = after([{ type: "error", code: "x", message: "Something went wrong." }]);

    expect(state.problem).toBe("Something went wrong.");
    expect(state.phase).toBe("live");
  });

  it.each([
    ["user_closed", "You ended the conversation."],
    ["time_limit", "The conversation reached its time limit."],
    ["disconnected", "The connection was lost."],
    ["something_new", "The conversation ended."],
  ])("describes an ending of %s", (reason, words) => {
    expect(describeEnding(reason)).toBe(words);
  });
});

describe("the rest of what the server can say", () => {
  it("keeps what is left of today, and counts it down while the audio is live", () => {
    const started = after([
      {
        type: "ready",
        conversation_id: "c-1",
        limits: { max_session_seconds: 1800, remaining_seconds: 90 },
      },
    ]);

    const later = agentReducer(agentReducer(started, { type: "tick" }), { type: "tick" });

    expect(started.remainingSeconds).toBe(90);
    expect(later.remainingSeconds).toBe(88);
  });

  it("does not count down while paused, and never below nothing", () => {
    const paused = after([
      { type: "ready", conversation_id: "c-1", limits: { max_session_seconds: 1800, remaining_seconds: 1 } },
      { type: "audio", state: "paused", reason: "approval" },
    ]);
    const resumed = after([{ type: "audio", state: "live" }], paused);

    expect(agentReducer(paused, { type: "tick" }).remainingSeconds).toBe(1);
    expect(agentReducer(agentReducer(resumed, { type: "tick" }), { type: "tick" }).remainingSeconds).toBe(0);
  });

  it("records why the microphone is off, and that it is back", () => {
    const waiting = after([{ type: "audio", state: "paused", reason: "approval" }]);
    const spent = after([{ type: "audio", state: "paused", reason: "allowance" }]);

    expect(waiting.paused).toBe("approval");
    expect(spent.paused).toBe("allowance");
    expect(after([{ type: "audio", state: "live" }], waiting).paused).toBeNull();
  });

  it("puts a notice in words, and drops it when the user speaks", () => {
    const warned = after([{ type: "notice", kind: "idle_warning" }]);

    expect(warned.notice).toMatch(/Still there/);
    expect(
      after([{ type: "transcript", role: "user", text: "Yes.", final: true }], warned).notice,
    ).toBeNull();
    expect(after([{ type: "notice", kind: "something_new" }], warned).notice).toMatch(/Still there/);
  });

  it("takes the time left from a low-allowance notice", () => {
    const low = after([{ type: "notice", kind: "allowance_low", seconds: 58 }]);

    expect(low.remainingSeconds).toBe(58);
    expect(after([{ type: "notice", kind: "allowance_exhausted" }], low).remainingSeconds).toBe(0);
  });

  it("lists what was remembered, and drops one that is undone", () => {
    const remembered = after([
      { type: "memory", event: "remembered", memory: { id: "m-1", category: "identity", content: "Sam" } },
      { type: "memory", event: "remembered", memory: { id: "m-2", category: "preference", content: "Short" } },
    ]);

    expect(remembered.remembered.map((memory) => memory.id)).toEqual(["m-1", "m-2"]);
    expect(
      agentReducer(remembered, { type: "forgotten", id: "m-1" }).remembered.map((m) => m.id),
    ).toEqual(["m-2"]);
  });

  it("counts commits and keeps what each one saved", () => {
    const saved = after(
      [
        {
          type: "proposal_result",
          id: "p-1",
          status: "committed",
          target: { type: "meeting", id: "m-9" },
        },
      ],
      staged(),
    );

    expect(saved.commits).toBe(1);
    expect(saved.lastResult).toMatchObject({ status: "committed", target: { type: "meeting", id: "m-9" } });
    expect(after([{ type: "proposal_result", id: "p-x", status: "cancelled" }], saved).commits).toBe(1);
  });

  it("follows the card when the server sends it again as click-only", () => {
    const downgraded = after([{ type: "proposal", ...PROPOSAL, approval: "click" }], staged());

    expect(downgraded.proposal?.approval).toBe("click");
    expect(downgraded.staged?.approval).toBe("click");
  });

  it("keeps the detail of why it ended", () => {
    const ended = after([{ type: "ended", reason: "time_limit", detail: "allowance" }]);

    expect(describeEnding(ended.endedReason, ended.endedDetail)).toMatch(/has been used/);
    expect(describeEnding("time_limit")).toBe("The conversation reached its time limit.");
  });
});

describe("a dropped connection", () => {
  it("keeps the conversation, the transcript and what was staged, and unlocks the app", () => {
    const talking = after(
      [{ type: "transcript", role: "assistant", text: "I am about to", final: false }],
      staged(),
    );
    expect(isLocked(talking)).toBe(true);

    const dropped = agentReducer(talking, { type: "reconnecting" });

    expect(dropped.phase).toBe("reconnecting");
    expect(dropped.proposal?.id).toBe("p-1");
    expect(dropped.staged?.id).toBe("p-1");
    expect(dropped.transcript.at(-1)?.final).toBe(true);
    // The mode is still "working". The lock is not on, because nothing can be approved
    // or stopped over a dead connection.
    expect(isLocked(dropped)).toBe(false);
  });

  it("is locked again only if the server says it is still working", () => {
    const dropped = agentReducer(staged(), { type: "reconnecting" });
    const ready: ServerFrame = {
      type: "ready",
      conversation_id: "c-1",
      limits: { max_session_seconds: 1800, remaining_seconds: 400 },
      resumed: true,
    };

    const back = after([ready], dropped);
    const stillWorking = after([{ type: "mode", mode: "working" }], back);

    expect(back.phase).toBe("live");
    expect(isLocked(back)).toBe(false);
    expect(isLocked(stillWorking)).toBe(true);
    expect(back.remainingSeconds).toBe(400);
  });

  it("is not something an idle or ended panel can be put into", () => {
    expect(agentReducer(initialState, { type: "reconnecting" }).phase).toBe("idle");
  });

  it("ends as disconnected if it never comes back", () => {
    const dropped = agentReducer(staged(), { type: "reconnecting" });

    const gone = agentReducer(dropped, { type: "closed", message: null });

    expect(gone).toMatchObject({ phase: "ended", endedReason: "disconnected", proposal: null });
  });
});

describe("describeSeconds", () => {
  it.each([
    [600, "10 min"],
    [150, "2 min"],
    [120, "2 min"],
    [90, "1 min 30 s"],
    [60, "1 min 0 s"],
    [45, "45 s"],
    [0, "0 s"],
    [-3, "0 s"],
  ])("says %i seconds as %s", (seconds, said) => {
    expect(describeSeconds(seconds)).toBe(said);
  });
});

describe("what the panel draws from", () => {
  const result = (id: string, status: "committed" | "cancelled" | "superseded"): ServerFrame => ({
    type: "proposal_result",
    id,
    status,
  });

  it("keeps every outcome as a receipt, where the last result is replaced", () => {
    const state = after(
      [
        result("p-1", "committed"),
        { type: "transcript", role: "user", text: "And another.", final: true },
        { type: "proposal", ...PROPOSAL, id: "p-2" },
        result("p-2", "cancelled"),
      ],
      staged(),
    );

    expect(state.receipts.map((receipt) => [receipt.id, receipt.status])).toEqual([
      ["p-1", "committed"],
      ["p-2", "cancelled"],
    ]);
    // What pages read is as it was: only the last.
    expect(state.lastResult?.id).toBe("p-2");
  });

  it("names each receipt from its proposal, and places it after the line it followed", () => {
    const state = after([
      { type: "transcript", role: "user", text: "Book it.", final: true },
      { type: "proposal", ...PROPOSAL, labels: { ...PROPOSAL.labels, when: "Thu 15 Oct, 2:00 PM" } },
      result("p-1", "committed"),
    ]);

    expect(state.receipts[0]).toMatchObject({
      kind: "meeting.create",
      name: "Hendricks walkthrough",
      when: "Thu 15 Oct, 2:00 PM",
      after: 1,
    });
  });

  it("leaves no receipt for a proposal that a correction replaced", () => {
    expect(after([result("p-1", "superseded")], staged()).receipts).toEqual([]);
  });

  it("marks the turn that read a proposal back, and only that one", () => {
    const state = after([
      { type: "transcript", role: "assistant", text: "When?", final: true },
      { type: "turn_complete", spoke: true, readback_for: null },
      { type: "transcript", role: "user", text: "At two.", final: true },
      { type: "transcript", role: "assistant", text: "I am about to create it.", final: true },
      { type: "turn_complete", spoke: true, readback_for: "p-1" },
    ]);

    expect(state.transcript.map((line) => line.readbackFor)).toEqual([undefined, undefined, "p-1"]);
  });

  it("marks a line the user talked over, and not one that simply ended", () => {
    const state = after([
      { type: "transcript", role: "assistant", text: "I am about to", final: false },
      { type: "interrupted" },
      { type: "transcript", role: "assistant", text: "Go on.", final: false },
      { type: "turn_complete", spoke: true, readback_for: null },
    ]);

    expect(state.transcript.map((line) => [line.final, line.cut ?? false])).toEqual([
      [true, true],
      [true, false],
    ]);
  });

  it("notes in the conversation what happened that nobody said", () => {
    const state = after([
      { type: "ui", directive_id: "d-1", action: "navigate", to: "/calendar?on=2026-10-14" },
      { type: "transcript", role: "user", text: "Thanks.", final: true },
      { type: "audio", state: "paused", reason: "approval" },
      { type: "audio", state: "paused", reason: "approval" },
      { type: "ready", conversation_id: "c-1", limits: { max_session_seconds: 1800 }, resumed: true },
    ]);

    expect(state.marks.map((mark) => [mark.after, mark.text])).toEqual([
      [0, "Opened Calendar"],
      [1, "Microphone paused"],
      [1, "Reconnected"],
    ]);
  });

  it("records that a read-back has been heard, for the card to say a yes will count", () => {
    const state = agentReducer(staged(), { type: "readback_played", id: "p-1" });

    expect(state.readbackPlayed).toBe("p-1");
    expect(state.proposal).toEqual(PROPOSAL);
  });

  it("counts the seconds the audio was live, and not the ones it was paused", () => {
    const tick = (state: AgentState) => agentReducer(state, { type: "tick" });
    const paused = after([{ type: "audio", state: "paused", reason: "approval" }], tick(tick(live())));

    expect(paused.elapsed).toBe(2);
    expect(tick(paused).elapsed).toBe(2);
  });
});
