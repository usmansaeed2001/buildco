/**
 * The connection to the assistant, behind an interface.
 *
 * The provider is written against `AgentTransport`, not `WebSocket`, so a test can drive
 * a whole conversation by handing it frames, with no socket and no server.
 */
import type { ClientFrame, ServerFrame } from "./protocol";

export interface TransportHandlers {
  onOpen: () => void;
  onFrame: (frame: ServerFrame) => void;
  /** 24 kHz, 16-bit, mono PCM: the agent's voice. */
  onAudio: (pcm: ArrayBuffer) => void;
  onClose: (code: number) => void;
}

export interface AgentTransport {
  send: (frame: ClientFrame) => void;
  /** 16 kHz, 16-bit, mono PCM from the microphone. Dropped if the socket is not open. */
  sendAudio: (pcm: ArrayBuffer) => void;
  close: () => void;
}

export type Connect = (url: string, handlers: TransportHandlers) => AgentTransport;

/**
 * The ticket goes in the query string because a browser cannot set a header on a
 * WebSocket. It is single-use and expires in a minute, which is what makes that
 * acceptable; see `agent_service.create_session` on the API.
 */
export const connectSocket: Connect = (url, handlers) => {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";

  socket.onopen = () => handlers.onOpen();
  socket.onclose = (event) => handlers.onClose(event.code);
  socket.onmessage = (event) => {
    if (typeof event.data !== "string") {
      handlers.onAudio(event.data as ArrayBuffer);
      return;
    }
    try {
      handlers.onFrame(JSON.parse(event.data) as ServerFrame);
    } catch {
      // A frame that is not JSON is not one of ours. Nothing useful can be done with it.
    }
  };

  const open = () => socket.readyState === WebSocket.OPEN;
  return {
    send: (frame) => {
      if (open()) socket.send(JSON.stringify(frame));
    },
    sendAudio: (pcm) => {
      if (open()) socket.send(pcm);
    },
    close: () => socket.close(),
  };
};
