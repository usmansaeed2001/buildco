/**
 * Motion that is driven from script.
 *
 * Almost everything that moves is CSS (`styles/assistant.css`), and `index.css` already
 * cuts every CSS animation to nothing when the user asks for reduced motion. The few
 * things that script moves have to check the same setting themselves: the orb
 * travelling to the header, the level loop, and how long a leaving element is kept.
 */

/** The durations in `index.css`, for script that has to wait one out. */
export const MOTION = {
  instant: 80,
  fast: 140,
  base: 220,
  slow: 320,
  slower: 480,
} as const;

const SOFT = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * Whether to hold still.
 *
 * Where the browser cannot say, the answer is yes: a still drawing is always a correct
 * way to show a state, and something that waits on an animation that never runs is not.
 */
export function reducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Move an element from where something used to be to where it now is: measure first,
 * measure last, invert, play. Transform only, so nothing is laid out while it runs.
 */
export function travel(element: Element | null, from: DOMRect | null): void {
  if (!element || !from || reducedMotion() || typeof element.animate !== "function") return;
  const to = element.getBoundingClientRect();
  if (to.width === 0 || from.width === 0) return;
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  element.animate(
    [
      { transform: `translate(${dx}px, ${dy}px) scale(${from.width / to.width})` },
      { transform: "none" },
    ],
    { duration: MOTION.slow, easing: SOFT },
  );
}

/** Slide an element in from an offset, for what makes room when the orb arrives. */
export function slideFrom(element: Element | null, dx: number): void {
  if (!element || reducedMotion() || typeof element.animate !== "function") return;
  element.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], {
    duration: MOTION.slow,
    easing: SOFT,
  });
}
