/**
 * Table primitives.
 *
 * A real `<table>` rather than a grid of divs: the line-item and milestone tables are
 * genuinely tabular, and a screen reader announcing "column 3, Unit Cost" is worth more
 * than the layout flexibility divs would buy.
 *
 * `<TableWrap>` is not optional decoration. A wide table on a phone must scroll inside
 * its own box; without it the whole page scrolls sideways and the topbar drifts off
 * screen.
 *
 * It is `relative` for the same reason. A screen-reader-only label inside a cell is
 * absolutely positioned, and an absolutely positioned element is clipped only by a
 * scroller that is also its containing block. Without `relative` here, a label in a
 * column that has scrolled out of view still counted towards the width of the page, and
 * the page scrolled sideways by exactly as far as the table overflowed.
 */
import type { ReactNode, ThHTMLAttributes, TdHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export function TableWrap({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("relative overflow-x-auto rounded-card ring-1 ring-gray-200", className)}>
      {children}
    </div>
  );
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <table className={cn("w-full min-w-max border-collapse bg-surface text-sm", className)}>
      {children}
    </table>
  );
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="border-b border-gray-200 bg-gray-50">{children}</thead>;
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-gray-100">{children}</tbody>;
}

export function TFoot({ children }: { children: ReactNode }) {
  return <tfoot className="border-t-2 border-gray-200 bg-gray-50 font-medium">{children}</tfoot>;
}

export function Tr({ children, className }: { children: ReactNode; className?: string }) {
  return <tr className={className}>{children}</tr>;
}

/** `numeric` right-aligns and switches on tabular figures, so columns of money line up. */
export function Th({
  numeric,
  className,
  children,
  ...rest
}: { numeric?: boolean } & ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={cn(
        "px-3 py-2 text-left text-xs font-medium tracking-wide text-gray-500 uppercase",
        numeric && "text-right",
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export function Td({
  numeric,
  className,
  children,
  ...rest
}: { numeric?: boolean } & TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={cn("px-3 py-2 text-gray-900", numeric && "tnum text-right", className)}
      {...rest}
    >
      {children}
    </td>
  );
}
