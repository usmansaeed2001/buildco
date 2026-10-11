/**
 * A modal dialog, in one of two forms.
 *
 * **Normally, the native `<dialog>` element.** Using the platform element rather than a
 * div-with-a-backdrop gets focus trapping, the top layer, inertness of the page behind,
 * and Escape-to-close from the browser, all of which the legacy hand-rolled overlays
 * lacked.
 *
 * Note `showModal()` throws if called on an already-open dialog, and `close()` on an
 * already-closed one is a no-op — hence the guards in the effect.
 *
 * **Beside a side panel, a dialog scoped to the app column.** `showModal()` makes
 * *everything* outside the dialog inert, and that would include a panel docked next to
 * the app. So while `AppFrame` has a panel open, the dialog is rendered into the
 * frame's dialog layer instead: centred over the app column, with a scrim that stops at
 * the column's edge, and the panel left alone. What the native element did for free is
 * then done by hand here (the focus trap and Escape) and in `AppFrame` (making the page
 * behind inert).
 *
 * Which form a dialog takes is fixed when it opens. Switching form underneath an open
 * dialog would remount whatever is inside it and lose what had been typed.
 *
 * **`staged`** is for a form the assistant has filled in to show what it proposes. It is
 * read-only and says so, has nothing to close it with, and never takes focus: the
 * person is approving or rejecting it from the panel, not operating it. Its scrim is
 * light, because the user is being asked to look at the page, not away from it; an
 * ordinary dialog's is unchanged. How its fields are marked is in `staged.tsx`.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { useAppFrame } from "./AppFrame";
import { StagedBanner } from "./staged";
import { StagedProvider } from "./stagedContext";

type Size = "sm" | "md" | "lg" | "xl";

const WIDTHS: Record<Size, string> = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
};

export function Modal({
  open,
  onClose,
  title,
  description,
  size = "md",
  staged = false,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  size?: Size;
  /** Filled in by the assistant and not yet saved: read-only, and not a focus target. */
  staged?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const frame = useAppFrame();
  const layer = frame?.panelOpen ? frame.dialogLayer : null;

  // Decided on the render that opens the dialog and held until it closes.
  const [wasOpen, setWasOpen] = useState(false);
  const [scoped, setScoped] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setScoped(layer !== null);
  }

  // A staged form is the assistant's, so it does not count as a dialog the user has
  // open. Counting it would make the assistant refuse to act because of its own form.
  const registerDialog = frame?.registerDialog;
  useEffect(() => {
    if (!open || staged || !registerDialog) return;
    return registerDialog();
  }, [open, staged, registerDialog]);

  // The marks on a staged form's filled fields appear top to bottom, a beat apart. Every
  // value is on screen from the first frame; this only numbers the marks for the
  // stylesheet, which staggers them.
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !staged) return;
    body.current
      ?.querySelectorAll<HTMLElement>("[data-staged-fill]")
      .forEach((mark, index) => mark.style.setProperty("--staged-i", String(index)));
  }, [open, staged]);

  // Mounted only while open. A closed dialog that still rendered its children would keep
  // a form nobody can see alive, with its state and its effects, and a test asserting
  // "this confirmation is not showing" would pass whether or not it was.
  const contents = !open ? null : (
    <div className="flex flex-col">
      <header className="flex items-start justify-between gap-4 border-b border-gray-100 px-5 py-4">
        <div>
          <h2 className="font-display text-base font-semibold text-gray-900">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-gray-500">{description}</p>}
        </div>
        {!staged && (
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
        )}
      </header>

      {staged && <StagedBanner />}

      {/* `inert`, not merely disabled fields: a staged form must not be operable at all,
          and that includes links and buttons a form may render inside its body. It can
          still be scrolled, by the lock's layer over it (`AppFrame`). */}
      <div
        ref={body}
        className="max-h-[70vh] overflow-y-auto px-5 py-4"
        inert={staged}
        {...(staged ? { "data-staged-body": "" } : {})}
      >
        <StagedProvider value={staged}>{children}</StagedProvider>
      </div>

      {/* The footer is the form's own Save and Cancel. A staged form is saved by
          approving it in the panel, so showing them would offer a second, wrong way. */}
      {footer && !staged && (
        <footer className="flex justify-end gap-2 border-t border-gray-100 px-5 py-3">
          {footer}
        </footer>
      )}
    </div>
  );

  if (scoped) {
    // The layer goes away with the panel. A dialog still open at that moment has
    // nowhere to render; closing the panel is expected to have closed it first.
    if (!open || !frame?.dialogLayer) return null;
    return createPortal(
      <ScopedDialog title={title} size={size} staged={staged} onClose={onClose}>
        {contents}
      </ScopedDialog>,
      frame.dialogLayer,
    );
  }

  return (
    <NativeDialog open={open} title={title} size={size} staged={staged} onClose={onClose}>
      {contents}
    </NativeDialog>
  );
}

