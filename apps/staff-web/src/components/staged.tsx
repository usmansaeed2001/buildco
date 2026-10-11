/**
 * A form the assistant has filled in to show what it proposes, and how that is marked.
 *
 * `Modal` says a dialog is staged (`stagedContext.ts`); the form controls and the pages
 * read it. Three things follow, and all three exist because what is on a staged screen
 * is exactly what will be saved:
 *
 * - **Every field the assistant filled is marked**, with a bar in the assistant's colour
 *   and a tinted fill. A field it left empty looks like any empty field.
 * - **No placeholder is shown.** "12 Oak Street" in an empty Location field is example
 *   text, and on a read-only form it is indistinguishable from a value being approved.
 * - **It says so in words**, in a banner, because the assistant's violet is the same
 *   lightness as the brand blue and looks alike to many colour-blind people. "Not saved
 *   yet" is always also a dashed line and those words.
 */
import type { ReactNode } from "react";
import { Orb } from "@/features/agent/Orb";
import { cn } from "@/lib/cn";
import { useStaged } from "./stagedContext";

/** Across the top of a staged dialog. */
export function StagedBanner() {
  return (
    <p
      role="status"
      className="flex items-center gap-2 border-b border-dashed border-assistant-300 bg-assistant-50 px-5 py-2 text-sm font-medium text-assistant-700 dark:text-assistant-300"
    >
      <Orb size={20} />
      Filled in by BuildCo Assistant · Not saved yet
    </p>
  );
}

/**
 * The mark on something the assistant filled in. For what is not a form control: a list
 * of people, a colour, a block of values. Controls mark themselves (`form.tsx`).
 */
export function StagedMark({
  filled = true,
  className,
  children,
}: {
  /** Empty things are not marked. */
  filled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const staged = useStaged();
  if (!staged || !filled) return <>{children}</>;
  return (
    <div data-staged-fill className={cn("ast-field px-3 py-2", className)}>
      {children}
    </div>
  );
}
