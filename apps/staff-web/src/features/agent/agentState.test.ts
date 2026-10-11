/**
 * The panel's state, driven by frames alone.
 *
 * No socket and no audio: the reducer is the part of the assistant that decides what the
 * user is shown, and it is pure, so every frame the server can send is exercised here.
 */
import { describe, expect, it } from "vitest";
import { agentReducer, describeEnding, initialState, type AgentState } from "./agentState";
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
