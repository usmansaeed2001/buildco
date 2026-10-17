/**
 * BuildCo Assistant in the browser: one provider, mounted once in `AppShell` so that the
 * panel and a live conversation survive moving between pages.
 *
 * It owns the two things that have side effects, the socket and the audio, and keeps
 * everything else in `agentReducer`. Both come in through props with real defaults, so a
 * test can run a whole conversation by handing the provider frames.
 *
 * Some behaviours here are not incidental:
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
 *   The server waits to be told the proposal is on screen. Saying so before the page
 *   has rendered it would let the agent describe a form the user cannot see.
 * - **A dropped connection is not the end.** The socket going away without the server
 *   saying why is a network blip until a minute has passed. The same conversation is
 *   reconnected to, with its transcript and anything staged still in place. Either way
 *   the panel then asks the server what became of the last action, so it never implies
 *   something was lost when it was saved, or the reverse.
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
import {
  createAgentSession,
  deleteAgentMemory,
  fetchAgentConversation,
  reconnectAgentSession,
  useAgentStatus,
} from "@/api/queries/agent";
import { queryKeys } from "@/api/queries/keys";
import type { AgentSessionOut } from "@/api/types";
import { agentReducer, initialState, isLocked, type AgentState } from "./agentState";
import { MicrophoneDenied, openAudio, type AgentAudio, type OpenAudio } from "./audio";
import { createLevels, type Levels } from "./levels";
import {
  closeReason,
  type ClientFrame,
  type Proposal,
  type ProposalOutcome,
  type ServerFrame,
  type ViewedRecord,
  type ViewedSelection,
} from "./protocol";
import {
  connectSocket,
  type AgentTransport,
  type Connect,
  type TransportHandlers,
} from "./transport";
import { usePhoneLayout } from "./useLauncherShown";

/** How long a page has to show a staged proposal before the server is told it failed. */
const STAGE_TIMEOUT_MS = 4000;
/** How long a dropped conversation can be reconnected to. The server's figure. */
const RECONNECT_WINDOW_MS = 60_000;
const SPEAKER_KEY = "buildco.assistant.speaker";

/** What the supplement editor offers the assistant while it is open. */
export interface EditorHandle {
  supplementId: string;
  /** Save anything pending and resolve when the server has it. Rejects if it cannot. */
  flush: () => Promise<void>;
}

/**
 * How the panel is drawn on a phone. `full`: it fills the screen. `mini`: it folds down
 * to a bar at the foot, so the app above it can be seen, which is how a staged change
 * is shown.
 */
export type PhoneView = "full" | "mini";

export interface AgentContextValue {
  /** Whether the assistant is offered to this person at all. */
  available: boolean;
  /** Seconds of today's allowance left, as last heard. Null until known. */
  remainingToday: number | null;
  /** Seconds each person gets in a day. Null until known. */
  dailyLimit: number | null;
  /** When the allowance starts again, as an ISO instant. */
  resetsAt: string | null;
  state: AgentState;
  /** Whether the app beside the panel is locked while the assistant works. */
  locked: boolean;
  panelOpen: boolean;
  /** Whether the window is laid out for a phone: no room for a panel beside the app. */
  phone: boolean;
  /** On a phone, whether the panel fills the screen or is folded down to a bar. */
  phoneView: PhoneView;
  setPhoneView: (view: PhoneView) => void;
  /**
   * How loud the microphone and the voice are, and whether the assistant is speaking.
   * Not state: the levels go straight to the stylesheet, so nothing redraws for them.
   */
  levels: Levels;
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
  /** Tap to talk: bring the microphone back after an approval pause. */
  resume: () => void;
  end: () => void;
  setMuted: (muted: boolean) => void;
  setSpeaker: (on: boolean) => void;
  /** Undo something the assistant has just said it will remember. */
  forget: (memoryId: string) => Promise<void>;
  /** For a page: the staged proposal is now on screen. */
  confirmStaged: (proposalId: string) => void;
  /** For a page: it has opened the handed-over proposal as an ordinary form. */
  takeHandover: () => void;
  /** For the shell: where the user is, and whether a dialog of theirs is open. */
  reportContext: (context: { route: string; dialogOpen: boolean }) => void;
  /** For a page: the record it is showing, or null when it stops showing one. */
  viewRecord: (record: ViewedRecord | null, saveState?: string | null) => void;
  /** For a page: the part of its record that is selected, such as a room. */
  viewSelection: (selection: ViewedSelection | null) => void;
  /** For the supplement editor: how to make sure it has saved. */
  registerEditor: (editor: EditorHandle | null) => void;
}

