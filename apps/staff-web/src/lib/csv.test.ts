import { describe, expect, it, vi, afterEach } from "vitest";
import { downloadCsv, escapeCsvValue, toCsv } from "./csv";

describe("escapeCsvValue", () => {
  it("leaves a plain value untouched", () => {
    expect(escapeCsvValue("Drywall")).toBe("Drywall");
    expect(escapeCsvValue(12.5)).toBe("12.5");
  });

  it("renders null and undefined as an empty cell rather than the word", () => {
    expect(escapeCsvValue(null)).toBe("");
    expect(escapeCsvValue(undefined)).toBe("");
  });

  it("quotes a value containing a comma", () => {
    expect(escapeCsvValue("Smith, John")).toBe('"Smith, John"');
  });

  it("doubles an embedded quote — the case the legacy exporter corrupted", () => {
    expect(escapeCsvValue('6" baseboard')).toBe('"6"" baseboard"');
  });

  it("quotes a value containing a newline", () => {
    expect(escapeCsvValue("line one\nline two")).toBe('"line one\nline two"');
  });
});

describe("toCsv", () => {
  it("joins cells with commas and rows with CRLF", () => {
    expect(
      toCsv([
        ["Room", "Item", "Total"],
        ["Kitchen", "Drywall", "120.00"],
      ]),
    ).toBe("Room,Item,Total\r\nKitchen,Drywall,120.00");
  });

  it("keeps columns aligned when a cell contains a comma", () => {
    const csv = toCsv([
      ["Client", "Notes"],
      ["Smith, John", "Replace trim, then paint"],
    ]);
    expect(csv.split("\r\n")[1]).toBe('"Smith, John","Replace trim, then paint"');
  });

  it("emits an empty document for no rows", () => {
    expect(toCsv([])).toBe("");
  });
});

describe("downloadCsv", () => {
  afterEach(() => vi.restoreAllMocks());

  function stubObjectUrl() {
    const createObjectURL = vi.fn(() => "blob:stub");
    const revokeObjectURL = vi.fn();
    // jsdom implements neither, so they are defined rather than spied on.
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true });
    return { createObjectURL, revokeObjectURL };
  }

  it("clicks an anchor carrying the blob and the filename, then removes it", () => {
    stubObjectUrl();
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });

    downloadCsv("CLM-000123", [["a", "b"]]);

    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.download).toBe("CLM-000123.csv");
    expect(clicked[0]!.href).toBe("blob:stub");
    // Removed again, so repeated exports do not litter the document.
    expect(document.querySelector("a[download]")).toBeNull();
  });

  it("does not double the extension when the caller already supplied one", () => {
    stubObjectUrl();
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });

    downloadCsv("estimate.csv", [["a"]]);

    expect(clicked[0]!.download).toBe("estimate.csv");
  });

  it("revokes the object URL, but not before the click has returned", () => {
    const { revokeObjectURL } = stubObjectUrl();
    vi.useFakeTimers();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    downloadCsv("x", [["a"]]);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:stub");
    vi.useRealTimers();
  });
});
