/**
 * Undo/redo over a single value.
 *
 * A port of the legacy `pushHistory`/`undoAction`/`redoAction`, with two changes.
 *
 * **Every operation is undoable.** The legacy version called `pushHistory()` from
 * `addRoom`, `addItem` and `delItem` — but not from `upItem`, `renRoom` or, most
 * damagingly, `delRoom`. Deleting a room full of line items was unrecoverable, and the
 * Undo button sat right next to the delete that had just destroyed the work.
 *
 * **Consecutive edits to the same field coalesce.** Checkpointing every keystroke would
 * fill a 50-deep stack with single characters, so an edit passes a `coalesceKey` — the
 * room, item and field it is touching. While that key is unchanged the top of the stack
 * is replaced rather than pushed, so one undo reverts "the quantity I just typed"
 * rather than one digit of it. Any other operation clears the key and starts a new
 * entry.
 */
import { useCallback, useRef, useState } from "react";

export const HISTORY_LIMIT = 50;

export interface Undoable<T> {
  present: T;
  /** Apply a change. Omit `coalesceKey` for a discrete operation. */
  update: (next: T | ((prev: T) => T), coalesceKey?: string) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Discard all history and start again from `value`. For a reload, not an edit. */
  reset: (value: T) => void;
}

interface Stack<T> {
  entries: T[];
  index: number;
}

export function useUndoable<T>(initial: T, limit = HISTORY_LIMIT): Undoable<T> {
  const [stack, setStack] = useState<Stack<T>>({ entries: [initial], index: 0 });
  // A ref, not state: changing it must never re-render, and `update` must see the value
  // from the call that ran microseconds ago rather than one render behind.
  const coalescing = useRef<string | undefined>(undefined);

  const update = useCallback(
    (next: T | ((prev: T) => T), coalesceKey?: string) => {
      const merge = coalesceKey !== undefined && coalesceKey === coalescing.current;
      coalescing.current = coalesceKey;

      setStack((current) => {
        const present = current.entries[current.index] as T;
        const value = typeof next === "function" ? (next as (prev: T) => T)(present) : next;

        // Everything after the cursor is a future that this edit has just invalidated.
        const kept = current.entries.slice(0, current.index + 1);

        if (merge) {
          kept[kept.length - 1] = value;
          return { entries: kept, index: kept.length - 1 };
        }

        kept.push(value);
        // Drop from the far end, so the oldest state is what is forgotten.
        const trimmed = kept.length > limit ? kept.slice(kept.length - limit) : kept;
        return { entries: trimmed, index: trimmed.length - 1 };
      });
    },
    [limit],
  );

  const undo = useCallback(() => {
    // A subsequent edit must start a fresh entry rather than merging into the one just
    // restored — otherwise undo followed by typing silently rewrites history.
    coalescing.current = undefined;
    setStack((current) =>
      current.index > 0 ? { ...current, index: current.index - 1 } : current,
    );
  }, []);

  const redo = useCallback(() => {
    coalescing.current = undefined;
    setStack((current) =>
      current.index < current.entries.length - 1
        ? { ...current, index: current.index + 1 }
        : current,
    );
  }, []);

  const reset = useCallback((value: T) => {
    coalescing.current = undefined;
    setStack({ entries: [value], index: 0 });
  }, []);

  return {
    present: stack.entries[stack.index] as T,
    update,
    undo,
    redo,
    canUndo: stack.index > 0,
    canRedo: stack.index < stack.entries.length - 1,
    reset,
  };
}
