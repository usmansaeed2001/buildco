/**
 * Debounced autosave.
 *
 * The legacy `scheduleSave()` was `clearTimeout` plus a 1.2s `setTimeout` around a PUT,
 * and it had two failures this fixes.
 *
 * **It lost the last edit.** Navigating, closing the tab, or opening another estimate
 * within the debounce window dropped the pending write with no indication. `flush()`
 * runs on unmount, so leaving the editor commits what is outstanding.
 *
 * **It failed silently.** `save()` caught its error into `console.error`, so a rejected
 * write looked exactly like a successful one. The state machine here surfaces `error`,
 * and the editor shows it — an estimate that is quietly not saving is worse than one
 * that plainly refuses to.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type SaveState = "idle" | "pending" | "saving" | "saved" | "error";

export interface Autosave {
  state: SaveState;
  error: unknown;
  /** Commit now, cancelling any pending debounce. Safe to call when nothing is dirty. */
  flush: () => void;
  /**
   * Declare `value` to be what the server already holds, without writing.
   *
   * For when a mutation elsewhere returns the canonical record — a status transition
   * replies with the whole `EstimateOut` — and the document is re-seeded from it.
   * Without this the re-seed reads as a local edit and triggers a redundant PATCH.
   */
  markSaved: () => void;
}

export function useAutosave<T>({
  value,
  save,
  delay = 1200,
  enabled = true,
  serialise = (input: T) => JSON.stringify(input),
}: {
  value: T;
  save: (value: T) => Promise<unknown>;
  delay?: number;
  /** False for a read-only estimate: no timer is armed and nothing is ever sent. */
  enabled?: boolean;
  serialise?: (value: T) => string;
}): Autosave {
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<unknown>(null);

  // What the server is believed to hold. Compared against, never rendered.
  const committed = useRef<string>(serialise(value));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refs so the effect below depends only on the serialised value — otherwise an inline
  // `save` prop would re-arm the timer on every render and it would never fire.
  const latest = useRef({ value, save, serialise, enabled });
  latest.current = { value, save, serialise, enabled };

  const commit = useCallback(async () => {
    const { value: current, save: run, serialise: encode, enabled: on } = latest.current;
    if (!on) return;
    const snapshot = encode(current);
    if (snapshot === committed.current) return;

    // Recorded before awaiting: an edit arriving mid-flight must be seen as dirty
    // against the value being written, not against the older one.
    committed.current = snapshot;
    setState("saving");
    try {
      await run(current);
      setState("saved");
      setError(null);
    } catch (caught) {
      // Roll the marker back so the next change — or a flush — retries rather than
      // treating the failed write as durable.
      committed.current = "";
      setState("error");
      setError(caught);
    }
  }, []);

  const encoded = serialise(value);

  useEffect(() => {
    if (!enabled) return;
    if (encoded === committed.current) return;

    setState("pending");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void commit(), delay);

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [encoded, enabled, delay, commit]);

  // Unmount only — the empty dependency list is what makes this the teardown of the
  // whole hook rather than of one debounce cycle.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      void commit();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    void commit();
  }, [commit]);

  const markSaved = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    committed.current = latest.current.serialise(latest.current.value);
    setState("saved");
    setError(null);
  }, []);

  return { state, error, flush, markSaved };
}
