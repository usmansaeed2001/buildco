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

export interface Autosave<T = unknown> {
  state: SaveState;
  error: unknown;
  /**
   * Commit now, cancelling any pending debounce. Safe to call when nothing is dirty.
   *
   * **Resolves once the server holds what is on screen, and rejects if the save
   * failed.** It used to return nothing, which left a caller no way to wait: "save, then
   * change the status" was really "start a save, and change the status at the same
   * time". If a save is already in flight, this waits for that one.
   *
   * The failure is also in `state` and `error`, so a caller that only wants to trigger
   * a retry may ignore the rejection, but must catch it.
   */
  flush: () => Promise<void>;
  /**
   * Declare a value to be what the server already holds, without writing.
   *
   * For when a mutation elsewhere returns the canonical record — a status transition
   * replies with the whole `EstimateOut` — and the document is re-seeded from it.
   * Without this the re-seed reads as a local edit and triggers a redundant PATCH.
   *
   * Pass the value being seeded. A re-seed sets state and marks it saved in the same
   * breath, before the hook has rendered with the new value, so "whatever the current
   * value is" would still be the old one. With no argument it means the current value.
   */
  markSaved: (value?: T) => void;
  /** Whether what is on screen differs from what the server is believed to hold. */
  isDirty: () => boolean;
}

/** How one attempt to save ended. A failure is a value, not a throw, so the debounce
 *  timer and the unmount can fire a save without leaving a rejection unhandled. */
type Outcome = { ok: true } | { ok: false; error: unknown };

const SAVED: Outcome = { ok: true };

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
}): Autosave<T> {
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<unknown>(null);

  // What the server is believed to hold. Compared against, never rendered.
  const committed = useRef<string>(serialise(value));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refs so the effect below depends only on the serialised value — otherwise an inline
  // `save` prop would re-arm the timer on every render and it would never fire.
  const latest = useRef({ value, save, serialise, enabled });
  latest.current = { value, save, serialise, enabled };

  // The save in flight, if there is one. `flush` waits on it when nothing new is dirty.
  const running = useRef<Promise<Outcome> | null>(null);

  const commit = useCallback((): Promise<Outcome> => {
    const { value: current, save: run, serialise: encode, enabled: on } = latest.current;
    if (!on) return Promise.resolve(SAVED);
    const snapshot = encode(current);
    if (snapshot === committed.current) return running.current ?? Promise.resolve(SAVED);

    // Recorded before awaiting: an edit arriving mid-flight must be seen as dirty
    // against the value being written, not against the older one.
    committed.current = snapshot;
    setState("saving");
    const attempt: Promise<Outcome> = run(current).then(
      () => {
        setState("saved");
        setError(null);
        return SAVED;
      },
      (caught: unknown) => {
        // Roll the marker back so the next change — or a flush — retries rather than
        // treating the failed write as durable.
        committed.current = "";
        setState("error");
        setError(caught);
        return { ok: false, error: caught };
      },
    );
    running.current = attempt;
    void attempt.then(() => {
      if (running.current === attempt) running.current = null;
    });
    return attempt;
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

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    const outcome = await commit();
    if (!outcome.ok) throw outcome.error;
  }, [commit]);

  const markSaved = useCallback((value?: T) => {
    if (timer.current) clearTimeout(timer.current);
    committed.current = latest.current.serialise(
      value === undefined ? latest.current.value : value,
    );
    setState("saved");
    setError(null);
  }, []);

  const isDirty = useCallback(
    () =>
      latest.current.enabled &&
      latest.current.serialise(latest.current.value) !== committed.current,
    [],
  );

  return { state, error, flush, markSaved, isDirty };
}
