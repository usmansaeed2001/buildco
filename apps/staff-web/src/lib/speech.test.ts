import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeSpeechError,
  isSpeechSupported,
  startDictation,
  type SpeechLanguage,
} from "./speech";

/** Stands in for the browser's SpeechRecognition, which jsdom does not implement. */
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  static throwOnStart = false;

  lang = "";
  continuous = false;
  interimResults = false;
  started = false;
  stopped = false;

  onstart: (() => void) | null = null;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;

  constructor() {
    FakeRecognition.instances.push(this);
  }

  start() {
    if (FakeRecognition.throwOnStart) throw new Error("already started");
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  abort() {}

  /** Deliver a batch of results, as the browser would. */
  emit(results: { transcript: string; isFinal: boolean }[], resultIndex = 0) {
    this.onresult?.({
      resultIndex,
      results: Object.assign(
        results.map((r) => Object.assign([{ transcript: r.transcript }], { isFinal: r.isFinal })),
        { length: results.length },
      ),
    });
  }
}

function install(kind: "standard" | "webkit" | "none") {
  FakeRecognition.instances = [];
  FakeRecognition.throwOnStart = false;
  const w = window as unknown as Record<string, unknown>;
  delete w.SpeechRecognition;
  delete w.webkitSpeechRecognition;
  if (kind === "standard") w.SpeechRecognition = FakeRecognition;
  if (kind === "webkit") w.webkitSpeechRecognition = FakeRecognition;
}

const latest = () => FakeRecognition.instances.at(-1)!;

function begin(language: SpeechLanguage = "en-US") {
  const onPhrase = vi.fn();
  const onInterim = vi.fn();
  const onError = vi.fn();
  const onEnd = vi.fn();
  const session = startDictation(language, { onPhrase, onInterim, onError, onEnd });
  return { session, onPhrase, onInterim, onError, onEnd };
}

afterEach(() => install("none"));

describe("isSpeechSupported", () => {
  it("is false where the API does not exist", () => {
    install("none");
    expect(isSpeechSupported()).toBe(false);
  });

  it("accepts the standard constructor", () => {
    install("standard");
    expect(isSpeechSupported()).toBe(true);
  });

  it("accepts the vendor-prefixed one, which is what Chrome ships", () => {
    install("webkit");
    expect(isSpeechSupported()).toBe(true);
  });
});

describe("startDictation", () => {
  it("returns null rather than throwing where dictation is unsupported", () => {
    install("none");
    expect(startDictation("en-US", { onPhrase: () => {} })).toBeNull();
  });

  it("configures the session the way continuous dictation needs", () => {
    install("standard");
    begin("es-ES");

    expect(latest().lang).toBe("es-ES");
    // Someone reading a room's contents aloud pauses constantly; without `continuous`
    // they would have to press the button again after every pause.
    expect(latest().continuous).toBe(true);
    expect(latest().interimResults).toBe(true);
    expect(latest().started).toBe(true);
  });

  it("reports a finalised phrase once", () => {
    install("standard");
    const { onPhrase } = begin();

    latest().emit([{ transcript: "two coats of paint", isFinal: true }]);

    expect(onPhrase).toHaveBeenCalledTimes(1);
    expect(onPhrase).toHaveBeenCalledWith("two coats of paint");
  });

  it("keeps interim text out of the phrase stream", () => {
    install("standard");
    const { onPhrase, onInterim } = begin();

    latest().emit([{ transcript: "two coats of", isFinal: false }]);

    expect(onPhrase).not.toHaveBeenCalled();
    expect(onInterim).toHaveBeenCalledWith("two coats of");
  });

  it("does not re-report earlier results when a later batch arrives", () => {
    // The legacy handler rebuilt the whole textarea on every event, which is how a
    // transcript ended up with phrases repeated or clipped.
    install("standard");
    const { onPhrase } = begin();

    latest().emit([{ transcript: "first phrase", isFinal: true }], 0);
    latest().emit(
      [
        { transcript: "first phrase", isFinal: true },
        { transcript: "second phrase", isFinal: true },
      ],
      1,
    );

    expect(onPhrase.mock.calls.flat()).toEqual(["first phrase", "second phrase"]);
  });

  it("separates final from interim within one batch", () => {
    install("standard");
    const { onPhrase, onInterim } = begin();

    latest().emit([
      { transcript: "drywall in the kitchen", isFinal: true },
      { transcript: "and the", isFinal: false },
    ]);

    expect(onPhrase).toHaveBeenCalledWith("drywall in the kitchen");
    expect(onInterim).toHaveBeenCalledWith("and the");
  });

  describe("ending", () => {
    it("reports the end exactly once when stopped deliberately", () => {
      install("standard");
      const { session, onEnd } = begin();

      session!.stop();
      latest().onend?.();

      expect(latest().stopped).toBe(true);
      expect(onEnd).toHaveBeenCalledTimes(1);
    });

    it("reports the end exactly once when the browser ends the session", () => {
      install("standard");
      const { onEnd } = begin();

      latest().onend?.();
      latest().onend?.();

      expect(onEnd).toHaveBeenCalledTimes(1);
    });

    it("does not report an abort as an error — that is what stopping produces", () => {
      install("standard");
      const { onError, onEnd } = begin();

      latest().onerror?.({ error: "aborted" });

      expect(onError).not.toHaveBeenCalled();
      expect(onEnd).toHaveBeenCalledTimes(1);
    });

    it("explains a denied microphone in terms the user can act on", () => {
      install("standard");
      const { onError } = begin();

      latest().onerror?.({ error: "not-allowed" });

      expect(onError).toHaveBeenCalledWith(expect.stringContaining("Microphone access was denied"));
    });

    it("survives a constructor that refuses to start", () => {
      install("standard");
      FakeRecognition.throwOnStart = true;

      const { session, onError, onEnd } = begin();

      expect(session).toBeNull();
      expect(onError).toHaveBeenCalled();
      expect(onEnd).toHaveBeenCalledTimes(1);
    });
  });
});

describe("describeSpeechError", () => {
  it("names the common failures", () => {
    expect(describeSpeechError("no-speech")).toMatch(/Nothing was heard/);
    expect(describeSpeechError("audio-capture")).toMatch(/No microphone/);
    expect(describeSpeechError("network")).toMatch(/network connection/);
  });

  it("still says something useful for an unknown code", () => {
    expect(describeSpeechError("weird-failure")).toBe("Dictation stopped: weird-failure.");
  });
});
