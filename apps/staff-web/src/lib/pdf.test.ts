/**
 * Pagination arithmetic and the library contract.
 *
 * html2canvas cannot rasterise anything in jsdom — there is no layout engine — so both
 * libraries are mocked and what is asserted is the *decision*: how many pages a bitmap
 * of a given height produces, what the file is called, and that failures propagate
 * rather than being swallowed. Anything about how the output looks has to be checked by
 * eye; `DEPLOY_CHECKLIST.md` §3.1 covers that.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const addImage = vi.fn();
const addPage = vi.fn();
const save = vi.fn();
const html2canvas = vi.fn();

vi.mock("jspdf", () => ({
  jsPDF: class {
    addImage = addImage;
    addPage = addPage;
    save = save;
  },
}));

vi.mock("html2canvas", () => ({ default: (...args: unknown[]) => html2canvas(...args) }));

const { downloadNodeAsPdf, reportFileName } = await import("./pdf");

/** A4 at the module's own margins: 210−20 wide, 297−20 tall, in millimetres. */
const CONTENT_WIDTH = 190;
const CONTENT_HEIGHT = 277;

/** A fake canvas whose scaled height lands at `heightMm` once fitted to the page. */
function canvasOfScaledHeight(heightMm: number) {
  const width = 1000;
  return {
    width,
    height: (heightMm * width) / CONTENT_WIDTH,
    toDataURL: () => "data:image/png;base64,stub",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  html2canvas.mockResolvedValue(canvasOfScaledHeight(CONTENT_HEIGHT));
});

describe("downloadNodeAsPdf", () => {
  it("produces a single page for content that fits", async () => {
    const result = await downloadNodeAsPdf(document.createElement("div"), "one.pdf");

    expect(result.pageCount).toBe(1);
    expect(addPage).not.toHaveBeenCalled();
    expect(addImage).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("one.pdf");
  });

  it("adds a page per content height, and no more", async () => {
    // Two and a bit pages' worth: the legacy loop padded the last page to full height,
    // leaving a trailing expanse of white on every short report.
    html2canvas.mockResolvedValue(canvasOfScaledHeight(CONTENT_HEIGHT * 2 + 10));

    const result = await downloadNodeAsPdf(document.createElement("div"), "three.pdf");

    expect(result.pageCount).toBe(3);
    expect(addPage).toHaveBeenCalledTimes(2);
    expect(addImage).toHaveBeenCalledTimes(3);
  });

  it("emits one page for an empty node rather than none", async () => {
    html2canvas.mockResolvedValue(canvasOfScaledHeight(0));

    expect((await downloadNodeAsPdf(document.createElement("div"), "empty.pdf")).pageCount).toBe(1);
  });

  it("shifts the bitmap up by one content height per page", async () => {
    html2canvas.mockResolvedValue(canvasOfScaledHeight(CONTENT_HEIGHT * 2));

    await downloadNodeAsPdf(document.createElement("div"), "two.pdf");

    // Argument 3 is the y offset. Page 1 sits at the margin; page 2 is pulled up so its
    // slice lands inside it.
    expect(addImage.mock.calls[0]![3]).toBe(10);
    expect(addImage.mock.calls[1]![3]).toBe(10 - CONTENT_HEIGHT);
  });

  it("rasterises on a white background", async () => {
    // The report is rendered off-screen; without this it comes out transparent, which
    // the PDF renders as black text on black.
    await downloadNodeAsPdf(document.createElement("div"), "x.pdf");

    expect(html2canvas.mock.calls[0]![1]).toMatchObject({ backgroundColor: "#ffffff", scale: 2 });
  });

  it("lets a rasterisation failure reach the caller", async () => {
    // The legacy version caught nothing at all, so the button stuck on "Generating
    // PDF…" for ever with no indication of what had happened.
    html2canvas.mockRejectedValue(new Error("tainted canvas"));

    await expect(downloadNodeAsPdf(document.createElement("div"), "x.pdf")).rejects.toThrow(
      "tainted canvas",
    );
    expect(save).not.toHaveBeenCalled();
  });
});

describe("reportFileName", () => {
  it("names the file after the claim id, matching the legacy convention", () => {
    expect(reportFileName("CLM-100200")).toBe("CLM-100200-buildco.pdf");
  });

  it("still produces a usable name with no identifier", () => {
    expect(reportFileName("")).toBe("estimate-buildco.pdf");
  });
});
