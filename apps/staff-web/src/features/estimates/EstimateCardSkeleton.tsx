/**
 * The estimates grid while it loads.
 *
 * A skeleton rather than the centred spinner this screen used to show, because the
 * spinner threw the layout away and rebuilt it: the toolbar sat above a void, then six
 * cards appeared and shoved the pagination down the page. Holding the shape means
 * nothing moves when the data lands.
 *
 * The bars are sized to the real card's content — status pill, title, client, then the
 * meta and total row — so the placeholder reads as an estimate rather than as generic
 * grey furniture.
 *
 * `animate-pulse` rather than a hand-rolled keyframe: it is already in Tailwind, and the
 * global `prefers-reduced-motion` block in `styles/index.css` already neutralises it for
 * anyone who has asked for less movement.
 */
import { cn } from "@/lib/cn";

/** Matches the page size, so the grid does not change height when the data arrives. */
const PLACEHOLDER_COUNT = 6;

function Bar({ className }: { className: string }) {
  return <span className={cn("block rounded bg-gray-200", className)} />;
}

export function EstimateCardSkeleton() {
  return (
    <div
      // `animate-pulse` on the card, not on each bar: staggered pulses read as a fault.
      className="animate-pulse rounded-card bg-surface p-4 ring-1 ring-gray-200"
    >
      <div className="flex items-center justify-between gap-3">
        <Bar className="h-6 w-24 rounded-full" />
        <Bar className="h-4 w-4" />
      </div>

      <div className="mt-3 flex flex-col gap-2">
        <Bar className="h-5 w-3/5" />
        <Bar className="h-3 w-2/5" />
      </div>

      <div className="mt-4 flex items-end justify-between gap-3 border-t border-gray-100 pt-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Bar className="h-3 w-20" />
          <Bar className="h-3 w-3/5" />
        </div>
        <Bar className="h-6 w-20" />
      </div>
    </div>
  );
}

export function EstimatesGridSkeleton() {
  return (
    // `aria-busy` with a label, so this is announced as "loading" rather than read out
    // as a screenful of empty boxes.
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading estimates"
      className="grid gap-4 app-sm:grid-cols-2 app-lg:grid-cols-3"
    >
      {Array.from({ length: PLACEHOLDER_COUNT }, (_, index) => (
        <EstimateCardSkeleton key={index} />
      ))}
    </div>
  );
}
