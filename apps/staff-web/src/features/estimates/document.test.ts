import { describe, expect, it } from "vitest";
import {
  LIMITS,
  UNTITLED_ITEM,
  UNTITLED_ROOM,
  isBuiltInCategory,
  isBlankLineItem,
  newLineItem,
  newRoom,
  normaliseCategory,
  normaliseUnit,
  readRooms,
  toWireRooms,
} from "./document";

describe("readRooms", () => {
  it("widens a well-formed stored document", () => {
    const rooms = readRooms([
      { name: "Kitchen", items: [{ name: "Drywall", category: "drywall", unit: "SF", quantity: 2, unitCost: 10.5 }] },
    ]);

    expect(rooms).toEqual([
      {
        name: "Kitchen",
        items: [
          {
            name: "Drywall",
            category: "drywall",
            unit: "SF",
            quantity: "2",
            unitCost: "10.5",
            isCustom: true,
            catalogueId: null,
            notes: "",
          },
        ],
      },
    ]);
  });

  it("reads the legacy unit_cost spelling", () => {
    const [room] = readRooms([{ name: "Hall", items: [{ name: "Trim", unit_cost: "7.25" }] }]);
    expect(room!.items[0]!.unitCost).toBe("7.25");
  });

  it("prefers unitCost when a row carries both spellings", () => {
    const [room] = readRooms([
      { name: "Hall", items: [{ name: "Trim", unitCost: "9.00", unit_cost: "7.25" }] },
    ]);
    expect(room!.items[0]!.unitCost).toBe("9.00");
  });

  it("survives a document that is malformed rather than blanking the editor", () => {
    const rooms = readRooms([
      null,
      "not a room",
      { name: "No items" },
      { name: "Bad items", items: [null, 42, { name: "Real" }] },
    ] as unknown[]);

    expect(rooms).toHaveLength(2);
    expect(rooms[0]).toEqual({ name: "No items", items: [] });
    expect(rooms[1]!.items).toHaveLength(1);
    expect(rooms[1]!.items[0]!.name).toBe("Real");
  });

  it("defaults a missing price to 0 rather than NaN", () => {
    const [room] = readRooms([{ name: "R", items: [{ name: "x" }] }]);
    expect(room!.items[0]!.quantity).toBe("0");
    expect(room!.items[0]!.unitCost).toBe("0");
  });

  it("treats a missing rooms array as no rooms", () => {
    expect(readRooms(null)).toEqual([]);
    expect(readRooms(undefined)).toEqual([]);
    expect(readRooms([])).toEqual([]);
  });
});

describe("normalisation", () => {
  it("keeps a category the API accepts", () => {
    expect(normaliseCategory("flooring")).toBe("flooring");
  });

  it("keeps a legacy category rather than rewriting it", () => {
    // This used to coerce to `other`, because the API's enum rejected anything else.
    // `LineItem.category` is now a bounded string, so someone's classification
    // survives a save instead of being silently destroyed.
    expect(normaliseCategory("electrical")).toBe("electrical");
    expect(normaliseCategory("plumbing")).toBe("plumbing");
  });

  it("keeps a team's own category and unit", () => {
    expect(normaliseCategory("Roofing")).toBe("Roofing");
    expect(normaliseUnit("Roll")).toBe("Roll");
  });

  it("falls back to a default only for a blank or missing value", () => {
    expect(normaliseCategory(undefined)).toBe("other");
    expect(normaliseCategory("   ")).toBe("other");
    expect(normaliseUnit("")).toBe("LF");
  });

  it("still bounds the length, since the API does", () => {
    expect(normaliseUnit("x".repeat(80))).toHaveLength(50);
  });

  it("knows which values are built in, for grouping the dropdown", () => {
    expect(isBuiltInCategory("drywall")).toBe(true);
    expect(isBuiltInCategory("Roofing")).toBe(false);
  });
});

