/**
 * The gallery: BuildCo Assistant in every state, side by side, in light and dark.
 *
 * This is how the look is reviewed. "Modern and finished" is a judgement, and it is made
 * here on the real components, in the real app, without holding a conversation: the
 * reducer is pure, so each state is a list of frames (`galleryFixtures.ts`).
 *
 * Two parts:
 *
 * - **The grid** (`/dev/assistant`): the orb in every state and size, and the panel in
 *   every state of the design's table, each with a control to replay how it arrives.
 * - **The stage** (`/dev/assistant?scene=stage`): the whole frame, with the launcher, the
 *   card, the lock and a staged form, and a strip of buttons that send the frames a
 *   server would. That is where the movements that happen *between* states are watched:
 *   the card opening, the orb travelling, the lock, a form filling, and the moment a
 *   change is saved.
 *
 * Development only. The route is not registered in a production build, so none of this
 * is shipped.
 */
import { useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { queryKeys } from "@/api/queries/keys";
import { AppFrame } from "@/components/AppFrame";
import { Button } from "@/components/Button";
import { Field, Input, TextField, Textarea } from "@/components/form";
import { Modal } from "@/components/Modal";
import { StagedMark } from "@/components/staged";
import { AgentLauncher, AgentLockBanner } from "./AgentLauncher";
import { AgentPanel } from "./AgentPanel";
import { AgentPreview, type AgentContextValue } from "./AgentProvider";
import { agentReducer, initialState, isLocked, type AgentAction, type AgentState } from "./agentState";
import {
  DETAILS,
  EVERY_RECEIPT,
  HISTORY,
  LOCK,
  MEETING,
  MEETING_WITH_FACTS,
  MEMORY,
  PAST,
  READY,
  SAVED,
  SUBMIT,
  TALK,
  VOICE_MEETING,
  WORKING,
  previewOf,
  proposing,
  stateFrom,
} from "./galleryFixtures";
import { createLevels } from "./levels";
import { Orb, type OrbSize, type OrbState } from "./Orb";
import type { ServerFrame } from "./protocol";
import { usePhoneLayout } from "./useLauncherShown";
import { usePresence } from "./usePresence";

const ORB_STATES: { state: OrbState; label: string }[] = [
  { state: "resting", label: "Resting" },
  { state: "connecting", label: "Connecting" },
  { state: "listening", label: "Listening" },
  { state: "thinking", label: "Thinking" },
  { state: "speaking", label: "Speaking" },
  { state: "working", label: "Working" },
  { state: "waiting", label: "Waiting for you" },
  { state: "paused", label: "Microphone paused" },
  { state: "muted", label: "Muted" },
  { state: "reconnecting", label: "Reconnecting" },
  { state: "spent", label: "Time used" },
];
const ORB_SIZES: OrbSize[] = [96, 56, 32, 20];

function act(state: AgentState, ...actions: AgentAction[]): AgentState {
  return actions.reduce(agentReducer, state);
}

interface Sample {
  title: string;
  note?: string;
  state: AgentState;
  over?: Partial<AgentContextValue>;
  /** Something to move the orb with: a microphone, or the assistant's voice. */
  sound?: "mic" | "voice";
  history?: string | null;
}

const afterTalk = stateFrom([
  ...TALK,
  { type: "transcript", role: "assistant", text: "Done. Anything else?", final: true },
  { type: "turn_complete", spoke: true, readback_for: null },
]);
const voiceOpen = act(stateFrom(proposing(VOICE_MEETING)), {
  type: "readback_played",
  id: VOICE_MEETING.id,
});
const ended = act(
  stateFrom(SAVED),
  ...Array.from({ length: 90 }, (): AgentAction => ({ type: "tick" })),
  { type: "frame", frame: { type: "ended", reason: "user_closed" } },
);

const SECTIONS: { title: string; samples: Sample[] }[] = [
  {
    title: "Before anything is said",
    samples: [
      { title: "Idle", state: initialState },
      {
        title: "Allowance used",
        state: initialState,
        over: { remainingToday: 0 },
      },
      { title: "Connecting", note: "After four seconds: Waking the assistant…", state: stateFrom([]) },
      { title: "Live, nothing said", state: stateFrom([READY]), sound: "mic" },
    ],
  },
  {
    title: "Conversing",
    samples: [
      { title: "Listening", state: afterTalk, sound: "mic" },
      { title: "Thinking", state: stateFrom(TALK) },
      {
        title: "Speaking",
        state: stateFrom([
          ...TALK,
          { type: "transcript", role: "assistant", text: "Sure. I will add j.smith at acme dot com and ", final: false },
        ]),
        sound: "voice",
      },
      { title: "Muted", state: act(afterTalk, { type: "mute", muted: true }) },
      {
        title: "Started by typing",
        note: "No microphone, so no microphone button and nothing to be listening with.",
        state: stateFrom(
          [
            READY,
            { type: "transcript", role: "assistant", text: "Hello. What would you like to do?", final: true },
            { type: "turn_complete", spoke: true, readback_for: null },
            { type: "notice", kind: "idle_warning" },
          ],
          false,
        ),
      },
      { title: "Every receipt, a notice and a memory", state: stateFrom(EVERY_RECEIPT), sound: "mic" },
    ],
  },
  {
    title: "Working, and waiting for approval",
    samples: [
      { title: "Working", state: stateFrom(WORKING) },
      {
        title: "Click only, reason not sent",
        note: "As it is today: the facts come from the labels the proposal already carries.",
        state: stateFrom(proposing(MEETING)),
      },
      {
        title: "Click only, sends email",
        note: "Once the server sends labels.facts and approval_reason.",
        state: stateFrom(proposing(MEETING_WITH_FACTS)),
      },
      {
        title: "Reading it back",
        state: stateFrom([
          ...proposing(VOICE_MEETING, false),
          { type: "transcript", role: "assistant", text: "I am about to create the meeting Site visit on ", final: false },
        ]),
        sound: "voice",
      },
      { title: "Voice or click, answer window open", state: voiceOpen, sound: "mic" },
      {
        title: "Microphone paused",
        state: act(voiceOpen, { type: "frame", frame: { type: "audio", state: "paused", reason: "approval" } }),
      },
      { title: "Click only, changes who can edit", state: stateFrom(proposing(LOCK)) },
      {
        title: "Click only, read-back not verified, expiring",
        state: stateFrom(proposing(SUBMIT)),
      },
      { title: "An edit: old above new", state: stateFrom(proposing(DETAILS)) },
      { title: "A memory", state: stateFrom(proposing(MEMORY)) },
      {
        title: "Allowance ran out, proposal open",
        state: act(stateFrom(proposing(MEETING)), {
          type: "frame",
          frame: { type: "audio", state: "paused", reason: "allowance" },
        }),
      },
      {
        title: "Reconnecting",
        state: act(stateFrom(proposing(MEETING)), { type: "reconnecting" }),
      },
    ],
  },
  {
    title: "After",
    samples: [
      { title: "Saved, and carrying on", state: stateFrom(SAVED), sound: "mic" },
      { title: "Ended", state: ended },
      { title: "History", state: initialState, history: null },
      { title: "One past conversation", state: initialState, history: "c-1" },
    ],
  },
];

/** A client that already holds what the history views ask for, and never fetches. */
function useSeededQueries(): QueryClient {
  return useMemo(() => {
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false, refetchOnWindowFocus: false } },
    });
    client.setQueryData(queryKeys.agent.history, HISTORY);
    client.setQueryData(queryKeys.agent.conversation("c-1"), PAST);
    return client;
  }, []);
}

