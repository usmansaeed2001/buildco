/**
 * Totals over an estimate's room/item document.
 *
 * A faithful port of `apps/api/app/services/rules/estimate_totals.py`. The API returns
 * `totals` on every estimate response and is authoritative; this exists so the editor
 * can show a total that updates as you type, without a round trip per keystroke.
 *
 * Because there are now two implementations, they must agree exactly, and the way they
 * could quietly disagree is rounding:
 *
 *   **Each room is rounded to cents, then the rounded room totals are summed.**
 *
 * Not "sum everything then round once". With enough rooms whose raw subtotals end in
 * half a cent, the two approaches differ. The legacy JS did neither — it summed raw
 * floats with no rounding at all (`app.html`: `reduce((s,i)=>s+(i.quantity||0)*(i.unitCost||0),0)`),
 * which is where the drift between the browser's total and the emailed total came from.
 *
 * `src/domain/estimateTotals.test.ts` pins this against the Python behaviour.
 */
import { Decimal } from "decimal.js";
import { roundMoney, toDecimal } from "./money";

/** A line item as stored in the `rooms` JSONB document.
 *
 * camelCase, because `app/routers/estimates.py` dumps rooms with `by_alias=True`.
 * Every field is optional: this type describes what may be read back, including rows
 * written by the legacy app. */
export interface StoredLineItem {
  name?: string;
  category?: string;
  unit?: string;
  quantity?: string | number | null;
  unitCost?: string | number | null;
  /** Only ever seen on legacy rows; reads tolerate it, writes never produce it. */
  unit_cost?: string | number | null;
  isCustom?: boolean;
  catalogueId?: string | null;
  notes?: string;
}

export interface StoredRoom {
  name?: string;
  items?: StoredLineItem[];
}

export interface RoomTotal {
  name: string;
  itemCount: number;
  total: Decimal;
}

export interface EstimateTotals {
  total: Decimal;
  roomCount: number;
  itemCount: number;
  rooms: RoomTotal[];
}

/** The unit cost of an item, accepting either spelling.
 *
 * `estimate_totals` reads `item.get("unitCost", item.get("unit_cost"))` for the same
 * reason: documents written before the rename are still in the database. */
export function itemUnitCost(item: StoredLineItem): Decimal {
  return toDecimal(item.unitCost ?? item.unit_cost);
}

/** One line's extended price, rounded — what the row's Total cell shows. */
export function itemTotal(item: StoredLineItem): Decimal {
  return roundMoney(toDecimal(item.quantity).times(itemUnitCost(item)));
}

/**
 * Total a `rooms` document.
 *
 * Tolerant by design, matching the Python: a malformed room, a missing `items` array,
 * or an item with no price contributes zero rather than throwing.
 */
export function computeTotals(rooms: readonly StoredRoom[] | null | undefined): EstimateTotals {
  const roomTotals: RoomTotal[] = [];
  let grandTotal = new Decimal(0);
  let itemCount = 0;

  for (const room of rooms ?? []) {
    if (typeof room !== "object" || room === null) continue;

    const items = Array.isArray(room.items) ? room.items : [];

    let roomSum = new Decimal(0);
    let counted = 0;
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      roomSum = roomSum.plus(toDecimal(item.quantity).times(itemUnitCost(item)));
      counted += 1;
    }

    // Round here, per room, before accumulating — see the note at the top.
    const rounded = roundMoney(roomSum);
    grandTotal = grandTotal.plus(rounded);
    itemCount += counted;

    roomTotals.push({
      name: room.name || "Untitled room",
      itemCount: counted,
      total: rounded,
    });
  }

  return {
    total: roundMoney(grandTotal),
    roomCount: roomTotals.length,
    itemCount,
    rooms: roomTotals,
  };
}

/** Subtotal for a single room. */
export function roomTotal(room: StoredRoom | null | undefined): Decimal {
  return computeTotals(room ? [room] : []).total;
}
