/**
 * How loud the microphone and the assistant's voice are, kept out of React.
 *
 * The audio thread reports a level some 25 times a second. Putting that in state redrew
 * everything that reads the assistant's context that often. Here the two levels are
 * written to two CSS variables on the card, `--mic-level` and `--voice-level`, from one
 * animation-frame loop, and the orb and the microphone button read them in the
 * stylesheet. Nothing re-renders.
 *
 * The loop smooths what it writes, quick to rise and slow to fall, which is what makes
 * the orb look like it is listening and not like a meter. It runs at most thirty times a
 * second, and not at all while the tab is hidden, the card is closed, or the user has
 * asked for reduced motion.
 *
 * The one thing React does need is whether the assistant is speaking, for the status
 * label. That changes a few times a minute, not thirty times a second, and is offered as
 * a store to subscribe to.
 */
import { reducedMotion } from "./motion";

const FRAME_MS = 1000 / 30;
const RISE_MS = 60;
const FALL_MS = 240;
/** Speech sits far below full scale. This is what makes an ordinary voice fill the orb. */
const GAIN = 4;

export interface Levels {
  /** The microphone's level as the capture worklet reports it. */
  mic: (level: number) => void;
  /** The level of the voice being played, and whether anything is playing. */
  voice: (level: number, playing: boolean) => void;
  /** The element to write the variables on, or null when there is none to write to. */
  attach: (element: HTMLElement | null) => void;
  /** Everything back to silence, at the end of a conversation. */
  reset: () => void;
  subscribe: (listener: () => void) => () => void;
  /** Whether the assistant's voice is playing right now. */
  speaking: () => boolean;
}

export function createLevels(): Levels {
  const target = { mic: 0, voice: 0 };
  const shown = { mic: 0, voice: 0 };
  const listeners = new Set<() => void>();
  let element: HTMLElement | null = null;
  let playing = false;
  let frame = 0;
  let last = 0;

  const write = () => {
    element?.style.setProperty("--mic-level", shown.mic.toFixed(3));
    element?.style.setProperty("--voice-level", shown.voice.toFixed(3));
  };

  const ease = (from: number, to: number, elapsed: number) => {
    const time = to > from ? RISE_MS : FALL_MS;
    return from + (to - from) * Math.min(1, elapsed / time);
  };

  const tick = (now: number) => {
    frame = 0;
    const elapsed = now - last;
    if (elapsed >= FRAME_MS) {
      last = now;
      shown.mic = ease(shown.mic, target.mic, elapsed);
      shown.voice = ease(shown.voice, target.voice, elapsed);
      write();
    }
    const settled =
      Math.abs(shown.mic - target.mic) < 0.004 && Math.abs(shown.voice - target.voice) < 0.004;
    // Stops by itself once there is nothing left to move, and is started again by the
    // next level that arrives.
    if (!settled) schedule();
  };

  const schedule = () => {
    if (frame || !element || document.hidden || reducedMotion()) return;
    frame = window.requestAnimationFrame(tick);
  };

  const setPlaying = (next: boolean) => {
    if (next === playing) return;
    playing = next;
    listeners.forEach((listener) => listener());
  };

  return {
    mic: (level) => {
      target.mic = Math.min(1, Math.max(0, level * GAIN));
      schedule();
    },
    voice: (level, isPlaying) => {
      target.voice = isPlaying ? Math.min(1, Math.max(0, level * GAIN)) : 0;
      setPlaying(isPlaying);
      schedule();
    },
    attach: (next) => {
      element = next;
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      last = 0;
      schedule();
    },
    reset: () => {
      target.mic = 0;
      target.voice = 0;
      shown.mic = 0;
      shown.voice = 0;
      write();
      setPlaying(false);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    speaking: () => playing,
  };
}
