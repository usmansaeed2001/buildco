/**
 * Rendering a DOM node to a paginated PDF.
 *
 * Same approach as the legacy `downloadPDF`: rasterise with html2canvas-pro, then slice
 * the bitmap across A4 pages with jsPDF. It produces an image-based PDF — no selectable
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
  /**
   * Photos that could not be embedded, and so appear in the PDF as empty boxes.
   *
   * Reported rather than thrown: a report whose photos failed is still worth having,
   * but the person downloading it needs to be told, because the preview they just
   * approved showed those photos perfectly.
   */
  imagesOmitted: number;
}

/**
 * Get every `<img>` inside `node` into a state html2canvas-pro can actually rasterise.
 * Returns how many could not be.
 *
 * Two separate things go wrong here, both of which produce a silently empty box:
 *
 * **The bitmap is not decoded yet.** html2canvas-pro rasterises from whatever the DOM
 * holds at the moment it runs, so an image still in flight is captured as blank. Since
 * these are signed Cloud Storage URLs fetched fresh, the cold path is the common one.
 * `decode()` resolves only once the bitmap is ready to paint, which `complete` and the
 * load event do not guarantee.
 *
 * **The cached response has no CORS header.** This is the subtle one. GCS adds
 * `Access-Control-Allow-Origin` only when the request carries an `Origin`, and does not
 * send `Vary: Origin`. The preview — and the line-item thumbnails in the editor behind
 * it — load these URLs from a plain `<img>`, which sends no `Origin`, so what lands in
 * the HTTP cache is a response with no CORS header at all. html2canvas-pro then loads
 * its own copy under CORS rules (it must: the canvas is read back with `toDataURL`, so
 * a tainted one would throw), Chrome hands it that same cached entry, the CORS check
 * fails against a response that never had the header, and the photo is dropped. The
 * bucket's CORS policy is correct and irrelevant — the request never reaches it.
 *
 * So each cross-origin image is re-requested with `cache: "reload"`, which bypasses the
 * cache and stores the response it gets back. That request does carry an `Origin`, so
 * the entry it replaces the poisoned one with has the header, and the load
 * html2canvas-pro makes a moment later hits it. It costs one extra download per photo
 * on an explicit user action, which is the right trade for photos that actually appear.
 *
 * A failure here costs that photo, not the whole PDF — but it is counted and returned,
 * rather than swallowed as the empty box it used to be.
 */
async function prepareImages(node: HTMLElement): Promise<{ omitted: number }> {
  const images = Array.from(node.querySelectorAll("img"));
  let omitted = 0;

  await Promise.all(
    images.map(async (image) => {
      const source = image.currentSrc || image.src;
      if (!source) return;

      // Same-origin and `data:`/`blob:` images are never subject to any of this.
      let crossOrigin = false;
      try {
        crossOrigin = new URL(source, location.href).origin !== location.origin;
      } catch {
        return;
      }

      if (crossOrigin) {
        try {
          // `credentials: "omit"` to match how html2canvas-pro loads it — an anonymous
          // request. A credentialled one would be validated against different rules and
          // cached under a different key, leaving the entry it reads untouched.
          const response = await fetch(source, {
            mode: "cors",
            cache: "reload",
            credentials: "omit",
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
        } catch {
          // The bucket will not serve this origin, or the signed URL has expired. The
          // photo will rasterise empty however long we wait for it.
          omitted += 1;
          return;
        }
      }

      try {
        await image.decode();
      } catch {
        omitted += 1;
      }
    }),
  );

  return { omitted };
}

/**
 * Temporarily strip any CSS scaling from `node` and its ancestors.
 *
 * html2canvas-pro reads element geometry from the untransformed box but measures each
 * *word* with a DOM range, which does go through an ancestor `transform`. Under the
 * preview's `scale(0.72)` wrapper, every word advance therefore came back 28% short
 * while the boxes stayed full size, and each word after the first drifted left onto the
 * one before it — the whole report rasterised as overlapping text.
 *
 * So the scaling is lifted for the duration of the capture and put back afterwards.
 * Doing it here rather than in the caller keeps the rule with the code that depends on
 * it: any node handed to this function is rasterised at its own scale, whatever the
 * page has wrapped it in.
 */
function suspendScaling(node: HTMLElement): () => void {
  const restore: Array<() => void> = [];

  for (let element: HTMLElement | null = node; element; element = element.parentElement) {
    const computed = getComputedStyle(element);
    // `zoom` is reported as a number and the other two as "none" when unset — and as
    // "" by any engine that does not implement the property at all, jsdom included.
    const isUnset = (value: string | undefined, unset: string) =>
      !value || value === unset;
    if (
      isUnset(computed.transform, "none") &&
      isUnset(computed.scale, "none") &&
      isUnset(computed.zoom, "1")
    ) {
      continue;
    }

    const previous = element.getAttribute("style");
    restore.push(() => {
      if (previous === null) element.removeAttribute("style");
      else element.setAttribute("style", previous);
    });

    // `important` because the scaling usually comes from a class, which an inline
    // declaration of equal weight would not beat.
    element.style.setProperty("transform", "none", "important");
    element.style.setProperty("scale", "none", "important");
    element.style.setProperty("zoom", "1", "important");
  }

  return () => {
    for (const undo of restore) undo();
  };
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
  // The `-pro` fork rather than `html2canvas` itself: the original's colour parser
  // predates CSS Color 4 and throws on `oklch()`, which is the space Tailwind v4 emits
  // its entire default palette in, so every report failed to rasterise.
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
    import("html2canvas-pro"),
    import("jspdf"),
  ]);

  const { omitted } = await prepareImages(node);

  const restoreScaling = suspendScaling(node);
  let canvas: HTMLCanvasElement;
  try {
    canvas = await html2canvas(node, {
      scale,
      // The report is rendered off-screen; without this it rasterises as transparent and
      // the PDF comes out with black text on black.
      backgroundColor: "#ffffff",
      useCORS: true,
      logging: false,
    });
  } finally {
    restoreScaling();
  }

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
  return { pageCount, fileName, imagesOmitted: omitted };
}

/** `CLM-100200-buildco.pdf`, matching the legacy naming. */
export function reportFileName(identifier: string): string {
  return `${identifier || "estimate"}-buildco.pdf`;
}
