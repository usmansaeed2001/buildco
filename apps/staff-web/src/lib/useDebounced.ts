/**
 * A value that settles before anyone acts on it.
 *
 * Used by the estimates search, which became a network request per keystroke when
 * filtering moved server-side. The input itself stays uncontrolled by this — the box
 * updates instantly and only the *query* waits, so typing never feels laggy.
 */
import { useEffect, useState } from "react";

export function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
