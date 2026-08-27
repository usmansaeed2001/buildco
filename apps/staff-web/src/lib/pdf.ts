/**
 * Rendering a DOM node to a paginated PDF.
 *
 * Same approach as the legacy `downloadPDF`: rasterise with html2canvas, then slice the
 * bitmap across A4 pages with jsPDF. It produces an image-based PDF — no selectable
 * text, no accessibility — which is a real drawback, but it guarantees the file looks
 * exactly like the report on screen, and the alternative (laying the document out twice,
 * once in HTML and once in jsPDF's drawing API) drifts the moment either changes.
 *
 * Differences from the legacy version, all of which it got wrong:
 *
 * - **Both libraries are real dependencies.** They were injected as `<script>` tags from
 *   a CDN on first click, so generating a report failed offline, was silently subject to
 *   whatever version the CDN served, and blocked on a third-party request.
 * - **The last page is not padded.** The old loop always emitted full-height pages, so a
 *   report ending a third of the way down produced a trailing expanse of white.
 * - **Failures are surfaced.** It caught nothing, so a rasterisation error left the
 *   button stuck on "Generating PDF…" for ever.
 *
 * The heavy imports are dynamic: together they are a large chunk of the bundle, and an
 * estimate editor that nobody exports from should not pay for them on load.
 */

/** A4 portrait, in millimetres. */
const PAGE_WIDTH_MM = 210;
const PAGE_HEIGHT_MM = 297;
const MARGIN_MM = 10;

export interface PdfResult {
  pageCount: number;
  fileName: string;
}

/**
 * Rasterise `node` and save it as `fileName`.
 *
 * `scale: 2` is the legibility floor — at 1 the rendered text is visibly soft once the
 * bitmap is scaled to A4. Higher is sharper and quadratically larger; 2 keeps a typical
 * estimate comfortably under a megabyte.
 */
export async function downloadNodeAsPdf(
  node: HTMLElement,
  fileName: string,
  { scale = 2 }: { scale?: number } = {},
): Promise<PdfResult> {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
    import("html2canvas"),
    import("jspdf"),
  ]);

  const canvas = await html2canvas(node, {
    scale,
    // The report is rendered off-screen; without this it rasterises as transparent and
    // the PDF comes out with black text on black.
    backgroundColor: "#ffffff",
    useCORS: true,
    logging: false,
  });

  const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });

  const contentWidth = PAGE_WIDTH_MM - MARGIN_MM * 2;
  const contentHeight = PAGE_HEIGHT_MM - MARGIN_MM * 2;
  // How tall the whole bitmap becomes once scaled to the content width.
  const scaledHeight = (canvas.height * contentWidth) / canvas.width;

  const pageCount = Math.max(1, Math.ceil(scaledHeight / contentHeight));
  const image = canvas.toDataURL("image/png");

  for (let page = 0; page < pageCount; page += 1) {
    if (page > 0) pdf.addPage();

    // The image is placed once per page, shifted up so the relevant slice lands inside
    // the margins; the rest falls outside the page and is clipped. Simpler and more
    // faithful than re-cropping the canvas per page, at the cost of embedding the
    // bitmap once per page.
    pdf.addImage(
      image,
      "PNG",
      MARGIN_MM,
      MARGIN_MM - page * contentHeight,
      contentWidth,
      scaledHeight,
    );
  }

  pdf.save(fileName);
  return { pageCount, fileName };
}

/** `CLM-100200-buildco.pdf`, matching the legacy naming. */
export function reportFileName(identifier: string): string {
  return `${identifier || "estimate"}-buildco.pdf`;
}
