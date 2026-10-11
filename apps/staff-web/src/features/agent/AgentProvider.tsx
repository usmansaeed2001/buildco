/**
 * BuildCo Assistant in the browser: one provider, mounted once in `AppShell` so that the
 * panel and a live conversation survive moving between pages.
 *
 * It owns the two things that have side effects, the socket and the audio, and keeps
 * everything else in `agentReducer`. Both come in through props with real defaults, so a
 * test can run a whole conversation by handing the provider frames.
 *
 * Three behaviours here are not incidental:
 *
 * - **Audio is opened before the network request, inside the click.** A browser only
 *   lets a page start audio in direct response to a user gesture. Asking the server for
 *   a session first would spend that gesture on a fetch, and the conversation would
 *   connect in silence.
 * - **"The read-back finished playing" is reported from the player, not from the frame
 *   that says the turn ended.** The last audio arrives before it is heard. A spoken
 *   approval only counts if it began after the user could have heard the whole summary,
 *   so the report is sent when playback actually reaches that point. An interruption
 *   flushes the player, and with it the pending report.
 * - **Staging is acknowledged by the page that shows the form, not by this provider.**
 *   The server waits to be told the proposal is on screen. Saying so before the calendar
 *   has rendered it would let the agent describe a form the user cannot see.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ApiError } from "@/api/client";
import { createAgentSession, useAgentStatus } from "@/api/queries/agent";
import { queryKeys } from "@/api/queries/keys";
import { localDayKey } from "@/domain/calendar";
import { agentReducer, initialState, type AgentState } from "./agentState";
import { MicrophoneDenied, openAudio, type AgentAudio, type OpenAudio } from "./audio";
import { closeReason, type ClientFrame, type Proposal, type ServerFrame } from "./protocol";
import { connectSocket, type AgentTransport, type Connect } from "./transport";

/** How long a page has to show a staged proposal before the server is told it failed. */
const STAGE_TIMEOUT_MS = 4000;
const SPEAKER_KEY = "buildco.assistant.speaker";

export interface AgentContextValue {
  /** Whether the assistant is offered to this person at all. */
  available: boolean;
  state: AgentState;
  panelOpen: boolean;
  /** 0 to 1, for the microphone meter. */
  micLevel: number;
  openPanel: () => void;
  /** Closing the panel ends the conversation. */
  closePanel: () => void;
  startVoice: () => void;
  /** Sends a typed message, starting a conversation without the microphone if need be. */
  sendText: (text: string) => void;
  approve: () => void;
  reject: () => void;
  /** Leave work mode at once. A staged form becomes the user's to finish. */
  stop: () => void;
  end: () => void;
  setMuted: (muted: boolean) => void;
  setSpeaker: (on: boolean) => void;
  /** For a page: the staged proposal is now on screen. */
  confirmStaged: (proposalId: string) => void;
  /** For a page: it has opened the handed-over proposal as an ordinary form. */
  takeHandover: () => void;
  /** For the shell: what the user is looking at. */
  reportContext: (context: { route: string; dialogOpen: boolean }) => void;
}

const AgentContext = createContext<AgentContextValue | null>(null);

/** Null when there is no provider, which is every screen outside the signed-in shell. */
export function useAgent(): AgentContextValue | null {
  return useContext(AgentContext);
}

/** Where a proposal of each kind is staged. */
function routeFor(proposal: Proposal): string | null {
  if (proposal.kind === "meeting.create") {
    const start = proposal.payload["start_time"];
    // Open the calendar on the day of the meeting, so it is in view once it is saved.
    const day = typeof start === "string" ? localDayKey(new Date(start)) : null;
    return day ? `/calendar?on=${day}` : "/calendar";
  }
  return null;
}

function rememberedSpeaker(): boolean {
  try {
    return localStorage.getItem(SPEAKER_KEY) !== "off";
  } catch {
    return true;
  }
}