const AgentContext = createContext<AgentContextValue | null>(null);

/**
 * The assistant drawn from fixed values, with no socket, no audio and no server. For the
 * gallery of states and for tests of how a state looks.
 */
export function AgentPreview({
  value,
  children,
}: {
  value: AgentContextValue;
  children: ReactNode;
}) {
  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

/** Null when there is no provider, which is every screen outside the signed-in shell. */
export function useAgent(): AgentContextValue | null {
  return useContext(AgentContext);
}

function rememberedSpeaker(): boolean {
  try {
    return localStorage.getItem(SPEAKER_KEY) !== "off";
  } catch {
    return true;
  }
}

interface View {
  route: string;
  dialogOpen: boolean;
  entity: ViewedRecord | null;
  selection: ViewedSelection | null;
  saveState: string | null;
  phone: boolean;
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
  const [levels] = useState(createLevels);
  const phone = usePhoneLayout();
  const [phoneView, setPhoneView] = useState<PhoneView>("full");

  const transport = useRef<AgentTransport | null>(null);
  const device = useRef<AgentAudio | null>(null);
  const speakerOn = useRef(state.speakerOn);
  speakerOn.current = state.speakerOn;
  const paused = useRef(false);
  paused.current = state.paused !== null;
  const openProposal = useRef<string | null>(null);
  openProposal.current = state.proposal?.id ?? null;
  const staging = useRef<{ directiveId: string; proposalId: string; timer: number } | null>(null);
  const view = useRef<View>({
    route: "/",
    dialogOpen: false,
    entity: null,
    selection: null,
    saveState: null,
    phone,
  });
  const editor = useRef<EditorHandle | null>(null);
  /** The conversation this browser is in, from `ready` until it is known to be over. */
  const conversation = useRef<string | null>(null);
  /** Bumped whenever the current connection stops mattering, to quiet its late events. */
  const epoch = useRef(0);

  const send = useCallback((frame: ClientFrame) => transport.current?.send(frame), []);

  const sendContext = useCallback(() => {
    const now = view.current;
    send({
      type: "context",
      route: now.route,
      dialog_open: now.dialogOpen,
      entity: now.entity,
      selection: now.selection,
      editor_save_state: now.saveState,
      // On a phone a spoken yes is not enough to approve, so the server has to know.
      layout: now.phone ? "phone" : "wide",
    });
  }, [send]);

  useEffect(() => {
    if (view.current.phone === phone) return;
    view.current = { ...view.current, phone };
    sendContext();
  }, [phone, sendContext]);

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
    epoch.current += 1;
    if (staging.current) window.clearTimeout(staging.current.timer);
    staging.current = null;
    conversation.current = null;
    transport.current?.close();
    transport.current = null;
    device.current?.close();
    device.current = null;
    levels.reset();
    // What is left of today, and the history list, both changed while this ran.
    void queryClient.invalidateQueries({ queryKey: queryKeys.agent.all });
  }, [levels, queryClient]);

  // A conversation does not outlive the shell: signing out or leaving unmounts this.
  useEffect(() => release, [release]);

  /**
   * Ask the server what became of the proposal that was open. A commit in flight when a
   * connection drops still completes, and the frame that said so went with the socket.
   */
  const learnOutcome = useCallback(async (conversationId: string) => {
    const waiting = openProposal.current;
    if (!waiting) return;
    try {
      const record = await fetchAgentConversation(conversationId);
      const action = (record.actions ?? []).find((candidate) => candidate.id === waiting);
      if (!action || action.status === "proposed") return;
      const target = action.result as { type?: string; id?: string } | null;
      dispatch({
        type: "frame",
        frame: {
          type: "proposal_result",
          id: action.id,
          status: action.status as ProposalOutcome,
          error: action.error ?? null,
          ...(target?.type && target.id ? { target: { type: target.type, id: target.id } } : {}),
        },
      });
    } catch {
      // Nothing better is known. The panel says the connection was lost and no more.
    }
  }, []);

  const onFrame = useCallback(
    (frame: ServerFrame) => {
      if (frame.type === "ready") {
        conversation.current = frame.conversation_id;
        if (frame.resumed) void learnOutcome(frame.conversation_id);
      }
      if (frame.type === "interrupted") device.current?.flush();

      if (frame.type === "turn_complete" && frame.readback_for) {
        // With the speaker off nothing plays, so the summary counts as delivered once
        // it is on screen, which it already is.
        if (speakerOn.current) device.current?.mark(frame.readback_for);
        else {
          send({ type: "readback_played", proposal_id: frame.readback_for });
          dispatch({ type: "readback_played", id: frame.readback_for });
        }
      }

      if (frame.type === "ui") {
        const acknowledge = (ok: boolean, reason?: string) =>
          send({
            type: "ui_ack",
            directive_id: frame.directive_id,
            ok,
            ...(reason ? { reason } : {}),
          });

        if (frame.action === "stage") {
          const route = frame.proposal.labels.route;
          if (staging.current) window.clearTimeout(staging.current.timer);
          staging.current = {
            directiveId: frame.directive_id,
            proposalId: frame.proposal.id,
            timer: window.setTimeout(
              () => answerStage(false, "The app could not show that on screen."),
              STAGE_TIMEOUT_MS,
            ),
          };
          // A change with nowhere to go in the app is shown in the panel alone, and
          // the panel is already showing it. And a page that is already open is left
          // as it is: going to it again would throw away which tab the user was on.
          if (!route) answerStage(true);
          else if (route.includes("?") || route !== view.current.route) navigate(route);
        }

        if (frame.action === "navigate") {
          navigate(frame.to);
          // Shown something on a phone, the user has to be able to see it.
          setPhoneView("mini");
          acknowledge(true);
        }

        if (frame.action === "prepare") {
          const open = editor.current;
          if (!open || open.supplementId !== frame.supplement_id) acknowledge(true);
          else {
            open.flush().then(
              () => acknowledge(true),
              () =>
                acknowledge(
                  false,
                  "That supplement has changes in the editor that could not be saved. " +
                    "Ask the user to fix the save and try again.",
                ),
            );
          }
        }

        if (frame.action === "refresh") {
          const keys: Record<string, readonly string[]> = {
            meetings: queryKeys.meetings.all,
            estimates: queryKeys.estimates.all,
            agent: queryKeys.agent.all,
          };
          for (const key of frame.keys) {
            const queryKey = keys[key];
            if (queryKey) void queryClient.invalidateQueries({ queryKey });
          }
        }
      }

      dispatch({ type: "frame", frame });
      if (frame.type === "ended") release();
    },
    [answerStage, learnOutcome, navigate, queryClient, release, send],
  );

  /** Open a socket for a session, new or reconnected, and wire it to everything. */
  const attach = useCallback(
    (session: AgentSessionOut, firstText?: string) => {
      const mine = epoch.current;
      const handlers: TransportHandlers = {
        onOpen: () => {
          sendContext();
          if (firstText) send({ type: "text", text: firstText });
        },
        onFrame,
        onAudio: (pcm) => device.current?.play(pcm),
        onClose: (code) => {
          if (mine !== epoch.current) return;
          const refused = closeReason(code);
          const id = conversation.current;
          if (refused || !id) {
            dispatch({ type: "closed", message: refused });
            release();
            return;
          }
          void reconnect(id);
        },
      };
      transport.current = connect(
        `${session.ws_url}?ticket=${encodeURIComponent(session.ticket)}`,
        handlers,
      );
    },
    // `reconnect` is declared below and only called later, from a socket event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connect, onFrame, release, send, sendContext],
  );

  /**
   * The socket went away without the server saying why. Try to get the same
   * conversation back for a minute; after that, or as soon as the server says it has
   * ended, find out what became of the last action and say the connection was lost.
   */
  const reconnect = useCallback(
    async (conversationId: string) => {
      const mine = ++epoch.current;
      transport.current = null;
      if (staging.current) window.clearTimeout(staging.current.timer);
      staging.current = null;
      dispatch({ type: "reconnecting" });

      const deadline = Date.now() + RECONNECT_WINDOW_MS;
      let wait = 1000;
      while (mine === epoch.current && Date.now() < deadline) {
        try {
          const session = await reconnectAgentSession(conversationId);
          if (mine !== epoch.current) return;
          attach(session);
          return;
        } catch (caught) {
          // The server answered, and the answer is no: it has ended, the minute is up,
          // or the allowance ran out. Trying again would change nothing.
          if (caught instanceof ApiError && caught.status < 500) break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, wait));
        wait = Math.min(wait + 1000, 5000);
      }
      if (mine !== epoch.current) return;
      await learnOutcome(conversationId);
      if (mine !== epoch.current) return;
      dispatch({ type: "closed", message: null });
      release();
    },
    [attach, learnOutcome, release],
  );

  const begin = useCallback(
    async (microphone: boolean, firstText?: string) => {
      if (transport.current || conversation.current) return;
      dispatch({ type: "start", microphone, speakerOn: speakerOn.current });
      setPanelOpen(true);
      try {
        // First, and without awaiting anything before it: see the note at the top.
        const opened = await openAudioDevice({
          microphone,
          // Nothing is streamed while paused: a job site is not sent to the cloud
          // while somebody reads a proposal.
          onMicrophone: (pcm) => {
            if (!paused.current) transport.current?.sendAudio(pcm);
          },
          // The level arrives 25 times a second. It goes to the stylesheet, not to
          // state: redrawing everything that reads this context that often would be
          // felt, and an orb does not need it.
          onLevel: (level) => levels.mic(paused.current ? 0 : level),
          onVoice: (level, playing) => levels.voice(level, playing),
          onPlayed: (id) => {
            send({ type: "readback_played", proposal_id: id });
            // For the card: from here a spoken yes can count, and it says so.
            dispatch({ type: "readback_played", id });
          },
        });
        opened.setSpeaker(speakerOn.current);
        device.current = opened;

        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        attach(await createAgentSession(timezone), firstText);
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
    [attach, levels, openAudioDevice, release, send],
  );

  const end = useCallback(() => {
    if (!transport.current) {
      // Reconnecting: there is no socket to say goodbye on. Just stop trying.
      if (conversation.current) {
        dispatch({ type: "closed", message: null });
        release();
      }
      return;
    }
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
  const locked = isLocked(state);

  // What pages call from effects. Each keeps one identity for the provider's whole
  // life, so that an effect depending on it runs when the page's own facts change and
  // not every time a word of the transcript arrives.
  const confirmStaged = useCallback(
    (proposalId: string) => {
      if (staging.current?.proposalId === proposalId) answerStage(true);
    },
    [answerStage],
  );
  const takeHandover = useCallback(() => dispatch({ type: "handover_taken" }), []);
  const reportContext = useCallback(
    (next: { route: string; dialogOpen: boolean }) => {
      const now = view.current;
      if (next.route === now.route && next.dialogOpen === now.dialogOpen) return;
      view.current = { ...now, ...next };
      sendContext();
    },
    [sendContext],
  );
  const viewRecord = useCallback(
    (record: ViewedRecord | null, saveState: string | null = null) => {
      const now = view.current;
      const same =
        now.entity?.id === record?.id &&
        now.entity?.type === record?.type &&
        now.saveState === saveState;
      if (same) return;
      // A selection belongs to the record it was made in.
      view.current = {
        ...now,
        entity: record,
        saveState,
        selection: now.entity?.id === record?.id ? now.selection : null,
      };
      sendContext();
    },
    [sendContext],
  );
  const viewSelection = useCallback(
    (selection: ViewedSelection | null) => {
      const now = view.current;
      if (
        now.selection?.room_position === selection?.room_position &&
        now.selection?.room_name === selection?.room_name
      )
        return;
      view.current = { ...now, selection };
      sendContext();
    },
    [sendContext],
  );

  // On a phone the panel covers the app, so a staged change is shown with the panel
  // folded down under it, and the panel comes back once it has been answered. A change
  // handed over with Stop is the user's to finish in the app, so the app stays in view.
  const stagedId = state.staged?.id ?? null;
  const handingOver = state.handover !== null;
  useEffect(() => {
    if (stagedId !== null || handingOver) setPhoneView("mini");
    else setPhoneView("full");
  }, [stagedId, handingOver]);
  const registerEditor = useCallback((next: EditorHandle | null) => {
    editor.current = next;
  }, []);

  // Escape is Stop while the assistant is working. The app is locked at that point, so
  // nothing else on the page can be meant by it.
  useEffect(() => {
    if (!locked) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      stop();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [locked, stop]);

  // The countdown the panel shows. The server keeps the real one.
  const counting = state.phase === "live" && state.paused === null;
  useEffect(() => {
    if (!counting) return;
    const timer = window.setInterval(() => dispatch({ type: "tick" }), 1000);
    return () => window.clearInterval(timer);
  }, [counting]);

  const value = useMemo<AgentContextValue>(
    () => ({
      available: status.data?.enabled === true,
      remainingToday:
        state.phase === "live" || state.phase === "reconnecting"
          ? state.remainingSeconds
          : (status.data?.remaining_seconds ?? null),
      dailyLimit: status.data?.daily_limit_seconds ?? null,
      resetsAt: status.data?.resets_at ?? null,
      state,
      locked,
      panelOpen,
      phone,
      phoneView,
      setPhoneView,
      levels,
      openPanel: () => {
        setPhoneView("full");
        setPanelOpen(true);
      },
      closePanel: () => {
        if (transport.current || conversation.current) end();
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
      resume: () => send({ type: "resume" }),
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
      forget: async (memoryId) => {
        await deleteAgentMemory(memoryId);
        dispatch({ type: "forgotten", id: memoryId });
        void queryClient.invalidateQueries({ queryKey: queryKeys.agent.memories });
      },
      confirmStaged,
      takeHandover,
      reportContext,
      viewRecord,
      viewSelection,
      registerEditor,
    }),
    [
      begin,
      confirmStaged,
      end,
      levels,
      locked,
      panelOpen,
      phone,
      phoneView,
      queryClient,
      registerEditor,
      reportContext,
      send,
      state,
      status.data,
      stop,
      takeHandover,
      viewRecord,
      viewSelection,
    ],
  );

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

/**
 * For a page that can show staged proposals of some kinds.
 *
 * `staged` is what to show read-only right now. Call `confirm` once it is on screen.
 * `handover` is a proposal the user took over with Stop: open it as an ordinary form and
 * call `takeHandover`. `commits` goes up by one each time anything is committed, for a
 * page that has to take the saved values back in.
 *
 * Safe on a page rendered without the provider: everything is simply null.
 */
export function useStagedProposal(...kinds: string[]): {
  staged: Proposal | null;
  handover: Proposal | null;
  confirm: (proposalId: string) => void;
  takeHandover: () => void;
  commits: number;
  lastTarget: { type: string; id: string } | null;
} {
  const agent = useAgent();
  const mine = (proposal: Proposal | null | undefined) =>
    proposal && kinds.includes(proposal.kind) ? proposal : null;
  const last = agent?.state.lastResult;
  return {
    staged: mine(agent?.state.staged),
    handover: mine(agent?.state.handover),
    confirm: agent?.confirmStaged ?? noop,
    takeHandover: agent?.takeHandover ?? noop,
    commits: agent?.state.commits ?? 0,
    lastTarget: last?.status === "committed" ? last.target : null,
  };
}

/**
 * For a page showing one record: tell the assistant which, so that "this one" means it.
 * Forgotten again when the page goes away.
 */
export function useAgentRecord(record: ViewedRecord | null, saveState: string | null = null) {
  const view = useAgent()?.viewRecord;
  const type = record?.type ?? null;
  const id = record?.id ?? null;
  const label = record?.label;
  useEffect(() => {
    if (!view) return;
    view(type && id ? { type, id, ...(label ? { label } : {}) } : null, saveState);
  }, [view, type, id, label, saveState]);
  useEffect(() => () => view?.(null), [view]);
}

function noop(): void {}
