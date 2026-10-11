/**
 * The orb: the assistant's face, and the answer to "what is it doing right now?".
 *
 * In a voice product that is the most important thing on the screen, and Release 1 had
 * a grey bar for it. The orb shows one of eleven states, each with its own drawing, so
 * the state can be read without reading. It is still never the only signal: every place
 * that shows an orb shows the state's words beside it, and that label is what a screen
 * reader is given. The orb itself is hidden from one.
 *
 * It draws; it does not listen. How loud things are reaches it as two CSS variables on
 * the card (`levels.ts`), so it never re-renders for sound. How it moves is all in
 * `styles/assistant.css`, and with reduced motion each state is simply a still drawing.
 */
import { cn } from "@/lib/cn";

export type OrbState =
  | "resting"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "working"
  | "waiting"
  | "paused"
  | "muted"
  | "reconnecting"
  | "spent";

/** 20 in a line of text, 32 in the header, 56 on the launcher, 96 as the centre. */
export type OrbSize = 20 | 32 | 56 | 96;

/** The length of the ring drawn round the rim, for the strokes that depend on it. */
const RING = 2 * Math.PI * 46;

const RINGS: Partial<Record<OrbState, string>> = {
  connecting: `70 ${RING - 70}`,
  working: `70 ${RING - 70}`,
  waiting: `${RING} ${RING}`,
  reconnecting: "12 9",
};

let watching = false;

/** Loops stop when the tab cannot be seen. Installed once, the first time an orb draws. */
function watchVisibility() {
  if (watching || typeof document === "undefined") return;
  watching = true;
  const update = () => {
    if (document.hidden) document.documentElement.dataset.tabHidden = "";
    else delete document.documentElement.dataset.tabHidden;
  };
  document.addEventListener("visibilitychange", update);
  update();
}

export function Orb({
  state = "resting",
  size = 32,
  answering = false,
  className,
}: {
  state?: OrbState;
  size?: OrbSize;
  /** While waiting: the time a spoken answer has is running, so the ring empties. */
  answering?: boolean;
  className?: string;
}) {
  watchVisibility();
  // At 20px there is no room for anything but the disc and, while working, the arc.
  const detailed = size > 20;
  const ring = RINGS[state];
  const showRing = ring !== undefined && (detailed || state === "working");

  return (
    <span
      aria-hidden="true"
      data-orb
      data-state={state}
      data-size={size}
      {...(state === "waiting" && answering ? { "data-window": "open" } : {})}
      className={cn("ast-orb", className)}
      style={{ "--orb": `${size}px`, "--ring-length": RING } as React.CSSProperties}
    >
      {detailed && <span className="ast-orb-halo" />}
      <span className="ast-orb-disc">
        <span className="ast-orb-core" />
        {detailed && (
          <span className="ast-orb-blobs">
            <span className="ast-orb-blob ast-orb-blob-a" />
            <span className="ast-orb-blob ast-orb-blob-b" />
            <span className="ast-orb-blob ast-orb-blob-c" />
          </span>
        )}
        <span className="ast-orb-shine" />
        <span className="ast-orb-grey" />
        {detailed && state === "speaking" && (
          <span className="ast-orb-bars">
            <span />
            <span />
            <span />
            <span />
            <span />
          </span>
        )}
      </span>

      {showRing && (
        <svg className="ast-orb-ring" viewBox="0 0 100 100">
          <g>
            <circle cx="50" cy="50" r="46" strokeDasharray={ring} />
          </g>
        </svg>
      )}

      {detailed && state === "paused" && (
        <svg className="ast-orb-glyph" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M7.5 5.5v9M12.5 5.5v9" />
        </svg>
      )}
      {detailed && state === "muted" && (
        <svg className="ast-orb-glyph" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="7.5" y="2.5" width="5" height="9" rx="2.5" />
          <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5M3.5 3.5l13 13" />
        </svg>
      )}
    </span>
  );
}
