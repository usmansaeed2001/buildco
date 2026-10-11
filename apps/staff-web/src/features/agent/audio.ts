/**
 * The microphone and the speaker.
 *
 * Two `AudioWorklet`s, because both jobs have to happen on the audio thread to be
 * glitch-free. They are inlined as strings and loaded from blob URLs so that this stays
 * one module with no extra build entry.
 *
 * **Capture** resamples whatever rate the device runs at down to 16 kHz and emits 40 ms
 * chunks of 16-bit PCM. The microphone is opened with echo cancellation, noise
 * suppression and auto gain on: echo cancellation is what lets the microphone stay open
 * while the agent is talking through the same device's speakers.
 *
 * **Playback** takes 24 kHz PCM, resamples it to the device rate, and plays it from a
 * queue with two properties the conversation depends on:
 *
 * - it can be **flushed**, so that when the user talks over the agent, audio already
 *   received is dropped at once and not played out;
 * - it can carry a **mark**, which is reported back when playback reaches it. That is how
 *   the browser knows a read-back has finished *playing*, as opposed to finished
 *   arriving, and it is the fact a spoken approval is checked against. A flush discards
 *   marks along with audio, so an interrupted read-back is never reported as played.
 *
 * It also says how loud what it is playing is, about thirty times a second while there
 * is something to play and once more when there is not. That is what the orb shows while
 * the assistant speaks. It is separate from the marks and changes nothing about them.
 */

const CAPTURE = `
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000; this.acc = 0; this.sum = 0; this.n = 0;
    this.buf = new Int16Array(640); this.len = 0; this.energy = 0;
  }
  process(inputs) {
    const ch = inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i]; this.n++; this.acc++;
      if (this.acc >= this.step) {
        this.acc -= this.step;
        const s = Math.max(-1, Math.min(1, this.sum / this.n));
        this.sum = 0; this.n = 0;
        this.energy += s * s;
        this.buf[this.len++] = s * 32767;
        if (this.len === 640) {
          this.port.postMessage({ pcm: this.buf.buffer.slice(0), level: Math.sqrt(this.energy / 640) });
          this.len = 0; this.energy = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('buildco-capture', Capture);`;

const PLAYER = `
class Player extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = []; this.cur = null; this.pos = 0; this.ratio = 24000 / sampleRate;
    this.frac = 0; this.a = 0; this.b = 0;
    this.every = Math.round(sampleRate / 30); this.seen = 0;
    this.energy = 0; this.n = 0; this.was = false;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.flush) { this.q = []; this.cur = null; this.pos = 0; }
      else if (m.mark !== undefined) this.q.push({ mark: m.mark });
      else this.q.push(new Int16Array(m.pcm));
    };
  }
  next() {
    for (;;) {
      if (this.cur && this.pos < this.cur.length) return this.cur[this.pos++] / 32768;
      this.cur = null;
      if (!this.q.length) return null;
      const item = this.q.shift();
      if (item.mark !== undefined) { this.port.postMessage({ played: item.mark }); continue; }
      this.cur = item; this.pos = 0;
    }
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      this.frac += this.ratio;
      while (this.frac >= 1) {
        this.frac -= 1; this.a = this.b;
        const s = this.next();
        this.b = s === null ? 0 : s;
        if (s !== null) { this.energy += s * s; this.n++; }
      }
      out[i] = this.a + (this.b - this.a) * this.frac;
    }
    this.seen += out.length;
    if (this.seen >= this.every) {
      const playing = this.n > 0;
      if (playing || this.was) {
        this.port.postMessage({ level: playing ? Math.sqrt(this.energy / this.n) : 0, playing });
      }
      this.was = playing; this.seen = 0; this.energy = 0; this.n = 0;
    }
    return true;
  }
}
registerProcessor('buildco-player', Player);`;

