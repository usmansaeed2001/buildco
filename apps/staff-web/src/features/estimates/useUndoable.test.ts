import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useUndoable } from "./useUndoable";

describe("useUndoable", () => {
  it("starts with nothing to undo or redo", () => {
    const { result } = renderHook(() => useUndoable("a"));
    expect(result.current.present).toBe("a");
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it("steps back and forward through discrete operations", () => {
    const { result } = renderHook(() => useUndoable("a"));

    act(() => result.current.update("b"));
    act(() => result.current.update("c"));
    expect(result.current.present).toBe("c");

    act(() => result.current.undo());
    expect(result.current.present).toBe("b");
    act(() => result.current.undo());
    expect(result.current.present).toBe("a");
    expect(result.current.canUndo).toBe(false);

    act(() => result.current.redo());
    expect(result.current.present).toBe("b");
    expect(result.current.canRedo).toBe(true);
  });

  it("accepts an updater function", () => {
    const { result } = renderHook(() => useUndoable(1));
    act(() => result.current.update((n) => n + 1));
    expect(result.current.present).toBe(2);
  });

  it("does nothing when undoing past the start or redoing past the end", () => {
    const { result } = renderHook(() => useUndoable("a"));

    act(() => result.current.undo());
    expect(result.current.present).toBe("a");

    act(() => result.current.redo());
    expect(result.current.present).toBe("a");
  });

  it("drops the redo branch once a new edit lands", () => {
    const { result } = renderHook(() => useUndoable("a"));

    act(() => result.current.update("b"));
    act(() => result.current.undo());
    act(() => result.current.update("c"));

    expect(result.current.canRedo).toBe(false);
    expect(result.current.present).toBe("c");
    act(() => result.current.undo());
    expect(result.current.present).toBe("a");
  });

  describe("coalescing", () => {
    it("merges consecutive edits under the same key into one undo step", () => {
      const { result } = renderHook(() => useUndoable(""));

      // Typing "125" into one quantity field: three edits, one undoable action.
      act(() => result.current.update("1", "0:0:quantity"));
      act(() => result.current.update("12", "0:0:quantity"));
      act(() => result.current.update("125", "0:0:quantity"));

      expect(result.current.present).toBe("125");
      act(() => result.current.undo());
      expect(result.current.present).toBe("");
    });

    it("starts a new step when the field changes", () => {
      const { result } = renderHook(() => useUndoable(""));

      act(() => result.current.update("1", "0:0:quantity"));
      act(() => result.current.update("2", "0:0:unitCost"));

      act(() => result.current.undo());
      expect(result.current.present).toBe("1");
    });

    it("starts a new step for a discrete operation between edits", () => {
      const { result } = renderHook(() => useUndoable(""));

      act(() => result.current.update("a", "0:0:name"));
      act(() => result.current.update("added-room"));
      act(() => result.current.update("b", "0:0:name"));

      act(() => result.current.undo());
      expect(result.current.present).toBe("added-room");
    });

    it("does not merge into the entry an undo just restored", () => {
      const { result } = renderHook(() => useUndoable(""));

      act(() => result.current.update("1", "k"));
      act(() => result.current.update("12", "k"));
      act(() => result.current.undo());
      // Same key, but the undo broke the run — this must push, not overwrite.
      act(() => result.current.update("9", "k"));

      act(() => result.current.undo());
      expect(result.current.present).toBe("");
    });
  });

  it("forgets the oldest state once the limit is reached", () => {
    const { result } = renderHook(() => useUndoable(0, 3));

    act(() => result.current.update(1));
    act(() => result.current.update(2));
    act(() => result.current.update(3));

    // Limit 3 holds the present plus two prior states; 0 has fallen off.
    act(() => result.current.undo());
    act(() => result.current.undo());
    expect(result.current.present).toBe(1);
    expect(result.current.canUndo).toBe(false);
  });

  it("reset discards history, so a reload cannot be undone into the previous record", () => {
    const { result } = renderHook(() => useUndoable("a"));

    act(() => result.current.update("b"));
    act(() => result.current.reset("fresh"));

    expect(result.current.present).toBe("fresh");
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });
});