export function AgentProvider({
  children,
  connect = connectSocket,
  audio: openAudioDevice = openAudio,
}: {
  children: ReactNode;
  connect?: Connect;
  audio?: OpenAudio;
}) {
  const status = useAgentStatus();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [state, dispatch] = useReducer(agentReducer, initialState, (base) => ({
    ...base,
    speakerOn: rememberedSpeaker(),
  }));
  const [panelOpen, setPanelOpen] = useState(false);
  const [micLevel, setMicLevel] = useState(0);

  const transport = useRef<AgentTransport | null>(null);
  const device = useRef<AgentAudio | null>(null);
  const speakerOn = useRef(state.speakerOn);
  speakerOn.current = state.speakerOn;
  const staging = useRef<{ directiveId: string; proposalId: string; timer: number } | null>(null);
  const context = useRef({ route: "/", dialogOpen: false });
  const levelAt = useRef(0);

  const send = useCallback((frame: ClientFrame) => transport.current?.send(frame), []);

  const answerStage = useCallback(
    (ok: boolean, reason?: string) => {
      const pending = staging.current;
      if (!pending) return;
      window.clearTimeout(pending.timer);
      staging.current = null;
      send({
        type: "ui_ack",
        directive_id: pending.directiveId,
        ok,
        ...(reason ? { reason } : {}),
      });
    },
    [send],
  );

  const release = useCallback(() => {
    if (staging.current) window.clearTimeout(staging.current.timer);
    staging.current = null;
    transport.current?.close();
    transport.current = null;
    device.current?.close();
    device.current = null;
    setMicLevel(0);
  }, []);

  // A conversation does not outlive the shell: signing out or leaving unmounts this.
  useEffect(() => release, [release]);

  const onFrame = useCallback(
    (frame: ServerFrame) => {
      if (frame.type === "interrupted") device.current?.flush();

      if (frame.type === "turn_complete" && frame.readback_for) {
        // With the speaker off nothing plays, so the summary counts as delivered once
        // it is on screen, which it already is.
        if (speakerOn.current) device.current?.mark(frame.readback_for);
        else send({ type: "readback_played", proposal_id: frame.readback_for });
      }

      if (frame.type === "ui" && frame.action === "stage") {
        const route = routeFor(frame.proposal);
        if (staging.current) window.clearTimeout(staging.current.timer);
        staging.current = {
          directiveId: frame.directive_id,
          proposalId: frame.proposal.id,
          timer: window.setTimeout(
            () => answerStage(false, "The app could not show that on screen."),
            STAGE_TIMEOUT_MS,
          ),
        };
        if (route) navigate(route);
        else answerStage(false, "The app does not know how to show that yet.");
      }

      if (frame.type === "ui" && frame.action === "refresh") {
        if (frame.keys.includes("meetings")) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.meetings.all });
        }
      }

      dispatch({ type: "frame", frame });
      if (frame.type === "ended") release();
    },
    [answerStage, navigate, queryClient, release, send],
  );

  const begin = useCallback(
    async (microphone: boolean, firstText?: string) => {
      if (transport.current) return;
      dispatch({ type: "start", microphone, speakerOn: speakerOn.current });
      setPanelOpen(true);
      try {
        // First, and without awaiting anything before it: see the note at the top.
        const opened = await openAudioDevice({
          microphone,
          onMicrophone: (pcm) => transport.current?.sendAudio(pcm),
          // The meter arrives 25 times a second. Redrawing everything that reads this
          // context that often would be felt, and a meter does not need it.
          onLevel: (level) => {
            const now = performance.now();
            if (now - levelAt.current < 120) return;
            levelAt.current = now;
            setMicLevel(level);
          },
          onPlayed: (id) => send({ type: "readback_played", proposal_id: id }),
        });
        opened.setSpeaker(speakerOn.current);
        device.current = opened;

        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        const session = await createAgentSession(timezone);
        transport.current = connect(
          `${session.ws_url}?ticket=${encodeURIComponent(session.ticket)}`,
          {
            onOpen: () => {
              send({
                type: "context",
                route: context.current.route,
                dialog_open: context.current.dialogOpen,
              });
              if (firstText) send({ type: "text", text: firstText });
            },
            onFrame,
            onAudio: (pcm) => device.current?.play(pcm),
            onClose: (code) => {
              dispatch({ type: "closed", message: closeReason(code) });
              release();
            },
          },
        );
      } catch (caught) {
        release();
        dispatch({
          type: "failed",
          message:
            caught instanceof MicrophoneDenied
              ? "The microphone is blocked. Allow it for this site in your browser's address bar, or type instead."
              : caught instanceof ApiError
                ? caught.message
                : "The assistant could not be started. Please try again.",
        });
      }
    },
    [connect, onFrame, openAudioDevice, release, send],
  );

  const end = useCallback(() => {
    send({ type: "end" });
    // The server answers with `ended` and closes. If it does not, do not wait for it.
    window.setTimeout(() => {
      if (transport.current) {
        dispatch({ type: "closed", message: null });
        release();
      }
    }, 1500);
  }, [release, send]);

  const stop = useCallback(() => send({ type: "stop" }), [send]);

  // Escape is Stop while the assistant is working. The app is locked at that point, so
  // nothing else on the page can be meant by it.
  useEffect(() => {
    if (state.mode !== "working") return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      stop();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [state.mode, stop]);

  const value = useMemo<AgentContextValue>(
    () => ({
      available: status.data?.enabled === true,
      state,
      panelOpen,
      micLevel,
      openPanel: () => setPanelOpen(true),
      closePanel: () => {
        if (transport.current) end();
        setPanelOpen(false);
        dispatch({ type: "reset" });
      },
      startVoice: () => void begin(true),
      sendText: (text) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        // Starting a conversation clears the transcript, so when this message is also
        // what starts it, the start has to come first or the message is wiped as it
        // is shown.
        if (transport.current) send({ type: "text", text: trimmed });
        else void begin(false, trimmed);
        dispatch({ type: "typed", text: trimmed });
      },
      approve: () => {
        if (state.proposal) {
          send({ type: "approval", proposal_id: state.proposal.id, decision: "approve" });
        }
      },
      reject: () => {
        if (state.proposal) {
          send({ type: "approval", proposal_id: state.proposal.id, decision: "reject" });
        }
      },
      stop,
      end,
      setMuted: (muted) => {
        device.current?.setMuted(muted);
        dispatch({ type: "mute", muted });
      },
      setSpeaker: (on) => {
        device.current?.setSpeaker(on);
        try {
          localStorage.setItem(SPEAKER_KEY, on ? "on" : "off");
        } catch {
          // Private browsing may refuse storage. The toggle still works for this page.
        }
        dispatch({ type: "speaker", on });
      },
      confirmStaged: (proposalId) => {
        if (staging.current?.proposalId === proposalId) answerStage(true);
      },
      takeHandover: () => dispatch({ type: "handover_taken" }),
      reportContext: (next) => {
        const changed =
          next.route !== context.current.route || next.dialogOpen !== context.current.dialogOpen;
        context.current = next;
        if (changed) {
          send({ type: "context", route: next.route, dialog_open: next.dialogOpen });
        }
      },
    }),
    [answerStage, begin, end, micLevel, panelOpen, send, state, status.data?.enabled, stop],
  );

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

/**
 * For a page that can show a staged proposal of one kind.
 *
 * `staged` is what to show read-only right now. Call `confirm` once it is on screen.
 * `handover` is a proposal the user took over with Stop: open it as an ordinary form and
 * call `takeHandover`.
 *
 * Safe on a page rendered without the provider: everything is simply null.
 */
export function useStagedProposal(kind: string): {
  staged: Proposal | null;
  handover: Proposal | null;
  confirm: (proposalId: string) => void;
  takeHandover: () => void;
} {
  const agent = useAgent();
  const staged = agent?.state.staged?.kind === kind ? agent.state.staged : null;
  const handover = agent?.state.handover?.kind === kind ? agent.state.handover : null;
  return {
    staged,
    handover,
    confirm: agent?.confirmStaged ?? noop,
    takeHandover: agent?.takeHandover ?? noop,
  };
}

function noop(): void {}