/** Something for the orb to follow: a level that rises and falls like speech. */
function useSound(levels: AgentContextValue["levels"], sound: Sample["sound"]) {
  useEffect(() => {
    if (!sound) return;
    const timer = window.setInterval(() => {
      const level = 0.02 + Math.random() * 0.2 * (0.5 + 0.5 * Math.sin(Date.now() / 400));
      if (sound === "mic") levels.mic(level);
      else levels.voice(level, true);
    }, 60);
    return () => window.clearInterval(timer);
  }, [levels, sound]);
}

function Card({ sample }: { sample: Sample }) {
  const [run, setRun] = useState(0);
  const value = useMemo(() => previewOf(sample.state, sample.over), [sample]);
  useSound(value.levels, sample.sound);

  return (
    <figure className="flex w-[400px] flex-col gap-2">
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold text-gray-900">{sample.title}</span>
        <button
          type="button"
          onClick={() => setRun((count) => count + 1)}
          className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-300"
        >
          Replay
        </button>
      </figcaption>
      <div
        key={run}
        className="ast-card h-[640px] w-[400px] overflow-hidden rounded-2xl border border-gray-200 bg-surface shadow-panel"
      >
        <AgentPreview value={value}>
          <AgentPanel
            firstName="Maria"
            {...(sample.history !== undefined ? { showHistory: sample.history } : {})}
          />
        </AgentPreview>
      </div>
      {sample.note && <p className="text-xs text-gray-500">{sample.note}</p>}
    </figure>
  );
}

