/**
 * The editable `rooms` document, with every operation undoable.
 *
 * Wraps `useUndoable` so the page never touches the history stack directly, and owns
 * the selected-room index — which the legacy app kept as a module-level `activeRoom`
 * that could point past the end of the array after a delete.
 *
 * Undo covers the room/item document only, not the Project Details fields. That matches
 * the legacy scope, and deliberately so: those are plain text inputs whose own native
 * undo is what a user reaches for while typing in them, and hijacking Ctrl+Z there
 * would be surprising.
 */
import { useCallback, useState } from "react";
import { useUndoable } from "./useUndoable";
import { newLineItem, newRoom, type LineItemDoc, type RoomDoc } from "./document";

export interface EstimateDocument {
  rooms: RoomDoc[];
  /** Null when there are no rooms at all. */
  activeIndex: number | null;
  activeRoom: RoomDoc | null;
  selectRoom: (index: number) => void;

  addRoom: () => void;
  renameRoom: (index: number, name: string) => void;
  deleteRoom: (index: number) => void;

  addItem: () => void;
  /** Append a fully-formed line, e.g. one picked from the rate list. */
  addPreparedItem: (item: LineItemDoc) => void;
  updateItem: <K extends keyof LineItemDoc>(
    itemIndex: number,
    field: K,
    value: LineItemDoc[K],
  ) => void;
  deleteItem: (itemIndex: number) => void;

  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Replace the document and drop history. For a reload, not an edit. */
  reset: (rooms: RoomDoc[]) => void;
  /**
   * Merge in rooms from elsewhere — currently the AI parser.
   *
   * An ordinary undoable operation, not a reset: applying a parse must be reversible
   * with the same Undo button as everything else. The legacy drawer overwrote the
   * document outright with no way back.
   */
  applyRooms: (rooms: RoomDoc[], mode: "append" | "replace") => void;
}

export function useEstimateDocument(initial: RoomDoc[]): EstimateDocument {
  const history = useUndoable<RoomDoc[]>(initial);
  const rooms = history.present;

  const [selected, setSelected] = useState(0);
  // Derived rather than stored, so no code path can leave it pointing past the end —
  // the legacy `activeRoom` had to be repaired by hand in `delRoom`, and was not in
  // `undoAction`, where an undone add left it dangling.
  const activeIndex = rooms.length === 0 ? null : Math.min(selected, rooms.length - 1);
  const activeRoom = activeIndex === null ? null : (rooms[activeIndex] ?? null);

  const { update, reset: resetHistory } = history;

  const addRoom = useCallback(() => {
    update((current) => [...current, newRoom(current)]);
    // Select the room just created. Length before the update is its index after it.
    setSelected(rooms.length);
  }, [update, rooms.length]);

  const renameRoom = useCallback(
    (index: number, name: string) => {
      update(
        (current) => current.map((room, i) => (i === index ? { ...room, name } : room)),
        `room:${index}:name`,
      );
    },
    [update],
  );

  const deleteRoom = useCallback(
    (index: number) => {
      update((current) => current.filter((_, i) => i !== index));
      setSelected((current) => (current > index ? current - 1 : current));
    },
    [update],
  );

  const addItem = useCallback(() => {
    if (activeIndex === null) return;
    update((current) =>
      current.map((room, i) =>
        i === activeIndex ? { ...room, items: [...room.items, newLineItem()] } : room,
      ),
    );
  }, [update, activeIndex]);

  const addPreparedItem = useCallback(
    (item: LineItemDoc) => {
      if (activeIndex === null) return;
      update((current) =>
        current.map((room, i) =>
          i === activeIndex ? { ...room, items: [...room.items, item] } : room,
        ),
      );
    },
    [update, activeIndex],
  );

  const updateItem = useCallback(
    <K extends keyof LineItemDoc>(itemIndex: number, field: K, value: LineItemDoc[K]) => {
      if (activeIndex === null) return;
      update(
        (current) =>
          current.map((room, i) =>
            i === activeIndex
              ? {
                  ...room,
                  items: room.items.map((item, j) =>
                    j === itemIndex ? { ...item, [field]: value } : item,
                  ),
                }
              : room,
          ),
        // Consecutive keystrokes in one cell collapse to a single undo step.
        `item:${activeIndex}:${itemIndex}:${String(field)}`,
      );
    },
    [update, activeIndex],
  );

  const deleteItem = useCallback(
    (itemIndex: number) => {
      if (activeIndex === null) return;
      update((current) =>
        current.map((room, i) =>
          i === activeIndex
            ? { ...room, items: room.items.filter((_, j) => j !== itemIndex) }
            : room,
        ),
      );
    },
    [update, activeIndex],
  );

  const reset = useCallback(
    (next: RoomDoc[]) => {
      resetHistory(next);
      setSelected(0);
    },
    [resetHistory],
  );

  const applyRooms = useCallback(
    (incoming: RoomDoc[], mode: "append" | "replace") => {
      update((current) => (mode === "replace" ? incoming : [...current, ...incoming]));
      // Land on the first room that just arrived, so the result is visible rather than
      // hidden behind whichever room happened to be selected.
      setSelected(mode === "replace" ? 0 : rooms.length);
    },
    [update, rooms.length],
  );

  return {
    rooms,
    activeIndex,
    activeRoom,
    selectRoom: setSelected,
    addRoom,
    renameRoom,
    deleteRoom,
    addItem,
    addPreparedItem,
    updateItem,
    deleteItem,
    undo: history.undo,
    redo: history.redo,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    reset,
    applyRooms,
  };
}
