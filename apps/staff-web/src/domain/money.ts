/**
 * Money and quantity arithmetic.
 *
 * Every `Decimal` field on the API — totals, amounts, budgets, quantities, unit costs —
 * arrives as a JSON **string** (`"1234.56"`), because that is how Pydantic v2
 * serialises `Decimal`. Reaching for `Number()` and adding two of them is the exact
 * mistake the backend was written to eliminate: `docs/DATABASE.md` records that money
 * columns became `NUMERIC(12,2)` precisely because totals used to be computed in
 * floating point.
 *
 * So the rule here is: parse at the edge, compute in `Decimal`, format for display,
 * and send strings back. Never let a money value exist as a `number`.
 */
import { Decimal } from "decimal.js";

// Match Python's `decimal` defaults for the operations we perform. ROUND_HALF_UP is
// what `estimate_totals._round` uses, and ties must break the same way on both sides
// or the editor's live total will disagree with the server's by a cent.
Decimal.set({ rounding: Decimal.ROUND_HALF_UP, precision: 28 });

/** Anything a money field can arrive as: a string from JSON, a number from an input,
 *  or missing entirely from a legacy row. */
export type MoneyInput = string | number | Decimal | null | undefined;

export const ZERO = new Decimal(0);

/**
 * Coerce whatever came out of JSON into a Decimal, without ever raising.
 *
 * Mirrors `estimate_totals._money`. Tolerant by design: a stored `rooms` document
 * predating the current schema must still render rather than blanking the page, and
 * this same code runs on the public reviewer view where there is no one to report an
 * error to.
 */
export function toDecimal(value: MoneyInput): Decimal {
  if (value === null || value === undefined || value === "") return ZERO;
  if (value instanceof Decimal) return value;
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() ? parsed : ZERO;
  } catch {
    return ZERO;
  }
}

/** Round to cents, half away from zero — `estimate_totals._round`. */
export function roundMoney(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** A single line's extended price. Mirrors `estimate_totals.line_total`. */
export function lineTotal(quantity: MoneyInput, unitCost: MoneyInput): Decimal {
  return roundMoney(toDecimal(quantity).times(toDecimal(unitCost)));
}

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** `$1,234.56`. The legacy `fmt()`, with the parsing bug removed. */
export function formatMoney(value: MoneyInput): string {
  // toNumber() is safe here and only here: this is the final step to a display
  // string, after all arithmetic is done, and USD totals are far inside the range
  // where a double is exact to the cent.
  return USD.format(roundMoney(toDecimal(value)).toNumber());
}

/** A quantity, with trailing zeros trimmed: `2`, `2.5`, `0.125`. */
export function formatQuantity(value: MoneyInput): string {
  return toDecimal(value).toDecimalPlaces(4).toString();
}

/** Serialise for the wire. The API accepts a string for any Decimal field, which
 *  avoids a float ever appearing in the request body. */
export function toMoneyString(value: MoneyInput): string {
  return roundMoney(toDecimal(value)).toFixed(2);
}

/**
 * Serialise a quantity for the wire.
 *
 * Four decimal places, not two. `LineItem.quantity` and `LineItem.unitCost` are both
 * `Decimal` but they are not the same shape: the API's generated pattern allows
 * `\d{0,4}` after the point for a quantity and `\d{0,2}` for a cost. Sending a
 * quantity through `toMoneyString` would round 0.125 of a square to 0.13 — a silent
 * change to the number the user typed, and a wrong line total to go with it.
 */
export function toQuantityString(value: MoneyInput): string {
  // `toFixed` rather than `toString`, because `toString` yields exponential notation
  // for very small or very large values ("1e-7"), which the API's pattern rejects.
  return toDecimal(value).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed();
}

/** Percentage of `part` against `whole`, clamped to 0–100 for progress bars.
 *  A zero or missing budget yields 0 rather than NaN. */
export function percentOf(part: MoneyInput, whole: MoneyInput): number {
  const total = toDecimal(whole);
  if (total.isZero() || total.isNegative()) return 0;
  const pct = toDecimal(part).dividedBy(total).times(100).toNumber();
  return Math.min(Math.max(pct, 0), 100);
}
