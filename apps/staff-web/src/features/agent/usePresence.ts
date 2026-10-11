/**
 * Keeps something that is leaving on screen long enough to be seen leaving.
 *
 * React removes an element the moment it stops being rendered, so an exit animation has
 * nothing to run on. This holds it for the length of the exit and says that it is
 * closing, which the stylesheet turns into the animation and into `pointer-events:
 * none`: a leaving element can be seen and cannot be pressed.
 *
 * With reduced motion there is no exit to wait for, and it goes at once.
 */
import { useEffect, useState } from "react";
import { MOTION, reducedMotion } from "./motion";

export function usePresence(
  present: boolean,
  duration: number = MOTION.fast,
): { mounted: boolean; closing: boolean } {
  const [lingering, setLingering] = useState(false);
  const [was, setWas] = useState(present);

  // Decided during render, so there is no frame in which it has already gone.
  if (present !== was) {
    setWas(present);
    setLingering(!present && !reducedMotion());
  }

  useEffect(() => {
    if (!lingering) return;
    const timer = window.setTimeout(() => setLingering(false), duration);
    return () => window.clearTimeout(timer);
  }, [lingering, duration]);

  return { mounted: present || lingering, closing: !present && lingering };
}
