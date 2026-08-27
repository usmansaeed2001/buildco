/**
 * The estimate export, as rows.
 *
 * Kept separate from `lib/csv.ts` (which only escapes and downloads) so the *layout* —
 * which columns, where the subtotals sit, what the footer says — is testable without
 * touching the DOM or a Blob.
 *
 * The shape follows the legacy `exportCSV`: a header block naming the estimate, a blank
 * line, then the item table with a subtotal row after each room and a project total at
 * the end. Two things differ, both because the legacy output was wrong rather than
 * merely different:
 *
 * - Totals come from `domain/estimateTotals`, which rounds per room the way the backend
 *   does. The legacy export summed raw floats, so the CSV total could disagree with
 *   both the screen and the emailed figure.
 * - Every value is escaped by `lib/csv.ts`. The legacy version quoted only some columns,
 *   so a comma in a note shifted every cell after it.
 */
import type { CsvValue } from "@/lib/csv";
import { computeTotals, roomTotal } from "@/domain/estimateTotals";
import { lineTotal } from "@/domain/money";
import { ESTIMATE_STATUS_LABELS, type EstimateStatus } from "@/domain/enums";
import type { EstimateDetails, RoomDoc } from "./document";

export const ITEM_COLUMNS = [
  "Room",
  "Item",
  "Category",
  "Unit",
  "Qty",
  "Unit Cost",
  "Total",
  "Notes",
] as const;

export function buildEstimateCsv({
  identifier,
  status,
  details,
  rooms,
}: {
  identifier: string;
  status: EstimateStatus;
  details: EstimateDetails;
  rooms: readonly RoomDoc[];
}): CsvValue[][] {
  const rows: CsvValue[][] = [
    ["Claim ID", "Project", "Client", "PM", "Carrier", "Status"],
    [
      identifier,
      details.project_name,
      details.client_name,
      details.pm_name,
      details.insurance_carrier,
      ESTIMATE_STATUS_LABELS[status],
    ],
    [],
  ];

  if (details.notes.trim()) {
    rows.push(["Notes", details.notes], []);
  }

  rows.push([...ITEM_COLUMNS]);

  for (const room of rooms) {
    for (const item of room.items) {
      rows.push([
        room.name,
        item.name,
        item.category,
        item.unit,
        item.quantity,
        item.unitCost,
        lineTotal(item.quantity, item.unitCost).toFixed(2),
        item.notes,
      ]);
    }
    // A subtotal even for an empty room: its absence would read as a missing row
    // rather than as a room nobody has priced yet.
    rows.push(["", "", "", "", "", `${room.name} subtotal`, roomTotal(room).toFixed(2), ""]);
    rows.push([]);
  }

  rows.push(["", "", "", "", "", "PROJECT TOTAL", computeTotals(rooms).total.toFixed(2), ""]);
  return rows;
}

/** `CLM-100200.csv`. Falls back so a document with no identifier still downloads. */
export function estimateCsvFilename(identifier: string): string {
  return `${identifier || "estimate"}.csv`;
}