function Island({ theme, children }: { theme: "light" | "dark"; children: ReactNode }) {
  return (
    <div data-theme={theme} className="flex-1 bg-canvas px-6 py-8 text-gray-900">
      <p className="mb-6 text-xs font-semibold tracking-wide text-gray-500 uppercase">{theme}</p>
      {children}
    </div>
  );
}

function Orbs() {
  return (
    <div className="flex flex-col gap-5">
      {ORB_STATES.map(({ state, label }) => (
        <div key={state} className="flex items-center gap-6">
          <span className="w-36 shrink-0 text-sm text-gray-600">{label}</span>
          {ORB_SIZES.map((size) => (
            <span key={size} className="grid w-28 shrink-0 place-items-center">
              <Orb size={size} state={state} answering />
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

function Grid() {
  const client = useSeededQueries();

  // Each half sets its own theme. The page's own is put aside while this is open, so
  // the light half is not drawn with the dark half's accent text.
  useEffect(() => {
    const root = document.documentElement;
    const was = root.dataset.theme;
    root.dataset.theme = "light";
    return () => {
      if (was) root.dataset.theme = was;
      else delete root.dataset.theme;
    };
  }, []);

  // The orbs here are outside any card, so they are given a level of their own.
  const [levels] = useState(createLevels);
  const [orbs, setOrbs] = useState<HTMLElement | null>(null);
  useEffect(() => {
    levels.attach(orbs);
    return () => levels.attach(null);
  }, [levels, orbs]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const level = 0.02 + Math.random() * 0.2 * (0.5 + 0.5 * Math.sin(Date.now() / 400));
      levels.mic(level);
      levels.voice(level, true);
    }, 60);
    return () => window.clearInterval(timer);
  }, [levels]);

  const both = (content: ReactNode) => (
    <div className="flex min-w-max">
      <Island theme="light">{content}</Island>
      <Island theme="dark">{content}</Island>
    </div>
  );

  return (
    <QueryClientProvider client={client}>
      <div ref={setOrbs} className="min-h-dvh bg-canvas">
        <header className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-b border-gray-200 bg-surface px-6 py-4">
          <h1 className="text-lg font-semibold text-gray-900">BuildCo Assistant · every state</h1>
          <Link
            to="/dev/assistant?scene=stage"
            className="text-sm font-medium text-brand-700 hover:underline"
          >
            Open the stage: launcher, card, lock, staged form, the saved moment
          </Link>
          <p className="text-sm text-gray-500">
            Turn on “reduce motion” in the system settings to see each state&rsquo;s still form.
          </p>
        </header>

        <h2 className="px-6 pt-8 text-base font-semibold text-gray-900">The orb</h2>
        {both(<Orbs />)}

        {SECTIONS.map((section) => (
          <section key={section.title}>
            <h2 className="px-6 pt-8 text-base font-semibold text-gray-900">{section.title}</h2>
            {both(
              <div className="flex flex-wrap gap-8">
                {section.samples.map((sample) => (
                  <Card key={sample.title} sample={sample} />
                ))}
              </div>,
            )}
          </section>
        ))}
      </div>
    </QueryClientProvider>
  );
}

// ── The stage ─────────────────────────────────────────────────────────────────

const STAGE_STEPS: { label: string; frames: ServerFrame[] }[] = [
  {
    label: "User speaks",
    frames: [{ type: "transcript", role: "user", text: "Set up a site visit with Maria on Thursday at two.", final: true }],
  },
  {
    label: "Assistant speaks",
    frames: [
      { type: "transcript", role: "assistant", text: "Sure. ", final: false },
      { type: "transcript", role: "assistant", text: "Sure. For 45 minutes, as usual?", final: true },
      { type: "turn_complete", spoke: true, readback_for: null },
    ],
  },
  {
    label: "Start working",
    frames: [
      { type: "mode", mode: "working" },
      { type: "step", id: "s1", label: "Open the calendar", status: "active" },
    ],
  },
  {
    label: "Step done, form staged",
    frames: [
      { type: "step", id: "s1", label: "Open the calendar", status: "done" },
      { type: "step", id: "s2", label: "Fill in the meeting", status: "active" },
      { type: "ui", directive_id: "d-1", action: "stage", proposal: VOICE_MEETING },
    ],
  },
  {
    label: "Approval card",
    frames: [
      { type: "step", id: "s2", label: "Fill in the meeting", status: "done" },
      { type: "step", id: "s3", label: "Waiting for your approval", status: "active" },
      { type: "proposal", ...VOICE_MEETING },
      { type: "transcript", role: "assistant", text: VOICE_MEETING.summary, final: true },
      { type: "turn_complete", spoke: true, readback_for: VOICE_MEETING.id },
    ],
  },
  { label: "Voice becomes click", frames: [{ type: "proposal", ...VOICE_MEETING, approval: "click" }] },
  { label: "Pause the microphone", frames: [{ type: "audio", state: "paused", reason: "approval" }] },
  {
    label: "Save fails",
    frames: [
      { type: "proposal_result", id: VOICE_MEETING.id, status: "failed", error: "That time is in the past." },
      { type: "ui", directive_id: "d-2", action: "unstage" },
      { type: "mode", mode: "conversing" },
    ],
  },
  { label: "Expires", frames: [
      { type: "proposal_result", id: VOICE_MEETING.id, status: "expired" },
      { type: "ui", directive_id: "d-2", action: "unstage" },
      { type: "mode", mode: "conversing" },
    ] },
  { label: "Remembers", frames: [{ type: "memory", event: "remembered", memory: { id: "m-1", category: "work_habit", content: "Site visits are usually 45 minutes" } }] },
  { label: "Low time", frames: [{ type: "notice", kind: "allowance_low", seconds: 58 }] },
];

const RESOLVE = (status: "committed" | "cancelled" | "handed_over"): ServerFrame[] => [
  {
    type: "proposal_result",
    id: VOICE_MEETING.id,
    status,
    ...(status === "committed" ? { target: { type: "meeting", id: "m-stage" } } : {}),
  },
  { type: "ui", directive_id: "d-2", action: "unstage" },
  { type: "mode", mode: "conversing" },
];

function Stage() {
  const client = useSeededQueries();
  const [state, dispatch] = useReducer(agentReducer, initialState);
  const [panelOpen, setPanelOpen] = useState(false);
  const [levels] = useState(createLevels);
  const phone = usePhoneLayout();
  const [phoneView, setPhoneView] = useState<"full" | "mini">("full");
  const stagedId = state.staged?.id ?? null;
  useEffect(() => setPhoneView(stagedId ? "mini" : "full"), [stagedId]);
  const send = (...frames: ServerFrame[]) =>
    frames.forEach((frame) => dispatch({ type: "frame", frame }));

  // Something for the orb to follow while a conversation is live.
  useEffect(() => {
    if (state.phase !== "live") return;
    const timer = window.setInterval(
      () => levels.mic(0.02 + Math.random() * 0.2 * (0.5 + 0.5 * Math.sin(Date.now() / 400))),
      60,
    );
    return () => window.clearInterval(timer);
  }, [levels, state.phase]);

  const value: AgentContextValue = {
    ...previewOf(state),
    levels,
    locked: isLocked(state),
    panelOpen,
    phone,
    phoneView,
    setPhoneView,
    openPanel: () => setPanelOpen(true),
    closePanel: () => {
      setPanelOpen(false);
      dispatch({ type: "reset" });
    },
    startVoice: () => {
      dispatch({ type: "start", microphone: true, speakerOn: true });
      window.setTimeout(() => send(READY), 1400);
    },
    sendText: (text) => {
      if (state.phase !== "live") {
        dispatch({ type: "start", microphone: false, speakerOn: true });
        window.setTimeout(() => send(READY), 900);
      }
      dispatch({ type: "typed", text });
    },
    approve: () => window.setTimeout(() => send(...RESOLVE("committed")), 700),
    reject: () => send(...RESOLVE("cancelled")),
    stop: () => send(...RESOLVE("handed_over")),
    resume: () => send({ type: "audio", state: "live" }),
    end: () => send({ type: "ended", reason: "user_closed" }),
    setMuted: (muted) => dispatch({ type: "mute", muted }),
    setSpeaker: (on) => dispatch({ type: "speaker", on }),
    forget: async (id) => dispatch({ type: "forgotten", id }),
  };

  const panel = usePresence(panelOpen);
  const staged = state.staged;

  return (
    <QueryClientProvider client={client}>

        <AgentPreview value={value}>
          <AppFrame
            panel={
              panel.mounted ? (
                <AgentPanel
                  closing={panel.closing}
                  compact={phone && phoneView === "mini"}
                  firstName="Maria"
                />
              ) : undefined
            }
            panelClosing={panel.closing}
            phone={phone}
            phoneView={phoneView}
            launcher={<AgentLauncher hidden={panel.mounted} />}
            locked={value.locked}
            lockBanner={<AgentLockBanner />}
          >
            <header className="sticky top-0 z-30 flex h-13 items-center gap-6 border-b border-gray-200 bg-surface px-6">
              <span className="font-display font-semibold text-gray-900">BuildCo</span>
              <span className="text-sm text-gray-600">Supplements</span>
              <span className="text-sm text-gray-600">Calendar</span>
              <Link to="/dev/assistant" className="ml-auto text-sm text-brand-700 hover:underline">
                Back to every state
              </Link>
            </header>
            <main className="flex-1 px-6 pt-6 pb-[88px]">
              <h1 className="text-2xl font-semibold text-gray-900">Calendar</h1>
              <p className="mt-1 max-w-xl text-sm text-gray-500">
                A stand-in for the app. Open the assistant from the corner, start a
                conversation, then use the strip at the foot to send it what a server would.
              </p>
              <div className="mt-6 grid gap-3 app-sm:grid-cols-2 app-lg:grid-cols-3">
                {Array.from({ length: 9 }, (_, index) => (
                  <div
                    key={index}
                    {...(index === 4 ? { "data-agent-record": "meeting:m-stage" } : {})}
                    className="rounded-card bg-surface p-4 ring-1 ring-gray-200"
                  >
                    <p className="text-sm font-medium text-gray-900">
                      {index === 4 ? "Site visit" : `Meeting ${index + 1}`}
                    </p>
                    <p className="text-xs text-gray-500">Thu 15 Oct, 2:00 PM</p>
                  </div>
                ))}
              </div>
            </main>

            {staged && (
              <Modal open staged title="New meeting" size="lg" onClose={() => {}}>
                <div className="flex flex-col gap-4">
                  <TextField label="Title" required value={String(staged.payload["title"] ?? "")} readOnly placeholder="Site walkthrough" />
                  <div className="grid gap-4 app-sm:grid-cols-3">
                    <Field label="Date">{(props) => <Input {...props} type="date" value="2026-10-15" readOnly />}</Field>
                    <Field label="Start">{(props) => <Input {...props} type="time" value="14:00" readOnly />}</Field>
                    <Field label="End">{(props) => <Input {...props} type="time" value="14:45" readOnly />}</Field>
                  </div>
                  <TextField label="Location" value="" readOnly placeholder="12 Oak Street" />
                  <Field label="Description">{(props) => <Textarea {...props} rows={3} value="" readOnly />}</Field>
                  <div>
                    <p className="text-sm font-medium text-gray-700">Attendees</p>
                    <StagedMark className="mt-1.5">
                      <ul className="flex flex-col gap-1 text-sm text-gray-900">
                        <li>Maria Lopez</li>
                        <li>
                          j.smith@acme.com <span className="text-gray-500">(outside guest)</span>
                        </li>
                      </ul>
                    </StagedMark>
                  </div>
                </div>
              </Modal>
            )}
          </AppFrame>

          {/* Outside the frame, so it can be pressed while the app is locked. */}
          <div className="fixed bottom-3 left-3 z-[60] flex max-w-[calc(100vw-470px)] flex-wrap gap-1.5 rounded-card bg-surface p-2 shadow-float ring-1 ring-gray-200">
            {STAGE_STEPS.map((step) => (
              <Button key={step.label} size="sm" onClick={() => send(...step.frames)}>
                {step.label}
              </Button>
            ))}
            <Button size="sm" onClick={() => dispatch({ type: "readback_played", id: VOICE_MEETING.id })}>
              Read-back played
            </Button>
            <Button size="sm" onClick={() => dispatch({ type: "reconnecting" })}>
              Drop connection
            </Button>
            <Button size="sm" onClick={() => send({ ...READY, resumed: true } as ServerFrame)}>
              Reconnect
            </Button>
            <span className="self-center px-1 text-xs text-gray-500">
              Approve, Reject, Stop and End in the panel work too.
            </span>
          </div>
        </AgentPreview>

    </QueryClientProvider>
  );
}

export function AgentGallery() {
  const [params] = useSearchParams();
  return params.get("scene") === "stage" ? <Stage /> : <Grid />;
}
