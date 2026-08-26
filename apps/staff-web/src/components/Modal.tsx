/**
 * A modal dialog built on the native `<dialog>` element.
 *
 * Using the platform element rather than a div-with-a-backdrop gets focus trapping,
 * the top layer, inertness of the page behind, and Escape-to-close from the browser,
 * all of which the legacy hand-rolled overlays lacked.
 *
 * Note `showModal()` throws if called on an already-open dialog, and `close()` on an
 * already-closed one is a no-op — hence the guards in the effect.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Modal({
  open,
  onClose,
  title,
  description,
  size = "md",
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  size?: "sm" | "md" | "lg" | "xl";
  children: ReactNode;
  footer?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;

    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  }, [open]);

  const widths = {
    sm: "max-w-sm",
    md: "max-w-lg",
    lg: "max-w-2xl",
    xl: "max-w-4xl",
  } as const;

  return (
    <dialog
      ref={dialog}
      // Escape fires `cancel`; the backdrop is handled below. Both route through the
      // same onClose so the parent's state cannot drift out of sync with the element.
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      onClick={(event) => {
        // A click landing on the dialog itself rather than its content is the
        // backdrop — ::backdrop is not an event target of its own.
        if (event.target === dialog.current) onClose();
      }}
      className={cn(
        "m-auto w-[calc(100%-2rem)] rounded-card bg-surface p-0 text-gray-900 shadow-xl backdrop:bg-gray-900/40",
        widths[size],
      )}
      aria-label={title}
    >
      <div className="flex flex-col">
        <header className="flex items-start justify-between gap-4 border-b border-gray-100 px-5 py-4">
          <div>
            <h2 className="font-display text-base font-semibold text-gray-900">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-gray-500">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-m-1 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <svg className="size-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </header>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <footer className="flex justify-end gap-2 border-t border-gray-100 px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </dialog>
  );
}
