/**
 * Paging over a `Page<T>` response: a range label, numbered pages, and prev/next.
 *
 * The numbers were added deliberately after an earlier version shipped without them.
 * The argument for prev/next alone was that jumping to page 9 of a newest-first list is
 * rarely what anyone wants — which is true, and beside the point: without numbers there
 * is no way back to a page you have just left, and no sense of how much list there is.
 * The range label carries the second half of that ("57–72 of 240").
 *
 * Long lists collapse to first · … · neighbours · … · last, so the control stays a fixed
 * width instead of growing a row of forty buttons.
 *
 * Renders nothing when everything fits on one page — a control that can only be disabled
 * is clutter.
 */
import { Button } from "./Button";
import { cn } from "@/lib/cn";

/** Pages either side of the current one before the list collapses to an ellipsis. */
const NEIGHBOURS = 1;

export function Pagination({
  total,
  limit,
  offset,
  onChange,
  noun = "estimate",
}: {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
  /** Singular; pluralised by adding an "s". */
  noun?: string;
}) {
  if (total <= limit) return null;

  const pageCount = Math.ceil(total / limit);
  const current = Math.floor(offset / limit) + 1;
  const first = offset + 1;
  const last = Math.min(offset + limit, total);

  return (
    <nav
      className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 pt-4"
      aria-label={`${noun} pages`}
    >
      {/* Announced politely: paging replaces the list in place, and without this a
          screen-reader user gets no confirmation that anything happened. */}
      <p className="text-sm text-gray-500" aria-live="polite">
        Showing {first}–{last} of {total} {total === 1 ? noun : `${noun}s`}
      </p>

      <div className="flex items-center gap-1">
        <Button
          size="sm"
          disabled={current === 1}
          onClick={() => onChange(Math.max(0, offset - limit))}
        >
          Previous
        </Button>

        {pageRange(current, pageCount).map((page, index) =>
          page === null ? (
            <span
              // Index-keyed because the gaps have no identity of their own, and there
              // are at most two of them.
              key={`gap-${index}`}
              aria-hidden="true"
              className="px-1 text-sm text-gray-400"
            >
              …
            </span>
          ) : (
            <button
              key={page}
              type="button"
              // `aria-current="page"` rather than styling alone, so the current page is
              // announced and not merely darker.
              aria-current={page === current ? "page" : undefined}
              aria-label={`Page ${page}`}
              onClick={() => onChange((page - 1) * limit)}
              className={cn(
                "tnum h-8 min-w-8 rounded-md px-2 text-sm font-medium transition-colors",
                page === current
                  ? "bg-brand-700 text-white"
                  : "text-gray-600 ring-1 ring-inset ring-gray-300 hover:bg-gray-50",
              )}
            >
              {page}
            </button>
          ),
        )}

        <Button
          size="sm"
          disabled={current === pageCount}
          onClick={() => onChange(offset + limit)}
        >
          Next
        </Button>
      </div>
    </nav>
  );
}

/**
 * The page numbers to show, with `null` standing in for a gap.
 *
 * Always includes the first and last page so those two are one click away however long
 * the list is, plus the current page and its immediate neighbours. A gap is only drawn
 * where it actually skips something — collapsing a single missing page into an ellipsis
 * would take the same width and hide a number the reader could have clicked.
 *
 * Exported for its own unit tests: the boundary cases here (short lists, either end)
 * are exactly the ones that are tedious to reach through the DOM.
 */
export function pageRange(current: number, pageCount: number): (number | null)[] {
  const wanted = new Set<number>([1, pageCount]);
  for (let page = current - NEIGHBOURS; page <= current + NEIGHBOURS; page += 1) {
    if (page >= 1 && page <= pageCount) wanted.add(page);
  }

  const pages = [...wanted].sort((a, b) => a - b);
  const out: (number | null)[] = [];
  for (const [index, page] of pages.entries()) {
    const previous = pages[index - 1];
    if (previous !== undefined && page - previous > 1) {
      // One missing page is drawn rather than elided — the ellipsis would be no
      // narrower and would cost the reader a click.
      if (page - previous === 2) out.push(page - 1);
      else out.push(null);
    }
    out.push(page);
  }
  return out;
}
