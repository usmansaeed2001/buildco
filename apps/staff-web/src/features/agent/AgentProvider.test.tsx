/**
 * The assistant in the shell, end to end in the browser's half: launcher, panel, the
 * work-mode lock, and a proposal staged on the real calendar.
 *
 * The socket and the audio device are replaced, because jsdom has neither. Everything
 * else is real: the provider, the reducer, the shell, the frame, the calendar page and
 * its meeting form. The fake socket is driven by handing it the frames the server sends.
 */
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/AppShell";
import { CalendarPage } from "@/features/calendar/CalendarPage";
import { EstimateEditorPage } from "@/features/estimates/EstimateEditorPage";
import { EstimatesListPage } from "@/features/estimates/EstimatesListPage";
import { makeEstimate, makeUser } from "@/test/factories";
import { apiError, url } from "@/test/msw/handlers";
import { server } from "@/test/msw/server";
import { renderWithProviders } from "@/test/utils";
import type { AudioOptions } from "./audio";
import type { ClientFrame, Proposal, ServerFrame } from "./protocol";
import type { TransportHandlers } from "./transport";

interface FakeSocket {
  url: string;
  handlers: TransportHandlers;
  sent: ClientFrame[];
  /** How many chunks of microphone audio were sent up it. */
  audio: number;
  closed: boolean;
}

const fakes = vi.hoisted(() => ({
  sockets: [] as FakeSocket[],
  audio: [] as { options: AudioOptions; calls: string[] }[],
  order: [] as string[],
  denyMicrophone: false,
}));

vi.mock("./transport", () => ({
  connectSocket: (socketUrl: string, handlers: TransportHandlers) => {
    const socket: FakeSocket = { url: socketUrl, handlers, sent: [], audio: 0, closed: false };
    fakes.sockets.push(socket);
    fakes.order.push("socket");
    queueMicrotask(() => handlers.onOpen());
    return {
      send: (frame: ClientFrame) => socket.sent.push(frame),
      sendAudio: () => {
        socket.audio += 1;
      },
      close: () => {
        socket.closed = true;
      },
    };
  },
}));

vi.mock("./audio", async (original) => {
  const real = await original<typeof import("./audio")>();
  return {
    ...real,
    openAudio: async (options: AudioOptions) => {
      fakes.order.push("audio");
      if (fakes.denyMicrophone && options.microphone) throw new real.MicrophoneDenied("denied");
      const device = { options, calls: [] as string[] };
      fakes.audio.push(device);
      return {
        play: () => device.calls.push("play"),
        flush: () => device.calls.push("flush"),
        mark: (id: string) => device.calls.push(`mark:${id}`),
        setSpeaker: (on: boolean) => device.calls.push(`speaker:${on}`),
        setMuted: (muted: boolean) => device.calls.push(`muted:${muted}`),
        close: () => device.calls.push("close"),
      };
    },
  };
});

const OWNER = makeUser({ id: "owner-1", role: "owner", full_name: "Casey Owner" });

const PROPOSAL: Proposal = {
  id: "p-1",
  kind: "meeting.create",
  summary:
    "I am about to create the meeting Hendricks walkthrough on Wednesday, 14 October 2026 at 2:30 PM, for 45 minutes.",
  payload: {
    title: "Hendricks walkthrough",
    description: "",
    location: "12 Maple Street",
    start_time: new Date(2026, 9, 14, 14, 30).toISOString(),
    end_time: new Date(2026, 9, 14, 15, 15).toISOString(),
    color: "#3B82F6",
    project_id: null,
    attendee_ids: ["u-sam"],
    attendee_emails: ["adjuster@insurer.example.com"],
  },
  labels: {
    // Where it is staged is the server's to say.
    route: "/calendar?on=2026-10-14",
    attendees: [
      { label: "Sam Member" },
      { label: "adjuster@insurer.example.com", note: "outside guest" },
    ],
  },
  warnings: [],
  approval: "click",
  expires_at: "2026-10-14T22:00:00Z",
};

function serveAssistant(enabled = true, remaining = 600) {
  const sessions: Record<string, unknown>[] = [];
  let meetingRequests = 0;
  server.use(
    http.get(url("/agent/status"), () =>
      HttpResponse.json({
        enabled,
        max_session_seconds: 1800,
        daily_limit_seconds: 600,
        used_seconds: 600 - remaining,
        remaining_seconds: remaining,
        resets_at: "2026-10-15T00:00:00Z",
      }),
    ),
    http.post(url("/agent/sessions"), async ({ request }) => {
      fakes.order.push("session");
      sessions.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(
        {
          conversation_id: "c-1",
          ws_url: "ws://agent.test/api/v1/agent/live",
          ticket: "ticket/with+odd=chars",
          limits: { max_session_seconds: 1800, remaining_seconds: remaining },
        },
        { status: 201 },
      );
    }),
    http.get(url("/meetings"), () => {
      meetingRequests += 1;
      return HttpResponse.json([]);
    }),
  );
  return { sessions, meetingRequests: () => meetingRequests };
}

function renderShell() {
  return renderWithProviders(
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/estimates" element={<p>Supplements page</p>} />
        <Route path="/calendar" element={<CalendarPage />} />
      </Route>
    </Routes>,
    { user: OWNER, route: "/estimates" },
  );
}

const socket = () => fakes.sockets[fakes.sockets.length - 1] as FakeSocket;
const device = () => fakes.audio[fakes.audio.length - 1] as (typeof fakes.audio)[number];
const sentOf = <T extends ClientFrame["type"]>(type: T) =>
  socket().sent.filter((frame): frame is Extract<ClientFrame, { type: T }> => frame.type === type);

function receive(...frames: ServerFrame[]) {
  act(() => frames.forEach((frame) => socket().handlers.onFrame(frame)));
}

const READY: ServerFrame = {
  type: "ready",
  conversation_id: "c-1",
  limits: { max_session_seconds: 1800, remaining_seconds: 600 },
};

async function startTalking() {
  const view = renderShell();
  await view.user.click(await screen.findByRole("button", { name: "Ask BuildCo Assistant" }));
  await view.user.click(screen.getByRole("button", { name: "Start talking" }));
  await waitFor(() => expect(fakes.sockets).toHaveLength(1));
  receive(READY);
  return view;
}

function stage(proposal: Proposal = PROPOSAL) {
  receive(
    { type: "mode", mode: "working" },
    { type: "step", id: "stage", label: "Fill in the meeting", status: "active" },
    { type: "ui", directive_id: "d-1", action: "stage", proposal },
  );
}

