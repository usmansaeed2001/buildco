/**
 * The estimate's `rooms` document: its shape, its defaults, and how it is normalised
 * for the wire.
 *
 * `EstimateOut.rooms` is typed as `Record<string, unknown>[]` — the API stores it as
 * JSONB and does not narrow it on read, because documents written by the legacy app are
 * still in the database and may contain anything. Writes are the opposite: `Room` and
 * `LineItem` are strict Pydantic models with `extra="forbid"`, so a PATCH carrying a
 * stray key, a legacy `unit_cost` spelling, or a category the enum does not know is a
 * 422 for the *whole* estimate.
 *
 * That asymmetry is the entire reason this module exists. Reads are tolerant, writes
 * are exact, and `toWireRooms` is the one place that converts between them.
 */
import { ITEM_CATEGORIES, ITEM_UNITS, type ItemCategory, type ItemUnit } from "@/domain/enums";
import { toDecimal, toMoneyString, toQuantityString } from "@/domain/money";
import type { StoredLineItem, StoredRoom } from "@/domain/estimateTotals";

/** A line item as the editor holds it: every field present, nothing optional. */
export interface LineItemDoc {
  name: string;
  /** Free text, not `ItemCategory`. A team can define its own categories in Settings,
   *  and legacy documents contain values the enum never had. The enums are what the UI
   *  *offers*; the API accepts any bounded string. */
  category: string;
  unit: string;
  /** Kept as the raw string the user typed, so "1." and "0.50" survive mid-edit. */
  quantity: string;
  unitCost: string;
  isCustom: boolean;
  catalogueId: string | null;
  notes: string;
}

export interface RoomDoc {
  name: string;
  items: LineItemDoc[];
}

/** The fields of an estimate the editor may change. */
export interface EstimateDetails {
  project_name: string;
  client_name: string;
  pm_name: string;
  insurance_carrier: string;
  notes: string;
}

export const DEFAULT_CATEGORY: string = "other";
export const DEFAULT_UNIT: string = "LF";

function isCategory(value: unknown): value is ItemCategory {
  return ITEM_CATEGORIES.includes(value as ItemCategory);
}

function isUnit(value: unknown): value is ItemUnit {
  return ITEM_UNITS.includes(value as ItemUnit);
}

/**
 * A category to store.
 *
 * No longer coerced to `other`. The API's `LineItem.category` is a bounded string
 * rather than the enum, precisely so that a team's own categories are usable and so
 * that legacy values (`electrical`, `plumbing`) survive a save. Rewriting them was
 * silently destroying a classification someone had chosen.
 *
 * Empty falls back to the default, because the field cannot be blank on screen.
 */
export function normaliseCategory(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_CATEGORY;
  const trimmed = value.trim();
  return trimmed === "" ? DEFAULT_CATEGORY : trimmed.slice(0, LIMITS.category);
}

export function normaliseUnit(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_UNIT;
  const trimmed = value.trim();
  return trimmed === "" ? DEFAULT_UNIT : trimmed.slice(0, LIMITS.unit);
}

/** Whether a value is one of the built-ins the UI offers by default. */
export function isBuiltInCategory(value: string): boolean {
  return isCategory(value);
}

export function isBuiltInUnit(value: string): boolean {
  return isUnit(value);
}

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * Widen a stored document into the editor's shape.
 *
 * Tolerant in the same way `estimateTotals.computeTotals` is: a malformed room, a
 * missing `items` array, or an item with no price yields a usable default rather than
 * throwing. A stored estimate that fails to open is unrecoverable through the UI.
 */
export function readRooms(stored: readonly unknown[] | null | undefined): RoomDoc[] {
  const rooms: RoomDoc[] = [];

  for (const raw of stored ?? []) {
    if (typeof raw !== "object" || raw === null) continue;
    const room = raw as StoredRoom;
    const items = Array.isArray(room.items) ? room.items : [];

    rooms.push({
      name: typeof room.name === "string" ? room.name : "",
      items: items
        .filter((item): item is StoredLineItem => typeof item === "object" && item !== null)
        .map(readLineItem),
    });
  }

  return rooms;
}

function readLineItem(item: StoredLineItem): LineItemDoc {
  return {
    name: typeof item.name === "string" ? item.name : "",
    category: normaliseCategory(item.category),
    unit: normaliseUnit(item.unit),
    quantity: numericText(item.quantity),
    // `unit_cost` is the legacy spelling; `estimateTotals.itemUnitCost` reads both for
    // the same reason.
    unitCost: numericText(item.unitCost ?? item.unit_cost),
    isCustom: item.isCustom !== false,
    catalogueId: typeof item.catalogueId === "string" ? item.catalogueId : null,
    notes: typeof item.notes === "string" ? item.notes : "",
  };
}