describe("toWireRooms", () => {
  it("never sends a blank name, which the API rejects with minLength: 1", () => {
    // The whole estimate 422s if any one row breaks this, so a single unnamed room or
    // priced-but-unnamed line makes every later autosave fail too.
    const priced = { ...newLineItem(), unitCost: "12.00" };
    const wire = toWireRooms([{ name: "", items: [priced] }]);

    expect(wire[0]!.name).toBe(UNTITLED_ROOM);
    expect(wire[0]!.items[0]!.name).toBe(UNTITLED_ITEM);
  });

  it("drops a row the user has added but not touched, rather than naming it for them", () => {
    const wire = toWireRooms([{ name: "Kitchen", items: [newLineItem()] }]);
    expect(wire[0]!.items).toEqual([]);
  });

  it("keeps the row as soon as it carries anything", () => {
    const named = { ...newLineItem(), name: "Drywall" };
    expect(toWireRooms([{ name: "Kitchen", items: [named] }])[0]!.items).toHaveLength(1);
  });

  it("trims a name rather than sending whitespace as content", () => {
    const padded = { ...newLineItem(), name: "  Drywall  " };
    expect(toWireRooms([{ name: " Kitchen ", items: [padded] }])[0]!.name).toBe("Kitchen");
    expect(toWireRooms([{ name: "K", items: [padded] }])[0]!.items[0]!.name).toBe("Drywall");
  });

  it("clamps to the lengths the schema allows, so a paste cannot 422 the estimate", () => {
    const long = { ...newLineItem(), name: "x".repeat(500), notes: "n".repeat(3000) };
    const wire = toWireRooms([{ name: "r".repeat(400), items: [long] }]);

    expect(wire[0]!.name).toHaveLength(LIMITS.roomName);
    expect(wire[0]!.items[0]!.name).toHaveLength(LIMITS.itemName);
    expect(wire[0]!.items[0]!.notes).toHaveLength(LIMITS.notes);
  });

  it("keeps four decimal places on a quantity but two on a cost", () => {
    // The API's patterns differ: \d{0,4} after the point for a quantity, \d{0,2} for a
    // cost. Rounding a quantity to cents would turn an eighth of a square into 0.13.
    const item = { ...newLineItem(), name: "Sq", quantity: "0.125", unitCost: "10.005" };
    const wire = toWireRooms([{ name: "R", items: [item] }])[0]!.items[0]!;

    expect(wire.quantity).toBe("0.125");
    expect(wire.unitCost).toBe("10.01");
  });

  it("sends money and quantities as fixed-precision strings", () => {
    const wire = toWireRooms([
      {
        name: "Kitchen",
        items: [
          {
            name: "Drywall",
            category: "drywall",
            unit: "SF",
            quantity: "2",
            unitCost: "10.5",
            isCustom: true,
            catalogueId: null,
            notes: "",
          },
        ],
      },
    ]);

    expect(wire[0]!.items[0]!.quantity).toBe("2");
    expect(wire[0]!.items[0]!.unitCost).toBe("10.50");
  });

  it("emits exactly the keys the request schema allows", () => {
    const wire = toWireRooms([{ name: "R", items: [{ ...newLineItem(), name: "Drywall" }] }]);

    expect(Object.keys(wire[0]!).sort()).toEqual(["items", "name"]);
    expect(Object.keys(wire[0]!.items[0]!).sort()).toEqual([
      "catalogueId",
      "category",
      "isCustom",
      "name",
      "notes",
      "quantity",
      "unit",
      "unitCost",
    ]);
  });

  it("normalises a mid-edit quantity like \"1.\" instead of sending it raw", () => {
    const item = { ...newLineItem(), name: "Drywall", quantity: "1." };
    expect(toWireRooms([{ name: "R", items: [item] }])[0]!.items[0]!.quantity).toBe("1");
  });

  it("sends a legacy category through untouched", () => {
    const item = { ...newLineItem(), name: "Outlet", category: "electrical" };
    expect(toWireRooms([{ name: "R", items: [item] }])[0]!.items[0]!.category).toBe("electrical");
  });

  it("round-trips a document read from storage", () => {
    const wire = toWireRooms(readRooms([{ name: "Hall", items: [{ name: "Trim", unit_cost: "7.25" }] }]));
    expect(wire[0]!.items[0]!.unitCost).toBe("7.25");
    expect(wire[0]!.items[0]).not.toHaveProperty("unit_cost");
  });
});

describe("construction", () => {
  it("names a new room after the count", () => {
    expect(newRoom([]).name).toBe("Room 1");
    expect(newRoom([{ name: "Room 1", items: [] }]).name).toBe("Room 2");
  });

  it("does not reuse a name already on screen after a delete", () => {
    // One room deleted, leaving "Room 2": the count would suggest "Room 2" again.
    expect(newRoom([{ name: "Room 2", items: [] }]).name).toBe("Room 3");
  });

  it("gives a new line the legacy defaults", () => {
    expect(newLineItem()).toEqual({
      name: "",
      category: "other",
      unit: "LF",
      quantity: "1",
      unitCost: "0",
      isCustom: true,
      catalogueId: null,
      notes: "",
    });
  });

  it("recognises a line nobody has filled in", () => {
    expect(isBlankLineItem(newLineItem())).toBe(true);
    expect(isBlankLineItem({ ...newLineItem(), name: "Drywall" })).toBe(false);
    expect(isBlankLineItem({ ...newLineItem(), unitCost: "12" })).toBe(false);
  });
});