const appColumn = () => document.querySelector("[data-app-column]") as HTMLElement;
const panel = () => screen.getByRole("complementary", { name: "Side panel" });
/** The two words under the panel's title that say what the assistant is doing. */
const status = () => within(panel()).getByRole("status", { name: "Assistant status" });

beforeEach(() => {
  fakes.sockets.length = 0;
  fakes.audio.length = 0;
  fakes.order.length = 0;
  fakes.denyMicrophone = false;
});

afterEach(() => vi.unstubAllGlobals());

describe("BuildCo Assistant in the shell", () => {
  describe("the launcher", () => {
    it("is not there for someone the assistant is not offered to", async () => {
      serveAssistant(false);
      renderShell();

      await screen.findByText("Supplements page");
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Ask BuildCo Assistant" })).not.toBeInTheDocument(),
      );
    });

    it("is there, with its name, for someone it is offered to", async () => {
      serveAssistant();
      renderShell();

      const launcher = await screen.findByRole("button", { name: "Ask BuildCo Assistant" });
      // Its label is part of the button, not the browser's tooltip: that one is slow to
      // appear, unstyled and absent on touch.
      expect(within(launcher).getByText("Ask BuildCo Assistant")).toBeInTheDocument();
      expect(launcher).not.toHaveAttribute("title");
    });

    it("is not offered in a window under 1024px", async () => {
      vi.stubGlobal("matchMedia", () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
      serveAssistant();
      renderShell();

      await screen.findByText("Supplements page");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByRole("button", { name: "Ask BuildCo Assistant" })).not.toBeInTheDocument();
    });

    it("opens a panel beside the app, idle, and gets out of the way", async () => {
      serveAssistant();
      const { user } = renderShell();

      await user.click(await screen.findByRole("button", { name: "Ask BuildCo Assistant" }));

      expect(within(panel()).getByRole("button", { name: "Start talking" })).toBeVisible();
      expect(within(panel()).getByLabelText("Message the assistant")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Ask BuildCo Assistant" })).not.toBeInTheDocument();
      expect(fakes.sockets).toHaveLength(0);
    });
  });

  describe("starting", () => {
    it("opens audio before asking the server for a session", async () => {
      // A browser only lets audio start in direct response to a click. Spending the
      // click on a fetch first would connect a conversation nobody can hear.
      serveAssistant();
      await startTalking();

      expect(fakes.order).toEqual(["audio", "session", "socket"]);
      expect(device().options.microphone).toBe(true);
    });

    it("connects with the ticket, escaped, and reports where the user is", async () => {
      const { sessions } = serveAssistant();
      await startTalking();

      expect(socket().url).toBe(
        "ws://agent.test/api/v1/agent/live?ticket=ticket%2Fwith%2Bodd%3Dchars",
      );
      expect(sessions[0]).toHaveProperty("client_timezone");
      expect(sentOf("context")[0]).toMatchObject({ route: "/estimates", dialog_open: false });
    });

    it("shows the live controls once the server is ready", async () => {
      serveAssistant();
      await startTalking();

      expect(within(panel()).getByRole("button", { name: "Mute" })).toBeVisible();
      expect(within(panel()).getByRole("button", { name: "Turn speaker off" })).toBeVisible();
      expect(within(panel()).getByRole("button", { name: "End" })).toBeVisible();
    });

    it("starts without the microphone when the first thing the user does is type", async () => {
      serveAssistant();
      const { user } = renderShell();
      await user.click(await screen.findByRole("button", { name: "Ask BuildCo Assistant" }));

      await user.type(screen.getByLabelText("Message the assistant"), "book a meeting{Enter}");
      await waitFor(() => expect(fakes.sockets).toHaveLength(1));

      expect(device().options.microphone).toBe(false);
      await waitFor(() => expect(sentOf("text")).toEqual([{ type: "text", text: "book a meeting" }]));
      expect(within(panel()).getByText("book a meeting")).toBeVisible();
    });

    it("explains a blocked microphone and offers typing instead", async () => {
      fakes.denyMicrophone = true;
      serveAssistant();
      const { user } = renderShell();
      await user.click(await screen.findByRole("button", { name: "Ask BuildCo Assistant" }));

      await user.click(screen.getByRole("button", { name: "Start talking" }));

      expect(await within(panel()).findByText(/microphone is blocked/i)).toBeVisible();
      expect(within(panel()).getByLabelText("Message the assistant")).toBeVisible();
      expect(fakes.sockets).toHaveLength(0);
    });
  });

  describe("a staged proposal", () => {
    it("is shown on the real meeting form, read-only, with exactly the people it invites", async () => {
      serveAssistant();
      await startTalking();

      stage();

      const form = await screen.findByRole("dialog", { name: "New meeting" });
      expect(within(form).getByText("Filled in by BuildCo Assistant · Not saved yet")).toBeVisible();
      expect(within(form).getByLabelText(/^Title/)).toHaveValue("Hendricks walkthrough");
      expect(within(form).getByLabelText("Date")).toHaveValue("2026-10-14");
      expect(within(form).getByLabelText("Start")).toHaveValue("14:30");
      const people = within(within(form).getByRole("list", { name: "Attendees" }));
      expect(people.getByText("Sam Member")).toBeVisible();
      expect(people.getByText("adjuster@insurer.example.com")).toBeVisible();
      expect(within(form).queryByRole("button", { name: "Create meeting" })).not.toBeInTheDocument();
    });

    it("tells the server it is on screen only once the calendar has rendered it", async () => {
      serveAssistant();
      await startTalking();
      expect(sentOf("ui_ack")).toEqual([]);

      stage();
      await screen.findByRole("dialog", { name: "New meeting" });

      expect(sentOf("ui_ack")).toEqual([{ type: "ui_ack", directive_id: "d-1", ok: true }]);
    });

    it("says it could not be shown when the page it was sent to does not show it", async () => {
      serveAssistant();
      await startTalking();

      stage({ ...PROPOSAL, kind: "something.else" });

      // Nothing on the calendar stages that kind, so nobody confirms it, and the
      // server is told so rather than left to describe a form that is not there.
      await waitFor(() => expect(sentOf("ui_ack")[0]).toMatchObject({ ok: false }), {
        timeout: 6000,
      });
    }, 10_000);

    it("shows a change that has no page of its own in the panel alone, and says it is shown", async () => {
      serveAssistant();
      await startTalking();
      const forget: Proposal = {
        ...PROPOSAL,
        id: "p-memory",
        kind: "memory.change",
        summary: "I am about to forget this: Prefers to be called Sam",
        payload: { memory_id: "m-1", content: null },
        labels: { old: "Prefers to be called Sam", new: null },
        approval: "voice_or_click",
      };

      stage(forget);
      receive({ type: "proposal", ...forget });

      await waitFor(() => expect(sentOf("ui_ack")[0]).toMatchObject({ ok: true }));
      expect(screen.getByText("Supplements page")).toBeVisible();
      const card = within(panel()).getByRole("region", { name: "Waiting for your approval" });
      expect(within(card).getByText("Change to what I remember")).toBeVisible();
      expect(within(card).getByText("Forgotten")).toBeVisible();
      expect(within(card).getByText(/Say yes once you have heard it/)).toBeVisible();
    });

    it("locks the app, and leaves the panel and Stop alone", async () => {
      serveAssistant();
      await startTalking();

      stage();
      await screen.findByRole("dialog", { name: "New meeting" });

      expect(appColumn()).toHaveAttribute("inert");
      // The staged form is inside the lock: it is shown, not operated.
      expect(appColumn()).toContainElement(screen.getByRole("dialog", { name: "New meeting" }));
      expect(panel().closest("[inert]")).toBeNull();
      const banner = document.querySelector("[data-app-lock]") as HTMLElement;
      expect(within(banner).getByText("BuildCo Assistant is working")).toBeVisible();
      // The step is named over the app too, so nobody has to look back at the panel.
      expect(within(banner).getByText("Fill in the meeting")).toBeVisible();
      expect(banner.closest("[inert]")).toBeNull();
      expect(within(panel()).getByText("Fill in the meeting")).toBeVisible();
    });

    it("puts the summary on the approval card word for word, and says it needs a click", async () => {
      serveAssistant();
      await startTalking();
      stage();

      receive({ type: "proposal", ...PROPOSAL });

      const card = within(panel()).getByRole("region", { name: "Waiting for your approval" });
      expect(within(card).getByText(PROPOSAL.summary)).toBeVisible();
      expect(within(card).getByText(/Needs a click/)).toBeVisible();
      expect(within(card).getByText(/Sam Member/)).toBeVisible();
    });

    it("sends the user's decision, not a result", async () => {
      serveAssistant();
      const { user } = await startTalking();
      stage();
      receive({ type: "proposal", ...PROPOSAL });

      await user.click(within(panel()).getByRole("button", { name: "Reject" }));
      await user.click(within(panel()).getByRole("button", { name: "Approve" }));

      expect(sentOf("approval")).toEqual([
        { type: "approval", proposal_id: "p-1", decision: "reject" },
        { type: "approval", proposal_id: "p-1", decision: "approve" },
      ]);
      // The card is still there because of the clicks: the server decides the outcome.
      // While the approval is on its way the buttons wait for it, and nothing says saved.
      const card = within(panel()).getByRole("region", { name: "Waiting for your approval" });
      expect(card).toBeVisible();
      expect(within(card).getByRole("button", { name: "Approve" })).toBeDisabled();
      expect(within(card).getByText("Not saved yet")).toBeVisible();
    });

    it("unlocks, refreshes the calendar and says so when it is saved", async () => {
      const served = serveAssistant();
      await startTalking();
      stage();
      await screen.findByRole("dialog", { name: "New meeting" });
      receive({ type: "proposal", ...PROPOSAL });
      const before = served.meetingRequests();

      receive(
        { type: "proposal_result", id: "p-1", status: "committed", target: { type: "meeting", id: "m-1" } },
        { type: "ui", directive_id: "d-2", action: "refresh", keys: ["meetings"] },
        { type: "ui", directive_id: "d-3", action: "unstage" },
        { type: "mode", mode: "conversing" },
      );

      expect(screen.queryByRole("dialog", { name: "New meeting" })).not.toBeInTheDocument();
      expect(appColumn()).not.toHaveAttribute("inert");
      const receipt = within(panel()).getByRole("article");
      expect(within(receipt).getByText("Saved")).toBeVisible();
      expect(within(receipt).getByText(/Hendricks walkthrough/)).toBeVisible();
      await waitFor(() => expect(served.meetingRequests()).toBeGreaterThan(before));
    });
  });

  describe("Stop", () => {
    it("is sent by the button on the lock, by the one in the panel, and by Escape", async () => {
      serveAssistant();
      const { user } = await startTalking();
      stage();
      await screen.findByRole("dialog", { name: "New meeting" });

      const banner = document.querySelector("[data-app-lock]") as HTMLElement;
      await user.click(within(banner).getByRole("button", { name: "Stop" }));
      await user.click(within(panel()).getByRole("button", { name: "Stop" }));
      await user.keyboard("{Escape}");

      expect(sentOf("stop")).toHaveLength(3);
    });

    it("turns the staged form into an ordinary one, still filled, for the user to finish", async () => {
      serveAssistant();
      await startTalking();
      stage();
      await screen.findByRole("dialog", { name: "New meeting" });

      receive(
        { type: "proposal_result", id: "p-1", status: "handed_over" },
        { type: "mode", mode: "conversing" },
      );

      const form = await screen.findByRole("dialog", { name: "New meeting" });
      expect(within(form).queryByText(/Filled in by BuildCo Assistant/)).not.toBeInTheDocument();
      expect(within(form).getByLabelText(/^Title/)).toHaveValue("Hendricks walkthrough");
      expect(within(form).getByLabelText(/^Title/)).toBeEnabled();
      expect(within(form).getByRole("button", { name: "Create meeting" })).toBeEnabled();
      expect(within(within(form).getByRole("list", { name: "Guests" })).getByText("adjuster@insurer.example.com")).toBeVisible();
      expect(appColumn()).not.toHaveAttribute("inert");
      expect(within(panel()).getByText(/yours to finish/)).toBeVisible();
    });

    it("does not treat Escape as Stop when the assistant is not working", async () => {
      serveAssistant();
      const { user } = await startTalking();

      await user.keyboard("{Escape}");

      expect(sentOf("stop")).toEqual([]);
    });
  });

  describe("the read-back", () => {
    it("is reported as heard when the player reaches the end of it, not when it arrives", async () => {
      serveAssistant();
      await startTalking();

      receive({ type: "turn_complete", spoke: true, readback_for: "p-1" });
      expect(device().calls).toContain("mark:p-1");
      expect(sentOf("readback_played")).toEqual([]);

      act(() => device().options.onPlayed("p-1"));
      expect(sentOf("readback_played")).toEqual([{ type: "readback_played", proposal_id: "p-1" }]);
    });

    it("is not marked for an ordinary turn", async () => {
      serveAssistant();
      await startTalking();

      receive({ type: "turn_complete", spoke: true, readback_for: null });

      expect(device().calls.some((call) => call.startsWith("mark"))).toBe(false);
    });

    it("counts as delivered at once with the speaker off, since nothing will play", async () => {
      serveAssistant();
      const { user } = await startTalking();
      await user.click(within(panel()).getByRole("button", { name: "Turn speaker off" }));

      receive({ type: "turn_complete", spoke: true, readback_for: "p-1" });

      expect(sentOf("readback_played")).toEqual([{ type: "readback_played", proposal_id: "p-1" }]);
      expect(device().calls).toContain("speaker:false");
      expect(device().calls).not.toContain("mark:p-1");
    });

    it("drops what has not played yet when the user talks over the agent", async () => {
      serveAssistant();
      await startTalking();

      receive({ type: "interrupted" });

      expect(device().calls).toContain("flush");
    });
  });

  describe("ending", () => {
    it("ends the conversation when the panel is closed", async () => {
      serveAssistant();
      const { user } = await startTalking();

      await user.click(within(panel()).getByRole("button", { name: "Close assistant" }));

      expect(sentOf("end")).toHaveLength(1);
      expect(screen.queryByRole("complementary", { name: "Side panel" })).not.toBeInTheDocument();
    });

    it("says why it ended and offers another", async () => {
      serveAssistant();
      await startTalking();

      receive({ type: "ended", reason: "time_limit" });

      expect(within(panel()).getByText("The conversation reached its time limit.")).toBeVisible();
      expect(within(panel()).getByRole("button", { name: "Start a new conversation" })).toBeVisible();
      expect(socket().closed).toBe(true);
      expect(device().calls).toContain("close");
    });

    it("unlocks the app at once if the connection dies while the assistant is working", async () => {
      serveAssistant();
      server.use(
        http.post(url("/agent/sessions/c-1/reconnect"), () => new Promise(() => {})),
      );
      await startTalking();
      stage();
      await screen.findByRole("dialog", { name: "New meeting" });
      expect(appColumn()).toHaveAttribute("inert");

      act(() => socket().handlers.onClose(1006));

      // Never a lock behind a dead connection, whatever happens next.
      expect(appColumn()).not.toHaveAttribute("inert");
      expect(status()).toHaveTextContent(/Reconnecting/);
    });

    it("keeps a live panel on screen when the window becomes too narrow to offer one", async () => {
      let narrow = false;
      const listeners: (() => void)[] = [];
      vi.stubGlobal("matchMedia", () => ({
        get matches() {
          return !narrow;
        },
        addEventListener: (_: string, listener: () => void) => listeners.push(listener),
        removeEventListener: () => {},
      }));
      serveAssistant();
      await startTalking();

      narrow = true;
      act(() => listeners.forEach((listener) => listener()));

      expect(within(panel()).getByRole("button", { name: "End" })).toBeVisible();
    });
  });
});