export interface AgentAudio {
  /** Queue the agent's voice. Ignored while the speaker is off. */
  play: (pcm: ArrayBuffer) => void;
  /** Drop everything queued, marks included. */
  flush: () => void;
  /** Ask to be told, through `onPlayed`, when playback reaches this point. */
  mark: (id: string) => void;
  setSpeaker: (on: boolean) => void;
  setMuted: (muted: boolean) => void;
  close: () => void;
}

export interface AudioOptions {
  /** False for a conversation started by typing: no permission prompt, no capture. */
  microphone: boolean;
  onMicrophone: (pcm: ArrayBuffer) => void;
  onLevel: (level: number) => void;
  onPlayed: (id: string) => void;
  /** How loud the voice being played is, and whether anything is playing at all. */
  onVoice?: (level: number, playing: boolean) => void;
}

export type OpenAudio = (options: AudioOptions) => Promise<AgentAudio>;

/** Thrown when the user, or the browser, refuses the microphone. */
export class MicrophoneDenied extends Error {}

export const openAudio: OpenAudio = async (options) => {
  const AudioContextClass =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new AudioContextClass();
  // Must happen inside the click that started the conversation, or the browser keeps
  // the context suspended and nothing is ever heard.
  //
  // Not awaited without a limit. If the browser decides this was not a user gesture, the
  // promise does not reject: it never settles, and the conversation would sit on
  // "Connecting" for good. So wait briefly, carry on regardless, and take the next
  // click or key press anywhere as the gesture. Until then the conversation works in
  // captions, which is a far better failure than not starting.
  const resumed = context.resume().catch(() => undefined);
  await Promise.race([resumed, new Promise((resolve) => setTimeout(resolve, 1000))]);
  if (context.state !== "running") {
    const unlock = () => {
      void context.resume();
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    };
    document.addEventListener("pointerdown", unlock);
    document.addEventListener("keydown", unlock);
  }

  const load = (source: string) =>
    context.audioWorklet.addModule(
      URL.createObjectURL(new Blob([source], { type: "application/javascript" })),
    );
  await Promise.all([load(CAPTURE), load(PLAYER)]);

  const player = new AudioWorkletNode(context, "buildco-player", {
    numberOfInputs: 0,
    outputChannelCount: [1],
  });
  player.connect(context.destination);
  player.port.onmessage = (
    event: MessageEvent<{ played?: string; level?: number; playing?: boolean }>,
  ) => {
    if (event.data.played !== undefined) options.onPlayed(event.data.played);
    if (event.data.level !== undefined) {
      options.onVoice?.(event.data.level, event.data.playing === true);
    }
  };

  let stream: MediaStream | null = null;
  let muted = false;
  let speaker = true;

  if (options.microphone) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (caught) {
      await context.close();
      throw new MicrophoneDenied(caught instanceof Error ? caught.message : "denied");
    }
    const capture = new AudioWorkletNode(context, "buildco-capture", { numberOfOutputs: 1 });
    // The graph is pulled from the destination, so the capture node has to reach it to
    // run at all. A zero gain keeps the microphone out of the speakers.
    const silent = context.createGain();
    silent.gain.value = 0;
    context.createMediaStreamSource(stream).connect(capture);
    capture.connect(silent);
    silent.connect(context.destination);
    capture.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
      options.onLevel(muted ? 0 : event.data.level);
      if (!muted) options.onMicrophone(event.data.pcm);
    };
  }

  return {
    play: (pcm) => {
      if (speaker) player.port.postMessage({ pcm }, [pcm]);
    },
    flush: () => player.port.postMessage({ flush: true }),
    mark: (id) => player.port.postMessage({ mark: id }),
    setSpeaker: (on) => {
      speaker = on;
      if (!on) player.port.postMessage({ flush: true });
    },
    setMuted: (value) => {
      muted = value;
    },
    close: () => {
      stream?.getTracks().forEach((track) => track.stop());
      void context.close();
    },
  };
};
