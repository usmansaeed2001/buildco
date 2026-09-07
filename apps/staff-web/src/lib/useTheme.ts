/**
 * React bindings for the theme store.
 *
 * Separate from `theme.ts` so that module stays a plain, framework-free store — and
 * separate from the toggle component so Fast Refresh keeps working, which is the same
 * reason `useDebounced` lives here rather than beside its callers.
 *
 * `useSyncExternalStore` rather than an effect and state: the store is already the source
 * of truth (the OS media query and other tabs both write to it), and this subscribes
 * without a render pass that would flash the wrong icon.
 */
import { useSyncExternalStore } from "react";
import { getPreference, getTheme, subscribe, type Theme, type ThemePreference } from "./theme";

/** The theme actually on screen, with "system" already resolved. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, getServerTheme);
}

/** What the person chose, which may be "system". */
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, getPreference, getServerPreference);
}

// Stable identities: `useSyncExternalStore` calls these on every render.
const getServerTheme = (): Theme => "light";
const getServerPreference = (): ThemePreference => "system";