/** A number field as editable text. Missing or unparseable becomes "0", not "NaN". */
function numericText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "0";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return "0";
}

// ── Writing ─────────────────────────────────────────────────────────────────

export interface WireLineItem {
  name: string;
  category: string;
  unit: string;
  quantity: string;
  unitCost: string;
  isCustom: boolean;
  catalogueId: string | null;
  notes: string;
}

export interface WireRoom {
  name: string;
  items: WireLineItem[];
}

/** Length caps taken from the live OpenAPI schema, not guessed. Exceeding one is a 422
 *  for the whole estimate, so a pasted wall of text must be clamped, not sent. */
export const LIMITS = {
  roomName: 200,
  itemName: 300,
  category: 100,
  unit: 50,
  notes: 2000,
  catalogueId: 100,
} as const;

/** What a room with no stored name is called. Matches `estimateTotals.computeTotals`. */
export const UNTITLED_ROOM = "Untitled room";
export const UNTITLED_ITEM = "Untitled item";

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Normalise the document for a PATCH.
 *
 * Quantities and costs go out as strings: the API's `Decimal` fields accept them, and a
 * string is the only form that cannot pick up a floating-point representation on the
 * way.
 *
 * The rest of this function exists because `Room` and `LineItem` are stricter than the
 * editor is, and every one of these rules was read off the live schema rather than
 * assumed:
 *
 * - **`name` is `minLength: 1` on both.** A room read from a legacy document with no
 *   name, and — far more common — a line the user has just added and not yet typed
 *   into, would otherwise 422 the *entire* estimate. Every subsequent autosave would
 *   fail too, so one blank row anywhere makes the whole document unsaveable.
 * - **A brand-new, untouched line is dropped rather than named.** Sending
 *   "Untitled item" would put a word in the user's row that they then have to delete.
 *   It stays on screen either way, because the editor does not re-seed from the
 *   response; it starts being persisted as soon as it carries anything at all.
 * - **Lengths are clamped** to the schema's maxima.
 */
export function toWireRooms(rooms: readonly RoomDoc[]): WireRoom[] {
  return rooms.map((room) => ({
    name: clamp(room.name.trim() || UNTITLED_ROOM, LIMITS.roomName),
    items: room.items.filter((item) => !isBlankLineItem(item)).map(toWireLineItem),
  }));
}

function toWireLineItem(item: LineItemDoc): WireLineItem {
  return {
    name: clamp(item.name.trim() || UNTITLED_ITEM, LIMITS.itemName),
    category: normaliseCategory(item.category),
    unit: normaliseUnit(item.unit),
    // Four decimal places for a quantity, two for a cost — the API's patterns differ,
    // and rounding a quantity to cents would turn 0.125 of a square into 0.13.
    quantity: toQuantityString(item.quantity),
    unitCost: toMoneyString(item.unitCost),
    isCustom: item.isCustom,
    catalogueId: item.catalogueId ? clamp(item.catalogueId, LIMITS.catalogueId) : null,
    notes: clamp(item.notes, LIMITS.notes),
  };
}

// ── Construction ────────────────────────────────────────────────────────────

/** `Room 1`, `Room 2`, … — the legacy naming, based on the count rather than an index,
 *  so deleting and re-adding does not reuse a name already on screen. */
export function newRoom(existing: readonly RoomDoc[]): RoomDoc {
  const used = new Set(existing.map((room) => room.name));
  let n = existing.length + 1;
  while (used.has(`Room ${n}`)) n += 1;
  return { name: `Room ${n}`, items: [] };
}

/** Defaults carried over verbatim from `addItem` in the legacy `app.html`. */
export function newLineItem(): LineItemDoc {
  return {
    name: "",
    category: DEFAULT_CATEGORY,
    unit: DEFAULT_UNIT,
    quantity: "1",
    unitCost: "0",
    isCustom: true,
    catalogueId: null,
    notes: "",
  };
}

/** Whether a line carries anything worth saving — used to warn before submitting. */
export function isBlankLineItem(item: LineItemDoc): boolean {
  return item.name.trim() === "" && toDecimal(item.unitCost).isZero();
}
