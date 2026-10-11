/**
 * How the assistant looks in each state, drawn from fixed values.
 *
 * No socket, no audio and no server: the panel is handed a state the real reducer made
 * from the frames a server sends (`galleryFixtures`), and what is on screen is checked.
 * What the assistant *does* is tested in `AgentProvider.test.tsx`; this is about what a
 * design must not get wrong while changing how it looks (`AGENT_DESIGN.md` 14, 15.3).
 */
import { Profiler } from "react";
import { act, screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { url } from "@/test/msw/handlers";
import { server } from "@/test/msw/server";
import { makeUser } from "@/test/factories";
import { renderWithProviders } from "@/test/utils";
import { AgentGallery } from "./AgentGallery";
import { AgentPanel } from "./AgentPanel";
import { AgentPreview, type AgentContextValue } from "./AgentProvider";
import { agentReducer, initialState, type AgentAction, type AgentState } from "./agentState";
import {
  DETAILS,
  EVERY_RECEIPT,
  HISTORY,
  LOCK,
  MEETING,
  MEETING_WITH_FACTS,
  READY,
  SUBMIT,
  TALK,
  VOICE_MEETING,
  WORKING,
  previewOf,
  proposing,
  stateFrom,
} from "./galleryFixtures";
import type { ServerFrame } from "./protocol";

const SAM = makeUser({ full_name: "Sam Member" });

function serveNoHistory() {
  server.use(
    http.get(url("/agent/conversations"), () =>
      HttpResponse.json({ total: 0, limit: 20, offset: 0, items: [] }),
    ),
  );
}

function show(state: AgentState, over: Partial<AgentContextValue> = {}) {
  serveNoHistory();
  const value = previewOf(state, over);
  const view = renderWithProviders(
    <AgentPreview value={value}>
      <AgentPanel />
    </AgentPreview>,
    { user: SAM },
  );
  return { ...view, value };
}

const after = (state: AgentState, ...actions: AgentAction[]) => actions.reduce(agentReducer, state);
const frames = (state: AgentState, ...sent: ServerFrame[]) =>
  after(state, ...sent.map((frame): AgentAction => ({ type: "frame", frame })));

const status = () => screen.getByRole("status", { name: "Assistant status" });
const header = () => screen.getByRole("banner");
const card = () => screen.getByRole("region", { name: "Waiting for your approval" });
const orbs = (root: HTMLElement = document.body) => [...root.querySelectorAll("[data-orb]")];

afterEach(() => vi.unstubAllGlobals());

describe("before anything is said", () => {
  it("greets the person by first name and offers a way to start", async () => {
    show(initialState);

    expect(screen.getByRole("heading", { name: "Hi Sam" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Start talking" })).toBeEnabled();
    expect(screen.getByText("8 of 10 minutes left today")).toBeVisible();
    // Idle has nothing to say about itself.
    expect(status()).toBeEmptyDOMElement();
  });

  it("shows one orb, large, in the body and none in the header", () => {
    show(initialState);

    expect(orbs()).toHaveLength(1);
    expect(orbs(header())).toHaveLength(0);
    expect(orbs()[0]).toHaveAttribute("data-size", "96");
  });

  it("is not a blank panel once live: it says it is listening and what to do", () => {
    show(stateFrom([READY]));

    expect(status()).toHaveTextContent("Listening");
    expect(screen.getByText("Say something, or type below.")).toBeVisible();
    expect(orbs()[0]).toHaveAttribute("data-state", "listening");
    expect(orbs(header())).toHaveLength(0);
  });

  it("gives a wait of any length words", () => {
    vi.useFakeTimers();
    try {
      show(stateFrom([]));
      expect(status()).toHaveTextContent("Connecting");
      expect(screen.queryByLabelText("Message the assistant")).not.toBeInTheDocument();

      act(() => vi.advanceTimersByTime(4100));
      expect(screen.getByText("Waking the assistant…")).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves the orb to the header with the first words, and never shows two", () => {
    show(stateFrom(TALK));

    expect(orbs(header())).toHaveLength(1);
    expect(orbs(header())[0]).toHaveAttribute("data-size", "32");
    expect(document.querySelectorAll('[data-orb][data-size="96"]')).toHaveLength(0);
  });
});

describe("the state, in two words", () => {
  const afterReply = frames(
    stateFrom(TALK),
    { type: "transcript", role: "assistant", text: "Done.", final: true },
    { type: "turn_complete", spoke: true, readback_for: null },
  );

  it.each<[string, AgentState, string]>([
    ["listening once the assistant has finished", afterReply, "Listening"],
    ["thinking from the user's last word", stateFrom(TALK), "Thinking"],
    [
      "speaking while its words arrive",
      frames(stateFrom(TALK), { type: "transcript", role: "assistant", text: "Sure, ", final: false }),
      "Speaking",
    ],
    ["muted", after(afterReply, { type: "mute", muted: true }), "Muted"],
    ["working", stateFrom(WORKING), "Working"],
    ["waiting for the user", stateFrom(proposing(MEETING)), "Waiting for you"],
    [
      "paused",
      frames(stateFrom(proposing(MEETING)), { type: "audio", state: "paused", reason: "approval" }),
      "Microphone paused",
    ],
    [
      "out of time with something waiting",
      frames(stateFrom(proposing(MEETING)), { type: "audio", state: "paused", reason: "allowance" }),
      "Time used",
    ],
    ["reconnecting", after(stateFrom(TALK), { type: "reconnecting" }), "Reconnecting"],
  ])("says it is %s", (_name, state, label) => {
    show(state);

    expect(status()).toHaveTextContent(label);
  });

  it("says speaking when the voice is playing, whatever the transcript says", () => {
    const { value } = show(afterReply);
    expect(status()).toHaveTextContent("Listening");

    act(() => value.levels.voice(0.2, true));
    expect(status()).toHaveTextContent("Speaking");

    act(() => value.levels.voice(0, false));
    expect(status()).toHaveTextContent("Listening");
  });

  it("does not claim to be listening in a conversation with no microphone", () => {
    show(
      stateFrom(
        [READY, { type: "transcript", role: "assistant", text: "Hello.", final: true }],
        false,
      ),
    );

    expect(status()).toHaveTextContent("Ready");
    expect(screen.queryByRole("button", { name: "Mute" })).not.toBeInTheDocument();
  });
});

describe("the approval card", () => {
  it("is pinned in the dock, outside the part of the panel that scrolls", () => {
    show(stateFrom(proposing(MEETING)));

    expect(card().closest(".ast-scroll")).toBeNull();
    expect(card().closest(".ast-dock")).not.toBeNull();
  });

  it("can be approved from its first frame, and never takes focus onto Approve", () => {
    show(stateFrom(proposing(MEETING)));

    const approve = within(card()).getByRole("button", { name: "Approve" });
    expect(approve).toBeEnabled();
    expect(within(card()).getByRole("button", { name: "Reject" })).toBeEnabled();
    expect(approve).not.toHaveFocus();
    // Focus is on the card's title: a stray Space or Enter saves nothing.
    expect(within(card()).getByRole("heading", { name: "New meeting" })).toHaveFocus();
  });

  it("leaves focus where it is for someone typing a correction", async () => {
    const working = stateFrom(WORKING);
    const { user, value, rerender } = show(working);
    await user.click(screen.getByLabelText("Message the assistant"));

    const proposed = frames(working, { type: "proposal", ...MEETING });
    rerender(
      <AgentPreview value={{ ...value, state: proposed }}>
        <AgentPanel />
      </AgentPreview>,
    );

    expect(card()).toBeVisible();
    expect(screen.getByLabelText("Message the assistant")).toHaveFocus();
    expect(screen.getByLabelText("Message the assistant")).toHaveAttribute(
      "placeholder",
      "Type a correction",
    );
  });

  it("says it is not saved yet, in words, and names the record", () => {
    show(stateFrom(proposing(MEETING)));

    expect(within(card()).getByText("Not saved yet")).toBeVisible();
    expect(within(card()).getByText("Site visit with Maria Lopez")).toBeVisible();
  });

  it("lays the facts out from the labels the proposal already carries", () => {
    show(stateFrom(proposing(MEETING)));

    const facts = within(card());
    expect(facts.getByText("When")).toBeVisible();
    expect(facts.getByText("Thu 15 Oct 2026, 2:00–2:45 PM")).toBeVisible();
    expect(facts.getByText("Who")).toBeVisible();
    expect(facts.getByText("Maria Lopez j.smith@acme.com (outside guest)")).toBeVisible();
  });

  it("uses the server's own facts, and where each came from, once it sends them", () => {
    show(stateFrom(proposing(MEETING_WITH_FACTS)));

    expect(within(card()).getByText("Where")).toBeVisible();
    expect(within(card()).getByText("1420 Oak Street")).toBeVisible();
    expect(within(card()).getByText("from memory")).toBeVisible();
  });

  it("shows an edit as what it is now, struck through, above what it would become", () => {
    show(stateFrom(proposing(DETAILS)));

    const was = within(card()).getByText("Acme Insurance");
    expect(was).toHaveClass("line-through");
    expect(within(card()).getByText("Beacon Mutual")).toBeVisible();
  });

  it("shows every exception without anything having to be opened", () => {
    show(stateFrom(proposing(MEETING)));

    const exceptions = within(within(card()).getByRole("list", { name: "Check before approving" }));
    expect(exceptions.getByText("j.smith@acme.com is outside the team")).toBeVisible();
    expect(exceptions.getByText("45 minutes is from memory")).toBeVisible();
  });

  it("carries the server's summary word for word", () => {
    show(stateFrom(proposing(MEETING)));

    expect(within(card()).getByText(MEETING.summary)).toBeVisible();
  });

  it.each([
    ["with no reason sent", MEETING, "Needs a click. Saying yes will not approve it."],
    ["that sends email", MEETING_WITH_FACTS, "Sends email. Needs a click."],
    ["that changes who can edit", LOCK, "Changes who can edit. Needs a click."],
    [
      "whose read-back was not verified",
      SUBMIT,
      "It did not read all of this back. Needs a click.",
    ],
  ])("says why a click-only proposal %s needs a click, and never says yes will work", (_name, proposal, line) => {
    show(stateFrom(proposing(proposal)));

    expect(within(card()).getByText(line)).toBeVisible();
    expect(within(card()).queryByText(/Say yes/)).not.toBeInTheDocument();
  });

  it("names a status change for what it does", () => {
    show(stateFrom(proposing(LOCK)));

    expect(within(card()).getByRole("heading", { name: "Lock supplement" })).toBeVisible();
  });

  it("says a yes will count only once the read-back has been heard", () => {
    const waiting = stateFrom(proposing(VOICE_MEETING));
    const { value, rerender } = show(waiting);
    expect(within(card()).getByText(/Say yes once you have heard it/)).toBeVisible();

    rerender(
      <AgentPreview
        value={{ ...value, state: after(waiting, { type: "readback_played", id: VOICE_MEETING.id }) }}
      >
        <AgentPanel />
      </AgentPreview>,
    );
    expect(within(card()).getByText("Say yes, or press Approve")).toBeVisible();
  });

  it("warns in its last two minutes", () => {
    show(stateFrom(proposing(SUBMIT)));

    expect(within(card()).getByRole("timer", { name: "Time left to approve" })).toHaveTextContent(
      /Expires in 1:\d\d/,
    );
  });

  it("keeps Tap to talk in reach on a click-only proposal too", () => {
    show(frames(stateFrom(proposing(MEETING)), { type: "audio", state: "paused", reason: "approval" }));

    expect(within(card()).getByRole("button", { name: "Tap to talk" })).toBeEnabled();
    expect(within(card()).getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("waits, with its buttons off, while the connection is being restored", () => {
    show(after(stateFrom(proposing(MEETING)), { type: "reconnecting" }));

    expect(within(card()).getByText("Reconnecting…")).toBeVisible();
    expect(within(card()).getByRole("button", { name: "Approve" })).toBeDisabled();
    // The way out is still there.
    expect(screen.getByRole("button", { name: "End" })).toBeEnabled();
    expect(screen.queryByLabelText("Message the assistant")).not.toBeInTheDocument();
  });
});

describe("the read-back", () => {
  it("is kept to two lines while its card is open, with a way to see all of it", async () => {
    const { user } = show(stateFrom(proposing(MEETING)));

    const log = within(screen.getByRole("log", { name: "Conversation" }));
    expect(log.getByText("Read-back")).toBeVisible();
    const turn = log.getByText(MEETING.summary);
    expect(turn).toHaveClass("line-clamp-2");

    await user.click(log.getByRole("button", { name: "Show all" }));
    expect(turn).not.toHaveClass("line-clamp-2");
  });

  it("is an ordinary turn again once the proposal is resolved", () => {
    show(
      frames(stateFrom(proposing(MEETING)), {
        type: "proposal_result",
        id: MEETING.id,
        status: "cancelled",
      }),
    );

    const log = within(screen.getByRole("log", { name: "Conversation" }));
    expect(log.queryByText("Read-back")).not.toBeInTheDocument();
    expect(log.getByText(MEETING.summary)).not.toHaveClass("line-clamp-2");
  });
});

describe("while the assistant works", () => {
  it("has one Stop in the panel, in the dock, and it is not the red button", () => {
    show(stateFrom(WORKING));

    const stops = screen.getAllByRole("button", { name: "Stop" });
    expect(stops).toHaveLength(1);
    expect(stops[0]?.closest(".ast-dock")).not.toBeNull();
    expect(stops[0]?.className).not.toMatch(/danger/);
  });

  it("lists the steps with what is done and what is happening now", () => {
    show(stateFrom(WORKING));

    const steps = within(screen.getByRole("list", { name: "What the assistant is doing" }));
    expect(steps.getByText("Open the calendar")).toBeVisible();
    expect(steps.getByText("Done:")).toBeInTheDocument();
    expect(steps.getByText("Fill in the meeting")).toBeVisible();
    expect(steps.getByText("Now:")).toBeInTheDocument();
  });

  it("shows the last four steps and folds the earlier ones into a line", async () => {
    const many = frames(
      stateFrom([READY, { type: "mode", mode: "working" }]),
      ...Array.from({ length: 6 }, (_, index): ServerFrame => ({
        type: "step",
        id: `s${index}`,
        label: `Step ${index + 1}`,
        status: index === 5 ? "active" : "done",
      })),
    );
    const { user } = show(many);

    expect(screen.queryByText("Step 1")).not.toBeInTheDocument();
    expect(screen.getByText("Step 6")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "2 earlier steps" }));
    expect(screen.getByText("Step 1")).toBeVisible();
  });
});

describe("what was done stays where it happened", () => {
  it("leaves a receipt for every outcome, each saying in words what became of it", () => {
    show(stateFrom(EVERY_RECEIPT));

    const receipts = screen.getAllByRole("article");
    expect(receipts.map((receipt) => receipt.querySelector("p")?.textContent)).toEqual([
      "Saved",
      "Not saved",
      "Not saved. You rejected it.",
      "Stopped. The form is yours to finish.",
      "Not saved. It waited too long.",
    ]);
    expect(within(receipts[0] as HTMLElement).getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      "/calendar",
    );
    expect(within(receipts[1] as HTMLElement).getByText("That time is in the past.")).toBeVisible();
  });

  it("keeps three receipts for three changes, where one used to replace the last", () => {
    const three = frames(
      stateFrom([READY]),
      ...["a", "b", "c"].flatMap((id): ServerFrame[] => [
        { type: "proposal", ...MEETING, id },
        { type: "proposal_result", id, status: "committed", target: { type: "meeting", id } },
      ]),
    );
    show(three);

    expect(screen.getAllByRole("article")).toHaveLength(3);
    expect(three.commits).toBe(3);
  });

  it("puts what nobody said in the conversation as a quiet line", () => {
    show(stateFrom(EVERY_RECEIPT));

    expect(screen.getByText("Opened Calendar")).toBeVisible();
    expect(screen.getByText("Site visits are usually 45 minutes")).toBeVisible();
    expect(screen.getByRole("button", { name: "Undo" })).toBeVisible();
  });

  it("ends with one card: why, what was saved, and the way to start again", () => {
    const ended = after(
      frames(
        stateFrom(TALK),
        { type: "proposal", ...MEETING },
        { type: "proposal_result", id: MEETING.id, status: "committed" },
      ),
      ...Array.from({ length: 90 }, (): AgentAction => ({ type: "tick" })),
      { type: "frame", frame: { type: "ended", reason: "user_closed" } },
    );
    show(ended);

    const closing = within(screen.getByRole("region", { name: "Conversation ended" }));
    expect(closing.getByText("You ended the conversation.")).toBeVisible();
    expect(closing.getByText("1 saved · 1 min 30 s")).toBeVisible();
    expect(closing.getByRole("button", { name: "Start a new conversation" })).toBeEnabled();
    // The history is behind the clock in the header, not repeated underneath.
    expect(screen.queryByRole("region", { name: "Recent conversations" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Past conversations" })).toBeVisible();
  });
});

describe("history rows", () => {
  it("leave out a duration that says nothing, and name an untitled one for when it was", async () => {
    server.use(http.get(url("/agent/conversations"), () => HttpResponse.json(HISTORY)));
    const value = previewOf(initialState);
    renderWithProviders(
      <AgentPreview value={value}>
        <AgentPanel showHistory={null} />
      </AgentPreview>,
      { user: SAM },
    );

    const list = await screen.findByRole("region", { name: "Past conversations" });
    const rows = await within(list).findAllByRole("listitem");
    // Typed, so no audio was metered: it used to say "0 s" and look broken.
    const typed = rows[1] as HTMLElement;
    expect(within(typed).getByText(/^Conversation at /)).toBeVisible();
    expect(typed).not.toHaveTextContent(/\d s\b/);
    expect(typed).not.toHaveTextContent("of voice");
    expect(within(typed).getByText(/nothing saved/)).toBeVisible();

    expect(rows[0]).toHaveTextContent("1 min 18 s of voice");
    expect(within(list).getByRole("heading", { name: "Today" })).toBeVisible();
    expect(within(list).getByRole("heading", { name: "Yesterday" })).toBeVisible();
    expect(screen.queryByText("Untitled")).not.toBeInTheDocument();
  });
});

describe("the controls", () => {
  it("gives every button in the panel a name", () => {
    show(frames(stateFrom(proposing(VOICE_MEETING)), { type: "audio", state: "paused", reason: "approval" }));

    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveAccessibleName();
    }
  });

  it("names the voice controls for what pressing them will do, and shows their state", () => {
    const talking = stateFrom(TALK);
    const { value, rerender } = show(talking);
    expect(screen.getByRole("button", { name: "Mute" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Turn speaker off" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    const quiet = after(talking, { type: "mute", muted: true }, { type: "speaker", on: false });
    rerender(
      <AgentPreview value={{ ...value, state: quiet }}>
        <AgentPanel />
      </AgentPreview>,
    );
    expect(screen.getByRole("button", { name: "Unmute" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Turn speaker on" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("offers Send only when there is something to send", async () => {
    const send = vi.fn();
    const { user } = show(stateFrom(TALK), { sendText: send });
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Message the assistant"), "make it 4pm");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(send).toHaveBeenCalledWith("make it 4pm");
    expect(screen.getByLabelText("Message the assistant")).toHaveValue("");
  });

  it("makes a new line with Shift and Enter, and does not send", async () => {
    const send = vi.fn();
    const { user } = show(stateFrom(TALK), { sendText: send });

    await user.type(screen.getByLabelText("Message the assistant"), "one{Shift>}{Enter}{/Shift}two");

    expect(send).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Message the assistant")).toHaveValue("one\ntwo");
  });

  it("does not close the panel on Escape, which would end the conversation", async () => {
    const close = vi.fn();
    const { user } = show(stateFrom(TALK), { closePanel: close });

    await user.click(screen.getByLabelText("Message the assistant"));
    await user.keyboard("{Escape}");

    expect(close).not.toHaveBeenCalled();
  });
});

describe("sound and motion", () => {
  it("does not redraw the panel for the microphone's level", () => {
    serveNoHistory();
    const value = previewOf(stateFrom(TALK));
    let renders = 0;
    renderWithProviders(
      <AgentPreview value={value}>
        <Profiler id="panel" onRender={() => (renders += 1)}>
          <AgentPanel />
        </Profiler>
      </AgentPreview>,
      { user: SAM },
    );
    const settled = renders;

    act(() => {
      for (let reading = 0; reading < 50; reading += 1) value.levels.mic(Math.random() * 0.2);
    });

    expect(renders).toBe(settled);
  });

  function watchTravel(reduce: boolean) {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("reduced-motion") ? reduce : true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const animate = vi.fn();
    Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 96,
      height: 96,
      right: 96,
      bottom: 96,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const waiting = stateFrom([READY]);
    const { value, rerender } = show(waiting);
    rerender(
      <AgentPreview
        value={{
          ...value,
          state: frames(waiting, { type: "transcript", role: "user", text: "Hello.", final: true }),
        }}
      >
        <AgentPanel />
      </AgentPreview>,
    );
    return animate;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(Element.prototype, "animate");
  });

  it("sends the orb travelling to the header on the first words", () => {
    const animate = watchTravel(false);

    expect(orbs(header())).toHaveLength(1);
    expect(animate).toHaveBeenCalled();
  });

  it("holds still when reduced motion is asked for: the orb is simply in the header", () => {
    const animate = watchTravel(true);

    expect(orbs(header())).toHaveLength(1);
    expect(animate).not.toHaveBeenCalled();
    expect(screen.getByText("Hello.")).toBeVisible();
  });
});

describe("the gallery", () => {
  it("draws every state, each with its status line, in both themes", async () => {
    server.use(http.get(url("/agent/status"), () => HttpResponse.json({ enabled: false })));
    renderWithProviders(<AgentGallery />, { user: SAM, route: "/dev/assistant" });

    const cards = document.querySelectorAll("figure");
    expect(cards.length).toBeGreaterThanOrEqual(40);
    for (const figure of cards) {
      expect(within(figure as HTMLElement).getByRole("status", { name: "Assistant status" })).toBeInTheDocument();
    }
    const dark = [...cards].filter(
      (figure) => figure.closest<HTMLElement>("[data-theme]")?.dataset.theme === "dark",
    );
    expect(dark).toHaveLength(cards.length / 2);
    // The orb, in every state.
    expect(document.querySelectorAll('[data-orb][data-state="reconnecting"]').length).toBeGreaterThan(0);
  });
});
