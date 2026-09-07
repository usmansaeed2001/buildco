/**
 * Tabs whose selection lives in the query string.
 *
 * `router.tsx` states the rule this follows: "Filter and tab state live in the query
 * string." The legacy editor kept the active tab in a module-level variable, so a
 * refresh — or a link sent to a colleague — always landed on Line Items regardless of
 * what the sender was looking at.
 *
 * Split into a hook and a presentational list so a screen can read the active tab
 * without rendering the list, and so the list can be tested without a router that has
 * real history.
 */
import { useCallback, useRef, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { cn } from "@/lib/cn";

export interface TabDef {
  id: string;
  label: string;
}

/**
 * The active tab, and a setter that writes it to the query string.
 *
 * An unknown or missing value falls back to the first tab rather than rendering
 * nothing — a hand-edited URL should not produce a blank screen. `replace: true`
 * keeps tab switching out of the back-button history, matching the filter chips on
 * the estimates list.
 */
export function useTabParam(
  tabs: readonly TabDef[],
  param = "tab",
): [string, (id: string) => void] {
  const [params, setParams] = useSearchParams();
  const fallback = tabs[0]?.id ?? "";
  const requested = params.get(param);
  const active = tabs.some((tab) => tab.id === requested) ? requested! : fallback;

  const setActive = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params);
      next.set(param, id);
      setParams(next, { replace: true });
    },
    [params, param, setParams],
  );

  return [active, setActive];
}

/**
 * The tab strip.
 *
 * Arrow-key navigation and `tabIndex={-1}` on inactive tabs implement the ARIA tabs
 * pattern: Tab moves into and out of the strip, arrows move between tabs. Without it a
 * keyboard user has to press Tab once per tab to get past a strip of six.
 */
export function TabList({
  tabs,
  active,
  onChange,
  label,
  className,
}: {
  tabs: readonly TabDef[];
  active: string;
  onChange: (id: string) => void;
  label: string;
  className?: string;
}) {
  const strip = useRef<HTMLDivElement>(null);

  function onKeyDown(event: React.KeyboardEvent) {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    event.preventDefault();

    const index = tabs.findIndex((tab) => tab.id === active);
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (!next) return;

    onChange(next.id);
    strip.current?.querySelector<HTMLButtonElement>(`[data-tab-id="${next.id}"]`)?.focus();
  }

  return (
    <div
      ref={strip}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn("flex items-center gap-1 border-b border-gray-200", className)}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`tab-${tab.id}`}
            data-tab-id={tab.id}
            aria-selected={selected}
            aria-controls={`panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              selected
                ? "border-brand-600 text-brand-700 dark:text-brand-300"
                : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-800",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** Renders nothing when inactive, so an unmounted tab holds no state and issues no queries. */
export function TabPanel({
  id,
  active,
  children,
}: {
  id: string;
  active: string;
  children: ReactNode;
}) {
  if (id !== active) return null;
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} tabIndex={0}>
      {children}
    </div>
  );
}