function NativeDialog({
  open,
  title,
  size,
  staged,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  size: Size;
  staged: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;

    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      // Escape fires `cancel`; the backdrop is handled below. Both route through the
      // same onClose so the parent's state cannot drift out of sync with the element.
      onCancel={(event) => {
        event.preventDefault();
        if (!staged) onClose();
      }}
      onClose={onClose}
      onClick={(event) => {
        // A click landing on the dialog itself rather than its content is the
        // backdrop — ::backdrop is not an event target of its own.
        if (event.target === dialog.current && !staged) onClose();
      }}
      className={cn(
        "m-auto w-[calc(100%-2rem)] rounded-card bg-surface p-0 text-gray-900 shadow-xl",
        staged
          ? "backdrop:bg-black/20 dark:backdrop:bg-black/35"
          : "backdrop:bg-black/45 dark:backdrop:bg-black/65",
        WIDTHS[size],
      )}
      aria-label={title}
    >
      {/* The element itself stays mounted while closed, because `showModal()` has to be
          called on it. */}
      {children}
    </dialog>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !element.closest("[inert]"),
  );
}

function ScopedDialog({
  title,
  size,
  staged,
  onClose,
  children,
}: {
  title: string;
  size: Size;
  staged: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  // Focus moves in when the dialog opens and goes back where it was when it closes,
  // which is what `showModal()` does.
  useEffect(() => {
    if (staged) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (focusableIn(panel.current)[0] ?? panel.current)?.focus();
    return () => previous?.focus();
  }, [staged]);

  // On the document, not on the dialog: after a click on the scrim, focus is on the
  // body and a handler on the dialog would never hear the key.
  useEffect(() => {
    if (staged) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Escape pressed while working in the side panel belongs to the panel.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.closest('[aria-label="Side panel"]')) return;
      // A dialog opened from inside another closes first: only the last one answers.
      const stack = root.current?.parentElement?.querySelectorAll("[data-scoped-dialog]");
      if (stack && stack[stack.length - 1] !== root.current) return;
      event.preventDefault();
      close.current();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [staged]);

  function trapTab(event: React.KeyboardEvent) {
    if (event.key !== "Tab") return;
    const items = focusableIn(panel.current);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  return (
    // Covers the whole column, which is as tall as the page. The inner box is sticky
    // and viewport-tall, so the dialog stays centred on screen while the page scrolls.
    <div
      ref={root}
      data-scoped-dialog
      className={cn(
        "absolute inset-0 z-40",
        // Light behind a staged form: the page stays readable while it is being asked
        // about.
        staged ? "bg-black/20 dark:bg-black/35" : "bg-black/45 dark:bg-black/65",
      )}
    >
      <div
        className="sticky top-0 flex h-dvh items-center justify-center p-4"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !staged) onClose();
        }}
      >
        <div
          ref={panel}
          role="dialog"
          aria-label={title}
          // Focusable so it can hold focus when there is nothing inside to take it.
          tabIndex={-1}
          onKeyDown={trapTab}
          className={cn(
            "w-full rounded-card bg-surface text-gray-900 shadow-xl outline-none",
            staged && "ast-staged-dialog",
            WIDTHS[size],
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
