/**
 * The assistant in the shell, end to end in the browser's half: launcher, panel, the
 * work-mode lock, and a proposal staged on the real calendar.
 *
 * The socket and the audio device are replaced, because jsdom has neither. Everything
 * else is real: the provider, the reducer, the shell, the frame, the calendar page and
 * its meeting form. The fake socket is driven by handing it the frames the server sends.
 */
import { act, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/AppShell";
import { CalendarPage } from "@/features/calendar/CalendarPage";
import { makeUser } from "@/test/factories";
import { url } from "@/test/msw/handlers";
import { server } from "@/test/msw/server";
import { renderWithProviders } from "@/test/utils";
import type { AudioOptions } from "./audio";
import type { ClientFrame, Proposal, ServerFrame } from "./protocol";
import type { TransportHandlers } from "./transport";

interface FakeSocket {
  url: string;
  handlers: TransportHandlers;
  sent: ClientFrame[];
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
    const socket: FakeSocket = { url: socketUrl, handlers, sent: [], closed: false };
    fakes.sockets.push(socket);
    fakes.order.push("socket");
    queueMicrotask(() => handlers.onOpen());
    return {
      send: (frame: ClientFrame) => socket.sent.push(frame),
      sendAudio: () => {},
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
    attendees: [
      { label: "Sam Member" },
      { label: "adjuster@insurer.example.com", note: "outside guest" },
    ],
  },
  warnings: [],
  approval: "click",
  expires_at: "2026-10-14T22:00:00Z",
};

function serveAssistant(enabled = true) {
  const sessions: Record<string, unknown>[] = [];
  let meetingRequests = 0;
  server.use(
    http.get(url("/agent/status"), () =>
      HttpResponse.json({ enabled, max_session_seconds: 1800 }),
    ),
    http.post(url("/agent/sessions"), async ({ request }) => {
      fakes.order.push("session");
      sessions.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json(
        {
          conversation_id: "c-1",
          ws_url: "ws://agent.test/api/v1/agent/live",
          ticket: "ticket/with+odd=chars",
          limits: { max_session_seconds: 1800 },
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
  limits: { max_session_seconds: 1800 },
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
      expect(launcher).toHaveAttribute("title", "Ask BuildCo Assistant");
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
      expect(within(panel()).getByRole("button", { name: "Speaker on" })).toBeVisible();
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
      expect(within(form).getByText("Filled in by BuildCo Assistant. Not saved yet.")).toBeVisible();
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

    it("says it could not be shown when nothing knows how to stage that kind", async () => {
      serveAssistant();
      await startTalking();

      stage({ ...PROPOSAL, kind: "something.else" });

      await waitFor(() => expect(sentOf("ui_ack")[0]).toMatchObject({ ok: false }));
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
      expect(within(card).getByText(/needs a click/)).toBeVisible();
      expect(within(card).getByText("Sam Member")).toBeVisible();
    });

    it("sends the user's decision, not a result", async () => {
      serveAssistant();
      const { user } = await startTalking();
      stage();
      receive({ type: "proposal", ...PROPOSAL });

      await user.click(within(panel()).getByRole("button", { name: "Approve" }));
      await user.click(within(panel()).getByRole("button", { name: "Reject" }));

      expect(sentOf("approval")).toEqual([
        { type: "approval", proposal_id: "p-1", decision: "approve" },
        { type: "approval", proposal_id: "p-1", decision: "reject" },
      ]);
      // Nothing changed on screen because of the clicks: the server decides the outcome.
      expect(within(panel()).getByRole("region", { name: "Waiting for your approval" })).toBeVisible();
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
      expect(within(panel()).getByText("Saved.")).toBeVisible();
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
      await user.click(within(panel()).getByRole("button", { name: "Speaker on" }));

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

    it("unlocks the app if the connection dies while the assistant is working", async () => {
      serveAssistant();
      await startTalking();
      stage();
      await screen.findByRole("dialog", { name: "New meeting" });
      expect(appColumn()).toHaveAttribute("inert");

      act(() => socket().handlers.onClose(1006));

      expect(appColumn()).not.toHaveAttribute("inert");
      expect(within(panel()).getByText("The connection was lost.")).toBeVisible();
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
