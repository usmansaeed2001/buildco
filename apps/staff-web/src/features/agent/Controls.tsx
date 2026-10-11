/**
 * The controls: one rounded surface holding the text box, the voice controls and End.
 *
 * Release 1 had small text buttons, 32px tall, which is under a comfortable touch size on
 * a tablet. These are icons at 44px, each with a state that can be seen and a name that
 * says what pressing it will do.
 *
 * Nothing here is ever the thing the lock disables: these are the user's controls over
 * the assistant.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { MicIcon, MicOffIcon, PauseIcon, SendIcon, SpeakerIcon, SpeakerOffIcon } from "./icons";

/** The text box grows to this many lines, then scrolls. */
const MAX_LINES = 4;
const LINE_PX = 20;

/** A round icon button: 40px to look at, 44px to press. */
export function IconButton({
  label,
  pressed,
  off = false,
  onClick,
  className,
  children,
}: {
  /** What pressing it will do. */
  label: string;
  pressed?: boolean;
  /** Drawn filled and grey: the thing it controls is off. */
  off?: boolean;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      onClick={onClick}
      className={cn("ast-press group grid size-11 shrink-0 place-items-center rounded-full", className)}
    >
      <span
        className={cn(
          "relative grid size-10 place-items-center rounded-full transition-colors duration-150",
          off
            ? "bg-gray-200 text-gray-600"
            : "text-gray-700 ring-1 ring-gray-300 ring-inset group-hover:bg-gray-100",
        )}
      >
        {children}
      </span>
    </button>
  );
}

export function Controls({
  live,
  ending,
  microphone,
  muted,
  micPaused,
  speakerOn,
  voiceOff,
  textOff,
  placeholder,
  onMute,
  onSpeaker,
  onEnd,
  onSend,
}: {
  /** A conversation is live, so the voice controls and End apply. */
  live: boolean;
  /** Only End: the connection is being restored, and there is nothing to say into. */
  ending: boolean;
  /** This conversation was started with the microphone. */
  microphone: boolean;
  muted: boolean;
  /** The microphone is off because the conversation paused, not because it was muted. */
  micPaused: boolean;
  speakerOn: boolean;
  /** Today's time ran out with something waiting: no voice, only End. */
  voiceOff: boolean;
  textOff: boolean;
  placeholder: string;
  onMute: (muted: boolean) => void;
  onSpeaker: (on: boolean) => void;
  onEnd: () => void;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const hasText = text.trim() !== "";

  // One line, growing to four, then scrolling.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_LINES * LINE_PX)}px`;
  }, [text]);

  function submit() {
    if (!hasText || textOff) return;
    onSend(text);
    setText("");
  }

  const voice = live && !voiceOff && !ending;

  return (
    <footer className="shrink-0 px-3 pt-1 pb-3">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className={cn(
          "rounded-2xl border border-gray-200 bg-gray-50 transition-colors duration-150",
          "focus-within:border-brand-500",
        )}
      >
        {!ending && (
          <textarea
            ref={box}
            rows={1}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends. Shift+Enter is a new line.
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              submit();
            }}
            aria-label="Message the assistant"
            placeholder={placeholder}
            disabled={textOff}
            className="block w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm leading-5 text-gray-900 outline-none placeholder:text-gray-400 disabled:cursor-not-allowed disabled:text-gray-500"
          />
        )}

        <div className="flex min-h-11 items-center gap-0.5 px-1 pb-1">
          {voice && microphone && (
            <IconButton
              label={muted ? "Unmute" : "Mute"}
              pressed={muted}
              off={muted || micPaused}
              onClick={() => onMute(!muted)}
            >
              {micPaused && !muted ? (
                <PauseIcon />
              ) : muted ? (
                <MicOffIcon />
              ) : (
                <>
                  <MicIcon />
                  <span aria-hidden="true" className="ast-mic-ring" />
                </>
              )}
            </IconButton>
          )}
          {voice && microphone && muted && (
            <span className="mr-1 text-xs font-medium text-gray-600">Muted</span>
          )}
          {voice && (
            <IconButton
              label={speakerOn ? "Turn speaker off" : "Turn speaker on"}
              pressed={!speakerOn}
              off={!speakerOn}
              onClick={() => onSpeaker(!speakerOn)}
            >
              {speakerOn ? <SpeakerIcon /> : <SpeakerOffIcon />}
            </IconButton>
          )}

          <span className="flex-1" />

          {(live || ending) && (
            <button
              type="button"
              onClick={onEnd}
              className="ast-press h-11 shrink-0 rounded-full px-3.5 text-sm font-semibold text-danger-600 hover:bg-danger-50 dark:text-danger-400"
            >
              End
            </button>
          )}
          {/* Absent until there is something to send, and it springs in with the first
              character. */}
          {hasText && !textOff && !ending && (
            <button
              type="submit"
              aria-label="Send"
              className="ast-pop grid size-11 shrink-0 place-items-center rounded-full"
            >
              <span className="grid size-9 place-items-center rounded-full bg-brand-600 text-white transition-colors duration-150 hover:bg-brand-700">
                <SendIcon />
              </span>
            </button>
          )}
        </div>
      </form>
    </footer>
  );
}