// ── The rest of Release 1 ───────────────────────────────────────────────────

const ESTIMATE = makeEstimate({
  id: "est-1",
  identifier: "CLM-4471",
  project_name: "Hendricks roof",
  client_name: "Acme Insurance",
  created_by: OWNER.id,
});

/** The whole shell, with the real pages a proposal can be staged on. */
function renderApp(route: string) {
  return renderWithProviders(
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/estimates" element={<EstimatesListPage />} />
        <Route path="/estimates/:estimateId" element={<EstimateEditorPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
      </Route>
    </Routes>,
    { user: OWNER, route },
  );
}

async function startTalkingOn(route: string) {
  const view = renderApp(route);
  await view.user.click(await screen.findByRole("button", { name: "Ask BuildCo Assistant" }));
  await view.user.click(screen.getByRole("button", { name: "Start talking" }));
  await waitFor(() => expect(fakes.sockets).toHaveLength(1));
  receive(READY);
  return view;
}

function proposal(kind: string, overrides: Partial<Proposal>): Proposal {
  return {
    id: `p-${kind}`,
    kind,
    summary: "I am about to do that.",
    payload: {},
    labels: {},
    warnings: [],
    approval: "voice_or_click",
    expires_at: "2026-10-14T22:00:00Z",
    ...overrides,
  };
}

const acks = () => sentOf("ui_ack");

describe("the day's allowance", () => {
  it("says how much of today is left before a conversation starts", async () => {
    serveAssistant();
    const { user } = renderShell();

    await user.click(await screen.findByRole("button", { name: "Ask BuildCo Assistant" }));

    expect(await within(panel()).findByText("10 of 10 minutes left today")).toBeVisible();
  });

  it("will not start once today's time is used, and says when there will be more", async () => {
    serveAssistant(true, 0);
    const { user } = renderShell();

    await user.click(await screen.findByRole("button", { name: "Ask BuildCo Assistant" }));

    expect(await within(panel()).findByText("You have used today's 10 minutes.")).toBeVisible();
    expect(within(panel()).getByText(/More is available at/)).toBeVisible();
    expect(status()).toHaveTextContent(/^Back at /);
    // There is nothing to start one with, by voice or by typing.
    expect(within(panel()).queryByRole("button", { name: "Start talking" })).not.toBeInTheDocument();
    expect(within(panel()).getByRole("textbox", { name: "Message the assistant" })).toBeDisabled();
  });

  it("counts down once less than two minutes are left", async () => {
    serveAssistant();
    await startTalking();
    expect(within(panel()).queryByRole("timer")).not.toBeInTheDocument();

    receive({ ...READY, limits: { max_session_seconds: 1800, remaining_seconds: 90 } });

    expect(within(panel()).getByRole("timer", { name: "Time left today" })).toHaveTextContent(
      "1:30",
    );
  });

  it("says so when the conversation ended because the time ran out", async () => {
    serveAssistant();
    await startTalking();

    receive({ type: "ended", reason: "time_limit", detail: "allowance" });

    expect(
      within(panel()).getByText(/time with the assistant has been used, so the conversation ended/),
    ).toBeVisible();
  });

  it("leaves Approve working when the time runs out with something waiting", async () => {
    serveAssistant();
    await startTalking();
    stage();
    receive({ type: "proposal", ...PROPOSAL });

    receive({ type: "audio", state: "paused", reason: "allowance" });

    expect(within(panel()).getByText(/You can still approve or reject/)).toBeVisible();
    expect(within(panel()).getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(within(panel()).getByRole("textbox", { name: "Message the assistant" })).toBeDisabled();
    expect(within(panel()).queryByRole("button", { name: "Tap to talk" })).not.toBeInTheDocument();
  });
});

describe("waiting for an approval", () => {
  it("stops sending the microphone when paused, and Tap to talk asks for it back", async () => {
    serveAssistant();
    await startTalking();
    const microphone = device().options.onMicrophone;
    microphone(new ArrayBuffer(4));
    expect(socket().audio).toBe(1);

    receive({ type: "audio", state: "paused", reason: "approval" });
    microphone(new ArrayBuffer(4));

    expect(socket().audio).toBe(1);
    expect(status()).toHaveTextContent("Microphone paused");

    await userEvent.click(within(panel()).getByRole("button", { name: "Tap to talk" }));
    expect(sentOf("resume")).toHaveLength(1);
    // Nothing more goes up until the server says the audio is live again.
    microphone(new ArrayBuffer(4));
    expect(socket().audio).toBe(1);

    receive({ type: "audio", state: "live" });
    microphone(new ArrayBuffer(4));
    expect(socket().audio).toBe(2);
    expect(within(panel()).queryByRole("button", { name: "Tap to talk" })).not.toBeInTheDocument();
  });

  it("turns a voice approval into a click when the server sends the card again", async () => {
    serveAssistant();
    await startTalking();
    const open: Proposal = { ...PROPOSAL, approval: "voice_or_click" };
    stage(open);
    receive({ type: "proposal", ...open });
    expect(within(panel()).getByText(/Say yes once you have heard it/)).toBeVisible();

    receive({ type: "proposal", ...open, approval: "click" });

    expect(within(panel()).getByText(/Needs a click\. Saying yes will not approve it/)).toBeVisible();
    expect(within(panel()).queryByText(/Say yes/)).not.toBeInTheDocument();
    expect(within(panel()).getAllByRole("region", { name: "Waiting for your approval" })).toHaveLength(1);
  });
});

describe("what it remembers", () => {
  it("is announced in the panel, and can be undone", async () => {
    serveAssistant();
    const deleted: string[] = [];
    server.use(
      http.delete(url("/agent/memories/:id"), ({ params }) => {
        deleted.push(String(params.id));
        return HttpResponse.json({ success: true });
      }),
    );
    await startTalking();

    receive({
      type: "memory",
      event: "remembered",
      memory: { id: "m-1", category: "identity", content: "Prefers to be called Sam" },
    });

    expect(within(panel()).getByText(/Prefers to be called Sam/)).toBeVisible();
    await userEvent.click(within(panel()).getByRole("button", { name: "Undo" }));

    await waitFor(() => expect(deleted).toEqual(["m-1"]));
    await waitFor(() =>
      expect(within(panel()).queryByText(/Prefers to be called Sam/)).not.toBeInTheDocument(),
    );
  });
});

describe("being shown a page", () => {
  it("goes there without locking the app, and says it did", async () => {
    serveAssistant();
    await startTalking();

    receive({ type: "ui", directive_id: "d-nav", action: "navigate", to: "/calendar?on=2026-10-14" });

    expect(await screen.findByRole("button", { name: /New meeting/i })).toBeVisible();
    expect(acks()).toEqual([{ type: "ui_ack", directive_id: "d-nav", ok: true }]);
    expect(appColumn()).not.toHaveAttribute("inert");
  });

  it("answers at once that a supplement is saved when its editor is not open", async () => {
    serveAssistant();
    await startTalking();

    receive({ type: "ui", directive_id: "d-prep", action: "prepare", supplement_id: "est-1" });

    await waitFor(() =>
      expect(acks()).toEqual([{ type: "ui_ack", directive_id: "d-prep", ok: true }]),
    );
  });
});

describe("a dropped connection", () => {
  function serveReconnect(answer: () => Response | Promise<Response>) {
    let attempts = 0;
    server.use(
      http.post(url("/agent/sessions/c-1/reconnect"), () => {
        attempts += 1;
        return answer();
      }),
    );
    return () => attempts;
  }

  it("gets the same conversation back, with what was said still there", async () => {
    serveAssistant();
    serveReconnect(() =>
      HttpResponse.json({
        conversation_id: "c-1",
        ws_url: "ws://agent.test/api/v1/agent/live",
        ticket: "second-ticket",
        limits: { max_session_seconds: 1800, remaining_seconds: 500 },
      }),
    );
    await startTalking();
    receive({ type: "transcript", role: "user", text: "Book the walkthrough.", final: true });

    act(() => socket().handlers.onClose(1006));

    expect(status()).toHaveTextContent(/Reconnecting/);
    await waitFor(() => expect(fakes.sockets).toHaveLength(2));
    expect(socket().url).toContain("ticket=second-ticket");
    // The microphone and speaker were never let go of.
    expect(fakes.audio).toHaveLength(1);
    expect(device().calls).not.toContain("close");

    receive({ ...READY, resumed: true });

    expect(within(panel()).queryByText(/Reconnecting/)).not.toBeInTheDocument();
    expect(within(panel()).getByText("Book the walkthrough.")).toBeVisible();
    expect(within(panel()).getByRole("button", { name: "End" })).toBeVisible();
  });

  it("learns what became of the last action when the conversation is over", async () => {
    serveAssistant();
    serveReconnect(() =>
      apiError(409, "conflict", "That conversation has ended."),
    );
    server.use(
      http.get(url("/agent/conversations/c-1"), () =>
        HttpResponse.json({
          id: "c-1",
          status: "ended",
          title: "Book the walkthrough.",
          started_at: "2026-10-14T20:00:00Z",
          ended_at: "2026-10-14T20:05:00Z",
          end_reason: "disconnected",
          transcript_expired: false,
          messages: [],
          actions: [
            {
              id: "p-1",
              kind: "meeting.create",
              status: "committed",
              summary: PROPOSAL.summary,
              approval_policy: "click",
              approved_via: "click",
              result: { type: "meeting", id: "m-9" },
              error: null,
              created_at: "2026-10-14T20:01:00Z",
              resolved_at: "2026-10-14T20:02:00Z",
            },
          ],
        }),
      ),
    );
    await startTalking();
    stage();
    receive({ type: "proposal", ...PROPOSAL });
    await userEvent.click(within(panel()).getByRole("button", { name: "Approve" }));

    // The commit finished on the server. The frame that said so went with the socket.
    act(() => socket().handlers.onClose(1006));

    expect(await within(panel()).findByText("The connection was lost.")).toBeVisible();
    expect(within(within(panel()).getByRole("article")).getByText("Saved")).toBeVisible();
    expect(
      within(panel()).queryByRole("region", { name: "Waiting for your approval" }),
    ).not.toBeInTheDocument();
    expect(fakes.sockets).toHaveLength(1);
  });

  it("does not try again for a socket the server refused outright", async () => {
    serveAssistant();
    const attempts = serveReconnect(() => HttpResponse.json({}, { status: 500 }));
    renderShell();
    await userEvent.click(await screen.findByRole("button", { name: "Ask BuildCo Assistant" }));
    await userEvent.click(screen.getByRole("button", { name: "Start talking" }));
    await waitFor(() => expect(fakes.sockets).toHaveLength(1));

    act(() => socket().handlers.onClose(4401));

    expect(await within(panel()).findByText(/That session could not be opened/)).toBeVisible();
    expect(attempts()).toBe(0);
  });
});

describe("past conversations", () => {
  function serveHistory() {
    server.use(
      http.get(url("/agent/conversations"), () =>
        HttpResponse.json({
          total: 2,
          limit: 20,
          offset: 0,
          items: [
            {
              id: "c-new",
              status: "ended",
              title: "Book the Hendricks walkthrough",
              started_at: "2026-10-14T20:00:00Z",
              ended_at: "2026-10-14T20:03:00Z",
              end_reason: "user_closed",
              duration_seconds: 150,
              action_count: 1,
              transcript_expired: false,
            },
            {
              id: "c-old",
              status: "ended",
              title: "",
              started_at: "2026-06-01T20:00:00Z",
              ended_at: "2026-06-01T20:03:00Z",
              end_reason: "user_closed",
              duration_seconds: 40,
              action_count: 2,
              transcript_expired: true,
            },
          ],
        }),
      ),
      http.get(url("/agent/conversations/c-new"), () =>
        HttpResponse.json({
          id: "c-new",
          status: "ended",
          title: "Book the Hendricks walkthrough",
          started_at: "2026-10-14T20:00:00Z",
          ended_at: "2026-10-14T20:03:00Z",
          end_reason: "user_closed",
          transcript_expired: false,
          messages: [
            {
              seq: 1,
              role: "user",
              source: "voice",
              text: "Book the Hendricks walkthrough",
              created_at: "2026-10-14T20:00:05Z",
            },
            {
              seq: 2,
              role: "assistant",
              source: "voice",
              text: "It is saved.",
              created_at: "2026-10-14T20:02:00Z",
            },
          ],
          actions: [
            {
              id: "a-1",
              kind: "supplement.create",
              status: "committed",
              summary: "I am about to create a supplement for Hendricks roof.",
              approval_policy: "voice_or_click",
              approved_via: "voice",
              result: { type: "supplement", id: "est-1" },
              error: null,
              created_at: "2026-10-14T20:01:00Z",
              resolved_at: "2026-10-14T20:01:30Z",
            },
          ],
        }),
      ),
    );
  }

  it("are listed in the idle panel, with how long each was and what it saved", async () => {
    serveAssistant();
    serveHistory();
    const { user } = renderShell();

    await user.click(await screen.findByRole("button", { name: "Ask BuildCo Assistant" }));

    const list = await within(panel()).findByRole("region", { name: "Recent conversations" });
    expect(within(list).getByText("Book the Hendricks walkthrough")).toBeVisible();
    expect(within(list).getByText("1 saved")).toBeVisible();
    expect(within(list).getByText(/2 min of voice/)).toBeVisible();
    // After 90 days the words are gone and the record of what was done is not.
    expect(within(list).getByText("Transcript expired")).toBeVisible();
    expect(within(list).getByText("2 saved")).toBeVisible();
    expect(within(list).getByText(/40 s of voice/)).toBeVisible();

    // The same rows, all of them and by day, behind one button.
    await user.click(within(list).getByRole("button", { name: "All conversations" }));
    const all = await within(panel()).findByRole("region", { name: "Past conversations" });
    expect(within(all).getByText("Book the Hendricks walkthrough")).toBeVisible();
    expect(within(all).getAllByRole("heading").length).toBeGreaterThan(1);
  });

  it("open read-only, with what was done shown where it happened and a link to it", async () => {
    serveAssistant();
    serveHistory();
    const { user } = renderShell();
    await user.click(await screen.findByRole("button", { name: "Ask BuildCo Assistant" }));

    await user.click(await within(panel()).findByText("Book the Hendricks walkthrough"));

    const record = await within(panel()).findByRole("region", { name: "Past conversation" });
    expect(await within(record).findByText("It is saved.")).toBeVisible();
    // What was done is a receipt, the same one a live conversation leaves.
    const action = within(record).getByRole("article");
    expect(within(action).getByText("New supplement")).toBeVisible();
    expect(within(action).getByText("Saved")).toBeVisible();
    expect(within(action).getByText("Approved by voice")).toBeVisible();
    expect(within(action).getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      "/estimates/est-1",
    );
    // There is nothing here to carry the conversation on with.
    expect(within(record).queryByRole("textbox")).not.toBeInTheDocument();

    await user.click(within(record).getByRole("button", { name: "Back to past conversations" }));
    expect(await within(panel()).findByRole("region", { name: "Past conversations" })).toBeVisible();
    await user.click(within(panel()).getByRole("button", { name: "Back to the assistant" }));
    expect(await within(panel()).findByRole("button", { name: "Start talking" })).toBeVisible();
  });
});

describe("a new supplement", () => {
  const CREATE = proposal("supplement.create", {
    summary: "I am about to create a supplement for Hendricks roof.",
    payload: {
      project_name: "Hendricks roof",
      client_name: "Acme Insurance",
      identifier: null,
      pm_name: "Dana Reyes",
      insurance_carrier: "",
      notes: "",
      rooms: [],
    },
    labels: { route: "/estimates" },
  });

  it("is staged on the real form, with everything that would be saved on screen", async () => {
    serveAssistant();
    await startTalkingOn("/calendar");

    stage(CREATE);

    const form = await screen.findByRole("dialog", { name: "New estimate" });
    expect(within(form).getByLabelText(/Project name/)).toHaveValue("Hendricks roof");
    expect(within(form).getByLabelText(/Client name/)).toHaveValue("Acme Insurance");
    // The form has no field for a project manager. It is still part of what is saved.
    expect(within(form).getByText("Project manager")).toBeVisible();
    expect(within(form).getByText("Dana Reyes")).toBeVisible();
    expect(appColumn()).toHaveAttribute("inert");
    await waitFor(() => expect(acks()[0]).toMatchObject({ ok: true }));
  });

  it("becomes an ordinary form after Stop, and saves the lot when the user creates it", async () => {
    serveAssistant();
    const created: Record<string, unknown>[] = [];
    server.use(
      http.post(url("/estimates"), async ({ request }) => {
        created.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(ESTIMATE, { status: 201 });
      }),
    );
    const { user } = await startTalkingOn("/calendar");
    stage(CREATE);
    await screen.findByRole("dialog", { name: "New estimate" });

    receive(
      { type: "proposal_result", id: CREATE.id, status: "handed_over" },
      { type: "mode", mode: "conversing" },
    );

    expect(appColumn()).not.toHaveAttribute("inert");
    const form = await screen.findByRole("dialog", { name: "New estimate" });
    await user.clear(within(form).getByLabelText(/Client name/));
    await user.type(within(form).getByLabelText(/Client name/), "Beacon Mutual");
    await user.click(within(form).getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(created).toEqual([
        { project_name: "Hendricks roof", client_name: "Beacon Mutual", pm_name: "Dana Reyes" },
      ]),
    );
  });
});

describe("a change to an open supplement", () => {
  function serveSupplement(initial = ESTIMATE) {
    let current = initial;
    const patches: Record<string, unknown>[] = [];
    let failSaves = false;
    server.use(
      http.get(url("/estimates/:id"), () => HttpResponse.json(current)),
      http.patch(url("/estimates/:id"), async ({ request }) => {
        if (failSaves) return apiError(409, "conflict", "Nope.");
        const body = (await request.json()) as Record<string, unknown>;
        patches.push(body);
        current = { ...current, ...body } as typeof current;
        return HttpResponse.json(current);
      }),
    );
    return {
      patches,
      becomes: (next: Partial<typeof ESTIMATE>) => {
        current = { ...current, ...next };
      },
      failSaves: () => {
        failSaves = true;
      },
    };
  }

  const onEditor = (kind: string, overrides: Partial<Proposal>) =>
    proposal(kind, { ...overrides, labels: { route: "/estimates/est-1", ...overrides.labels } });

  async function openEditor() {
    const view = await startTalkingOn("/estimates/est-1?tab=details");
    await screen.findByLabelText(/Client name/);
    return view;
  }

  it("tells the assistant which supplement is open, so that this one means it", async () => {
    serveAssistant();
    serveSupplement();
    await openEditor();

    await waitFor(() =>
      expect(sentOf("context").at(-1)).toMatchObject({
        route: "/estimates/est-1",
        entity: { type: "supplement", id: "est-1", label: "Hendricks roof" },
      }),
    );
  });

  it("stages a status change as a confirmation nobody presses", async () => {
    serveAssistant();
    serveSupplement();
    await openEditor();

    stage(
      onEditor("supplement.transition", {
        summary: "I am about to archive the supplement Hendricks roof, claim ID CLM-4471.",
        payload: { supplement_id: "est-1", action: "archive" },
        labels: { action: "archive", action_label: "Archive" },
      }),
    );

    const confirm = await screen.findByRole("dialog", { name: "Archive this supplement?" });
    expect(within(confirm).getByText(/I am about to archive the supplement/)).toBeVisible();
    expect(appColumn()).toContainElement(confirm);
    expect(appColumn()).toHaveAttribute("inert");
    await waitFor(() => expect(acks().at(-1)).toMatchObject({ ok: true }));
  });

  it("stages changed details as what they are now and what they would become", async () => {
    serveAssistant();
    serveSupplement();
    await openEditor();

    stage(
      onEditor("supplement.update_details", {
        payload: { supplement_id: "est-1", changes: { client_name: "Beacon Mutual" } },
        labels: {
          changes: [
            { field: "client_name", label: "Client", old: "Acme Insurance", new: "Beacon Mutual" },
          ],
        },
      }),
    );

    const card = await screen.findByRole("dialog", { name: "Change details" });
    const row = within(card).getByRole("row", { name: /Client/ });
    expect(within(row).getByText("Acme Insurance")).toBeVisible();
    expect(within(row).getByText("Beacon Mutual")).toBeVisible();
    // The editor's own field is untouched until the change is approved and saved.
    expect(screen.getByLabelText(/Client name/)).toHaveValue("Acme Insurance");
  });

  it("does not stage a proposal about a different supplement on this one", async () => {
    serveAssistant();
    serveSupplement();
    await openEditor();

    stage(
      onEditor("supplement.transition", {
        payload: { supplement_id: "est-other", action: "archive" },
        labels: { action_label: "Archive" },
      }),
    );

    await waitFor(() => expect(acks().at(-1)).toMatchObject({ ok: false }), { timeout: 6000 });
    expect(screen.queryByRole("dialog", { name: "Archive this supplement?" })).not.toBeInTheDocument();
  }, 10_000);

  it("saves what the user has typed before anything is proposed against it", async () => {
    serveAssistant();
    const supplement = serveSupplement();
    const { user } = await openEditor();
    await user.clear(screen.getByLabelText(/Client name/));
    await user.type(screen.getByLabelText(/Client name/), "Typed by hand");

    receive({ type: "ui", directive_id: "d-prep", action: "prepare", supplement_id: "est-1" });

    await waitFor(() =>
      expect(acks()).toContainEqual({ type: "ui_ack", directive_id: "d-prep", ok: true }),
    );
    expect(supplement.patches.at(-1)).toMatchObject({ client_name: "Typed by hand" });
  });

  it("says so when what the user typed could not be saved", async () => {
    serveAssistant();
    const supplement = serveSupplement();
    supplement.failSaves();
    const { user } = await openEditor();
    await user.type(screen.getByLabelText(/Client name/), " more");

    receive({ type: "ui", directive_id: "d-prep", action: "prepare", supplement_id: "est-1" });

    await waitFor(() => expect(acks().at(-1)).toMatchObject({ directive_id: "d-prep", ok: false }));
    expect(acks().at(-1)?.reason).toMatch(/could not be saved/);
  });

  it("takes the saved values in after a commit, so the next keystroke does not undo them", async () => {
    serveAssistant();
    const supplement = serveSupplement();
    const { user } = await openEditor();
    const change = onEditor("supplement.update_details", {
      payload: { supplement_id: "est-1", changes: { client_name: "Beacon Mutual" } },
      labels: {
        changes: [
          { field: "client_name", label: "Client", old: "Acme Insurance", new: "Beacon Mutual" },
        ],
      },
    });
    stage(change);
    await screen.findByRole("dialog", { name: "Change details" });

    // Approved and committed on the server, which now holds the new client.
    supplement.becomes({ client_name: "Beacon Mutual" });
    receive(
      { type: "proposal_result", id: change.id, status: "committed", target: { type: "supplement", id: "est-1" } },
      { type: "ui", directive_id: "d-r", action: "refresh", keys: ["estimates"], target: { type: "supplement", id: "est-1" } },
      { type: "ui", directive_id: "d-u", action: "unstage" },
      { type: "mode", mode: "conversing" },
    );

    await waitFor(() => expect(screen.getByLabelText(/Client name/)).toHaveValue("Beacon Mutual"));
    // The sequence that used to lose it: commit, then type somewhere else.
    await user.type(screen.getByLabelText(/Insurance carrier/i), "X");
    // The autosave waits for a pause in typing before it goes.
    await waitFor(() => expect(supplement.patches.length).toBeGreaterThan(0), { timeout: 6000 });
    expect(supplement.patches.at(-1)).toMatchObject({ client_name: "Beacon Mutual" });
  }, 12_000);
});

// ── The Experience release: how it looks, where that needs the real shell ───────────

describe("the look, in the real shell", () => {
  it("puts the launcher in the corner as one button, and brings it back with focus", async () => {
    serveAssistant();
    const { user } = renderShell();

    const launcher = await screen.findByRole("button", { name: "Ask BuildCo Assistant" });
    expect(launcher).toHaveClass("ast-launcher");
    await user.click(launcher);
    // Opening moves focus to the panel's title, never to something that acts.
    expect(within(panel()).getByRole("heading", { name: "BuildCo Assistant" })).toHaveFocus();

    await user.click(within(panel()).getByRole("button", { name: "Close assistant" }));
    expect(await screen.findByRole("button", { name: "Ask BuildCo Assistant" })).toHaveFocus();
  });

  it("has Stop once in the panel and once over the app, and nowhere else", async () => {
    serveAssistant();
    await startTalking();
    stage();
    await screen.findByRole("dialog", { name: "New meeting" });
    receive({ type: "proposal", ...PROPOSAL });

    const banner = document.querySelector("[data-app-lock]") as HTMLElement;
    expect(within(banner).getAllByRole("button", { name: "Stop" })).toHaveLength(1);
    expect(within(panel()).getAllByRole("button", { name: "Stop" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Stop" })).toHaveLength(2);
  });

  it("answers a click on the locked app, where it used to do nothing", async () => {
    serveAssistant();
    const { user } = await startTalking();
    stage();
    await screen.findByRole("dialog", { name: "New meeting" });
    const lock = document.querySelector("[data-app-lock]") as HTMLElement;
    expect(within(lock).queryByText("Press Stop to take over")).not.toBeInTheDocument();

    await user.click(lock);

    expect(within(lock).getByText("Press Stop to take over")).toBeVisible();
    // It says how to take over. It does not take over.
    expect(sentOf("stop")).toEqual([]);
    expect(appColumn()).toHaveAttribute("inert");
  });

  it("shows no example text on a staged meeting, and shows it again once the form is the user's", async () => {
    serveAssistant();
    await startTalking();

    stage({ ...PROPOSAL, payload: { ...PROPOSAL.payload, location: "" } });

    const staged = await screen.findByRole("dialog", { name: "New meeting" });
    // An empty Location is empty. "12 Oak Street" there would read as a value.
    expect(within(staged).getByLabelText("Location")).toHaveValue("");
    expect(within(staged).getByLabelText("Location")).not.toHaveAttribute("placeholder");
    expect(within(staged).getByLabelText(/^Title/)).not.toHaveAttribute("placeholder");
    // What it filled in is marked; what it left empty is not.
    expect(within(staged).getByLabelText(/^Title/).closest("[data-staged-fill]")).not.toBeNull();
    expect(within(staged).getByLabelText("Location").closest("[data-staged-fill]")).toBeNull();

    receive(
      { type: "proposal_result", id: "p-1", status: "handed_over" },
      { type: "mode", mode: "conversing" },
    );

    const own = await screen.findByRole("dialog", { name: "New meeting" });
    expect(within(own).getByLabelText("Location")).toHaveAttribute("placeholder", "12 Oak Street");
    expect(own.querySelector("[data-staged-fill]")).toBeNull();
  });

  it("shows no example text on a staged supplement either", async () => {
    serveAssistant();
    await startTalkingOn("/calendar");
    const create = proposal("supplement.create", {
      payload: {
        project_name: "Hendricks roof",
        client_name: "",
        identifier: null,
        pm_name: "",
        insurance_carrier: "",
        notes: "",
        rooms: [],
      },
      labels: { route: "/estimates" },
    });

    stage(create);

    const staged = await screen.findByRole("dialog", { name: "New estimate" });
    for (const label of [/Project name/, /Client name/, /Claim ID/]) {
      expect(within(staged).getByLabelText(label)).not.toHaveAttribute("placeholder");
    }
    expect(within(staged).getByLabelText(/Client name/)).toHaveValue("");

    receive(
      { type: "proposal_result", id: create.id, status: "handed_over" },
      { type: "mode", mode: "conversing" },
    );

    const own = await screen.findByRole("dialog", { name: "New estimate" });
    expect(within(own).getByLabelText(/Client name/)).toHaveAttribute("placeholder", "Acme Insurance");
  });

  it("reports the read-back as played exactly as before, however the turn is drawn", async () => {
    serveAssistant();
    await startTalking();
    stage();
    receive({ type: "proposal", ...PROPOSAL });
    receive(
      { type: "transcript", role: "assistant", text: PROPOSAL.summary, final: true },
      { type: "turn_complete", spoke: true, readback_for: "p-1" },
    );

    // Drawn clamped, under its label, with the card holding the full statement.
    const log = within(within(panel()).getByRole("log", { name: "Conversation" }));
    expect(log.getByText("Read-back")).toBeVisible();
    expect(sentOf("readback_played")).toEqual([]);

    act(() => device().options.onPlayed("p-1"));
    expect(sentOf("readback_played")).toEqual([{ type: "readback_played", proposal_id: "p-1" }]);
  });

  it("keeps a receipt for each change a conversation saves", async () => {
    serveAssistant();
    await startTalking();

    for (const id of ["p-1", "p-2", "p-3"]) {
      receive(
        { type: "proposal", ...PROPOSAL, id },
        { type: "proposal_result", id, status: "committed", target: { type: "meeting", id } },
      );
    }

    expect(within(panel()).getAllByRole("article")).toHaveLength(3);
  });
});
