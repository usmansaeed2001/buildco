/**
 * A dropdown menu that dismisses on an outside click or Escape.
 *
 * Extracted from `AppShell`'s account menu, which was the only such thing in the app.
 * The estimates list needed a second one, and two hand-rolled dismissal implementations
 * drift — one grows a fix the other never gets, and the difference only shows up as a
 * menu somebody cannot close.
 *
 * Both dismissals matter, and for different reasons: without the outside click you are
 * stuck with an open menu the moment you change your mind, and without Escape the menu
 * is a keyboard trap. The listeners attach only while the menu is open, so a screen full
 * of closed menus costs nothing.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Menu({
  label,
  trigger,
  align = "right",
  children,
}: {
  /** Accessible name for the trigger — menus are usually icon-only. */
  label: string;
  trigger: ReactNode;
  align?: "left" | "right";
  /** Receives `close`, so an item can dismiss the menu as it acts. */
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    // `mousedown` rather than `click`: a menu item that unmounts on click would
    // otherwise be gone before the click resolves, and the outside-click handler would
    // see the event as landing outside and fight it.
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative shrink-0" ref={container}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 rounded-md px-1.5 py-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
      >
        {trigger}
      </button>

      {open && (
        <div
          id={id}
          role="menu"
          className={cn(
            "absolute z-40 mt-1 w-52 overflow-hidden rounded-md bg-surface py-1 shadow-lg ring-1 ring-gray-200",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** A menu row that runs an action. Use a `Link` with `role="menuitem"` for navigation. */
export function MenuItem({
  onSelect,
  tone = "default",
  disabled,
  children,
}: {
  onSelect: () => void;
  tone?: "default" | "danger";
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "block w-full px-3 py-2 text-left text-sm disabled:opacity-50",
        tone === "danger"
          ? "text-danger-700 hover:bg-danger-50"
          : "text-gray-700 hover:bg-gray-50",
      )}
    >
      {children}
    </button>
  );
}

/** A hairline between groups of items. */
export function MenuSeparator() {
  return <div className="my-1 border-t border-gray-100" role="separator" />;
}

/** The ⋯ glyph, drawn rather than pulled from an icon set. */
export function KebabIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="size-4">
      <circle cx="10" cy="4" r="1.6" />
      <circle cx="10" cy="10" r="1.6" />
      <circle cx="10" cy="16" r="1.6" />
    </svg>
  );
}
