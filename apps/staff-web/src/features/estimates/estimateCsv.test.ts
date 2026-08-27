import { describe, expect, it } from "vitest";
import { toCsv } from "@/lib/csv";
import { buildEstimateCsv, estimateCsvFilename, ITEM_COLUMNS } from "./estimateCsv";
import { newLineItem, type RoomDoc } from "./document";

const details = {
  project_name: "Water damage — kitchen",
  client_name: "Jordan Homeowner",
  pm_name: "Casey",
  insurance_carrier: "Acme Mutual",
  notes: "",
};

function item(overrides: Partial<ReturnType<typeof newLineItem>> = {}) {
  return { ...newLineItem(), ...overrides };
}

const rooms: RoomDoc[] = [
  {
    name: "Kitchen",
    items: [
      item({ name: "Drywall", category: "drywall", unit: "SF", quantity: "10", unitCost: "2.50" }),
      item({ name: "Paint", category: "painting", unit: "SF", quantity: "10", unitCost: "1.25" }),
    ],
  },
  { name: "Hall", items: [item({ name: "Trim", unit: "LF", quantity: "8", unitCost: "3.00" })] },
];

function build(overrides: Partial<Parameters<typeof buildEstimateCsv>[0]> = {}) {
  return buildEstimateCsv({
    identifier: "CLM-100200",
    status: "active",
    details,
    rooms,
    ...overrides,
  });
}

describe("buildEstimateCsv", () => {
  it("opens with the estimate's identifying fields", () => {
    const rows = build();
    expect(rows[0]).toEqual(["Claim ID", "Project", "Client", "PM", "Carrier", "Status"]);
    expect(rows[1]).toEqual([
      "CLM-100200",
      "Water damage — kitchen",
      "Jordan Homeowner",
      "Casey",
      "Acme Mutual",
      "Active",
    ]);
  });

  it("includes every line item", () => {
    const rows = build();
    const names = rows.map((row) => row[1]);
    expect(names).toContain("Drywall");
    expect(names).toContain("Paint");
    expect(names).toContain("Trim");
  });

  it("carries the item columns in the legacy order", () => {
    expect(build().find((row) => row[0] === "Room")).toEqual([...ITEM_COLUMNS]);
  });

  it("computes each line total rather than restating the unit cost", () => {
    const drywall = build().find((row) => row[1] === "Drywall")!;
    expect(drywall[6]).toBe("25.00");
  });

  it("subtotals each room", () => {
    const rows = build();
    expect(rows.find((row) => row[5] === "Kitchen subtotal")![6]).toBe("37.50");
    expect(rows.find((row) => row[5] === "Hall subtotal")![6]).toBe("24.00");
  });

  it("ends with a project total that agrees with the rounded room subtotals", () => {
    const rows = build();
    expect(rows.at(-1)).toEqual(["", "", "", "", "", "PROJECT TOTAL", "61.50", ""]);
  });

  it("subtotals a room with no items, so it does not look like a missing row", () => {
    const rows = build({ rooms: [{ name: "Empty", items: [] }] });
    expect(rows.find((row) => row[5] === "Empty subtotal")![6]).toBe("0.00");
  });

  it("includes the estimate notes only when there are some", () => {
    expect(build().some((row) => row[0] === "Notes")).toBe(false);
    const withNotes = build({ details: { ...details, notes: "Access via side door" } });
    expect(withNotes.find((row) => row[0] === "Notes")![1]).toBe("Access via side door");
  });

  it("keeps columns aligned when a note contains a comma — the legacy corruption", () => {
    const rows = build({
      rooms: [{ name: "Kitchen", items: [item({ name: "Drywall", notes: "Patch, sand, prime" })] }],
    });
    const line = toCsv(rows).split("\r\n").find((row) => row.includes("Drywall"))!;

    expect(line.endsWith('"Patch, sand, prime"')).toBe(true);
    // Eight fields, not ten: the commas inside the note are quoted, not separators.
    expect(line.split('"')[0]!.split(",").filter(Boolean)).toHaveLength(7);
  });

  it("survives an estimate with no rooms at all", () => {
    const rows = build({ rooms: [] });
    expect(rows.at(-1)![6]).toBe("0.00");
  });
});

describe("estimateCsvFilename", () => {
  it("names the file after the claim id", () => {
    expect(estimateCsvFilename("CLM-100200")).toBe("CLM-100200.csv");
  });

  it("still produces a downloadable name with no identifier", () => {
    expect(estimateCsvFilename("")).toBe("estimate.csv");
  });
});
