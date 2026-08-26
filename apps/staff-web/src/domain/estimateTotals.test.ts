/**
 * Ported case-for-case from `apps/api/tests/unit/test_estimate_totals.py`.
 *
 * The point of keeping them aligned is that there are now two implementations of the
 * same arithmetic, and the failure mode if they drift is a customer seeing one total
 * in the editor and a different one in the emailed estimate. When the Python test file
 * changes, change this one.
 */
import { describe, expect, it } from "vitest";
import { computeTotals, type StoredRoom } from "./estimateTotals";
import { lineTotal, toDecimal } from "./money";

/** Mirrors the `room()` helper in the Python test. */
function room(name: string, ...items: [unknown, unknown][]): StoredRoom {
  return {
    name,
    items: items.map(([quantity, unitCost], i) => ({
      name: `Item ${i}`,
      quantity: quantity as string | number,
      unitCost: unitCost as string | number,
    })),
  };
}

describe("computeTotals", () => {
  it("sums quantity times unit cost", () => {
    const result = computeTotals([room("Kitchen", [2, "10.00"], [3, "5.50"])]);

    expect(result.total.toFixed(2)).toBe("36.50");
    expect(result.roomCount).toBe(1);
    expect(result.itemCount).toBe(2);
  });

  it("reports room totals individually", () => {
    const result = computeTotals([room("Kitchen", [2, "10.00"]), room("Bath", [1, "7.25"])]);

    expect(result.rooms.map((r) => r.total.toFixed(2))).toEqual(["20.00", "7.25"]);
    expect(result.rooms.map((r) => r.name)).toEqual(["Kitchen", "Bath"]);
    expect(result.total.toFixed(2)).toBe("27.25");
  });

  it("does not compute money in binary floating point", () => {
    // The plain-JS version of this is 3 * 0.1 === 0.30000000000000004.
    const result = computeTotals([room("R", [3, 0.1])]);

    expect(result.total.toFixed(2)).toBe("0.30");
  });

  it("agrees between string and numeric inputs", () => {
    const asString = computeTotals([room("R", [2, "10.50"])]).total;
    const asNumber = computeTotals([room("R", [2, 10.5])]).total;

    expect(asString.equals(asNumber)).toBe(true);
  });

  it("rounds each room before summing, not once at the end", () => {
    // Three rooms of 0.005 each. Rounding per room gives 0.01 x 3 = 0.03;
    // summing raw and rounding once would give 0.02. The Python rounds per room.
    const rooms = [room("A", [1, "0.005"]), room("B", [1, "0.005"]), room("C", [1, "0.005"])];

    expect(computeTotals(rooms).total.toFixed(2)).toBe("0.03");
  });

  it("accepts snake_case unit_cost from legacy documents", () => {
    const result = computeTotals([{ name: "R", items: [{ quantity: 2, unit_cost: "3.00" }] }]);

    expect(result.total.toFixed(2)).toBe("6.00");
  });

  it("counts a room with no items as a room", () => {
    const result = computeTotals([{ name: "Empty" }]);

    expect(result.roomCount).toBe(1);
    expect(result.itemCount).toBe(0);
    expect(result.total.isZero()).toBe(true);
  });

  it("names an untitled room rather than rendering blank", () => {
    expect(computeTotals([{ items: [] }]).rooms[0]?.name).toBe("Untitled room");
  });

  // ── Tolerance for imperfect stored documents ──────────────────────────────
  // These run on the public reviewer view, where a document predating the current
  // schema must still render rather than blanking the page.

  it.each([
    ["null", null],
    ["empty", []],
    ["an empty room", [{}]],
    ["a non-object room", ["not a room"]],
    ["a null items array", [{ items: null }]],
  ])("totals zero rather than throwing for %s", (_label, rooms) => {
    expect(computeTotals(rooms as StoredRoom[]).total.isZero()).toBe(true);
  });

  it("treats a missing price as zero but still counts the item", () => {
    const result = computeTotals([{ name: "R", items: [{ name: "No price", quantity: 5 }] }]);

    expect(result.total.isZero()).toBe(true);
    expect(result.itemCount).toBe(1);
  });

  it("treats unparseable values as zero rather than fatal", () => {
    const result = computeTotals([
      { name: "R", items: [{ quantity: "many", unitCost: "lots" }] },
    ] as StoredRoom[]);

    expect(result.total.isZero()).toBe(true);
  });
});

describe("lineTotal", () => {
  it("rounds half up to cents", () => {
    expect(lineTotal(1, "0.125").toFixed(2)).toBe("0.13");
    expect(lineTotal(1, "0.135").toFixed(2)).toBe("0.14");
  });
});

describe("toDecimal", () => {
  it("coerces every shape a money field arrives in", () => {
    expect(toDecimal(null).isZero()).toBe(true);
    expect(toDecimal(undefined).isZero()).toBe(true);
    expect(toDecimal("").isZero()).toBe(true);
    expect(toDecimal("nonsense").isZero()).toBe(true);
    expect(toDecimal(Infinity).isZero()).toBe(true);
    expect(toDecimal("12.34").toFixed(2)).toBe("12.34");
  });
});
