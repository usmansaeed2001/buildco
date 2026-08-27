import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useEstimateDocument } from "./useEstimateDocument";
import type { RoomDoc } from "./document";

const kitchen = (): RoomDoc => ({
  name: "Kitchen",
  items: [
    {
      name: "Drywall",
      category: "drywall",
      unit: "SF",
      quantity: "10",
      unitCost: "2.50",
      isCustom: true,
      catalogueId: null,
      notes: "",
    },
  ],
});

describe("useEstimateDocument", () => {
  it("reports no active room for an empty document", () => {
    const { result } = renderHook(() => useEstimateDocument([]));
    expect(result.current.activeIndex).toBeNull();
    expect(result.current.activeRoom).toBeNull();
  });

  it("adds a room and selects it", () => {
    const { result } = renderHook(() => useEstimateDocument([]));

    act(() => result.current.addRoom());

    expect(result.current.rooms).toHaveLength(1);
    expect(result.current.activeIndex).toBe(0);
    expect(result.current.activeRoom!.name).toBe("Room 1");
  });

  it("renames a room", () => {
    const { result } = renderHook(() => useEstimateDocument([kitchen()]));
    act(() => result.current.renameRoom(0, "Galley"));
    expect(result.current.rooms[0]!.name).toBe("Galley");
  });

  it("keeps the selection in range after deleting the last room", () => {
    const { result } = renderHook(() =>
      useEstimateDocument([kitchen(), { name: "Hall", items: [] }]),
    );

    act(() => result.current.selectRoom(1));
    act(() => result.current.deleteRoom(1));

    // The legacy activeRoom pointed past the end here until delRoom repaired it by hand.
    expect(result.current.rooms).toHaveLength(1);
    expect(result.current.activeIndex).toBe(0);
    expect(result.current.activeRoom!.name).toBe("Kitchen");
  });

  it("keeps pointing at the same room when an earlier one is deleted", () => {
    const { result } = renderHook(() =>
      useEstimateDocument([kitchen(), { name: "Hall", items: [] }]),
    );

    act(() => result.current.selectRoom(1));
    act(() => result.current.deleteRoom(0));

    expect(result.current.activeRoom!.name).toBe("Hall");
  });

  it("adds an item to the active room only", () => {
    const { result } = renderHook(() =>
      useEstimateDocument([kitchen(), { name: "Hall", items: [] }]),
    );

    act(() => result.current.selectRoom(1));
    act(() => result.current.addItem());

    expect(result.current.rooms[0]!.items).toHaveLength(1);
    expect(result.current.rooms[1]!.items).toHaveLength(1);
    expect(result.current.rooms[1]!.items[0]!.quantity).toBe("1");
  });

  it("updates a single field of a single item", () => {
    const { result } = renderHook(() => useEstimateDocument([kitchen()]));

    act(() => result.current.updateItem(0, "unitCost", "3.75"));

    expect(result.current.rooms[0]!.items[0]!.unitCost).toBe("3.75");
    expect(result.current.rooms[0]!.items[0]!.name).toBe("Drywall");
  });

  it("deletes an item", () => {
    const { result } = renderHook(() => useEstimateDocument([kitchen()]));
    act(() => result.current.deleteItem(0));
    expect(result.current.rooms[0]!.items).toHaveLength(0);
  });

  it("ignores item operations when there is no active room", () => {
    const { result } = renderHook(() => useEstimateDocument([]));

    act(() => result.current.addItem());
    act(() => result.current.updateItem(0, "name", "x"));
    act(() => result.current.deleteItem(0));

    expect(result.current.rooms).toEqual([]);
  });

  describe("undo", () => {
    it("restores a deleted room — the legacy delRoom pushed no history at all", () => {
      const { result } = renderHook(() => useEstimateDocument([kitchen()]));

      act(() => result.current.deleteRoom(0));
      expect(result.current.rooms).toHaveLength(0);

      act(() => result.current.undo());

      expect(result.current.rooms).toHaveLength(1);
      expect(result.current.rooms[0]!.items[0]!.name).toBe("Drywall");
    });

    it("restores a deleted item", () => {
      const { result } = renderHook(() => useEstimateDocument([kitchen()]));

      act(() => result.current.deleteItem(0));
      act(() => result.current.undo());

      expect(result.current.rooms[0]!.items).toHaveLength(1);
    });

    it("reverts a whole field edit, not one keystroke", () => {
      const { result } = renderHook(() => useEstimateDocument([kitchen()]));

      act(() => result.current.updateItem(0, "unitCost", "3"));
      act(() => result.current.updateItem(0, "unitCost", "3."));
      act(() => result.current.updateItem(0, "unitCost", "3.7"));
      act(() => result.current.updateItem(0, "unitCost", "3.75"));

      act(() => result.current.undo());

      expect(result.current.rooms[0]!.items[0]!.unitCost).toBe("2.50");
    });

    it("separates edits to different fields", () => {
      const { result } = renderHook(() => useEstimateDocument([kitchen()]));

      act(() => result.current.updateItem(0, "unitCost", "9"));
      act(() => result.current.updateItem(0, "quantity", "4"));
      act(() => result.current.undo());

      expect(result.current.rooms[0]!.items[0]!.quantity).toBe("10");
      expect(result.current.rooms[0]!.items[0]!.unitCost).toBe("9");
    });

    it("redoes what it undid", () => {
      const { result } = renderHook(() => useEstimateDocument([kitchen()]));

      act(() => result.current.addRoom());
      act(() => result.current.undo());
      expect(result.current.rooms).toHaveLength(1);

      act(() => result.current.redo());
      expect(result.current.rooms).toHaveLength(2);
    });

    it("has nothing to undo on a freshly loaded document", () => {
      const { result } = renderHook(() => useEstimateDocument([kitchen()]));
      expect(result.current.canUndo).toBe(false);
      expect(result.current.canRedo).toBe(false);
    });
  });

  it("reset replaces the document and clears history", () => {
    const { result } = renderHook(() => useEstimateDocument([kitchen()]));

    act(() => result.current.addRoom());
    act(() => result.current.reset([{ name: "Fresh", items: [] }]));

    expect(result.current.rooms).toEqual([{ name: "Fresh", items: [] }]);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.activeIndex).toBe(0);
  });
});
