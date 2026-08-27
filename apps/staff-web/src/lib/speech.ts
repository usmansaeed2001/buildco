/**
 * Dictation, via the Web Speech API.
 *
 * A port of `startMic`/`stopMic`/`setLang` from the legacy `app.html`, used to speak
 * site notes into the AI parser instead of typing them on a phone in a half-demolished
 * kitchen.
 *
 * **Chromium only.** `SpeechRecognition` is unimplemented in Firefox and, on Safari,
 * `webkitSpeechRecognition` exists but the shape differs enough not to be worth
 * claiming support for. `isSpeechSupported()` is what callers gate the button on —
 * offering a mic that silently does nothing is worse than not offering one.
 *
 * The legacy transcript handling was broken in a way worth not repeating. It kept the
 * textarea's contents at mic-start in a closure and rebuilt the value on every result
 * with `ta.value.replace(existingText, "")` — so any text the user typed *while*
 * dictating was duplicated or clipped, and a spoken phrase that happened to contain the
 * earlier text erased it. Here the caller owns the textarea: finalised phrases arrive
 * once, in order, and interim text is reported separately and never written into the
 * value.
 */

/** The subset of the spec this uses. Declared locally because `lib.dom` does not ship
 *  these types and the vendor-prefixed constructor is not in any lib at all. */
interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}
interface SpeechRecognitionErrorEventLike {
  readonly error: string;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

interface SpeechWindow {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

/** The two languages the legacy app offered, and the crews that use it speak. */
export const SPEECH_LANGUAGES = [
  { code: "en-US", label: "EN" },
  { code: "es-ES", label: "ES" },
] as const;

export type SpeechLanguage = (typeof SPEECH_LANGUAGES)[number]["code"];

function constructorFor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as SpeechWindow;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isSpeechSupported(): boolean {
  return constructorFor() !== null;
}

/** What went wrong, in words a user can act on. */
export function describeSpeechError(error: string): string {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was denied. Allow it for this site in your browser settings, then try again.";
    case "no-speech":
      return "Nothing was heard. Check the microphone and try again.";
    case "audio-capture":
      return "No microphone was found.";
    case "network":
      return "Speech recognition needs a network connection.";
    default:
      return `Dictation stopped: ${error}.`;
  }
}

export interface DictationHandlers {
  /** A completed phrase. Append it — these never repeat. */
  onPhrase: (text: string) => void;
  /** What is currently being heard, not yet final. Display only; it is replaced. */
  onInterim?: (text: string) => void;
  /** Already described by `describeSpeechError`. */
  onError?: (message: string) => void;
  /** Fires exactly once, whether stopped deliberately, by error, or by silence. */
  onEnd?: () => void;
}

export interface Dictation {
  stop: () => void;
}

/**
 * Begin dictating. Returns null when the browser cannot.
 *
 * `continuous` keeps the session open across pauses, matching the legacy behaviour —
 * someone reading a room's contents aloud pauses constantly and should not have to
 * press the button again each time.
 */
export function startDictation(
  language: SpeechLanguage,
  handlers: DictationHandlers,
): Dictation | null {
  const Recognition = constructorFor();
  if (!Recognition) return null;

  const recognition = new Recognition();
  recognition.lang = language;
  recognition.continuous = true;
  recognition.interimResults = true;

  // `onend` fires after `onerror`, and `stop()` triggers it too. Guarding means the
  // caller's cleanup runs exactly once however the session finished.
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    handlers.onEnd?.();
  };

  recognition.onresult = (event) => {
    let finalText = "";
    let interimText = "";

    // From `resultIndex`, not from zero: earlier results have already been reported,
    // and re-reading them is how a transcript ends up duplicated.
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (!result) continue;
      const text = result[0]?.transcript ?? "";
      if (result.isFinal) finalText += text;
      else interimText += text;
    }

    if (finalText.trim()) handlers.onPhrase(finalText.trim());
    handlers.onInterim?.(interimText.trim());
  };

  recognition.onerror = (event) => {
    // "aborted" is what a deliberate stop() produces. Reporting it would show an error
    // every time someone finishes dictating normally.
    if (event.error !== "aborted") {
      handlers.onError?.(describeSpeechError(event.error));
    }
    finish();
  };

  recognition.onend = finish;

  try {
    recognition.start();
  } catch {
    // start() throws if a session is somehow already running. Nothing useful can be
    // done about it, and it must not take the drawer down.
    handlers.onError?.("Dictation could not be started. Try again.");
    finish();
    return null;
  }

  return {
    stop: () => {
      recognition.stop();
      finish();
    },
  };
}
