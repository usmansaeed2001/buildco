/**
 * Light or dark, chosen per device.
 *
 * Phase 8 moved Settings server-side, and this deliberately did not follow. Theme is a
 * property of the screen you are looking at, not of the account: the same person wants
 * dark on a laptop at 9pm and light on the shop's wall-mounted display, and syncing the
 * choice would mean changing one changes both. So it lives in `localStorage` next to
 * `seen.ts`, guarded the same way — the API is never involved.
 *
 * Three preferences, two themes. "system" is the default and stays the default until
 * someone actually picks a side, so a machine set to dark opens dark without anyone
 * configuring anything; the header toggle then writes an explicit "light"/"dark" that
 * outranks the OS. `resolve` collapses the three to the two the CSS understands.
 *
 * The resolved theme is stamped on `<html data-theme>`, which is what
 * `src/styles/index.css` keys both its palette and its `dark:` variant off. `index.html`
 * runs the same resolution in a blocking inline script before first paint, so a dark
 * user never sees a white flash; this module re-applies on every change afterwards.
 */

const KEY = "buildco_theme";

export type ThemePreference = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const listeners = new Set<() => void>();

let preference: ThemePreference = readPreference();
/** Cached rather than computed on demand: `useSyncExternalStore` compares snapshots by
 *  identity and re-renders forever if the getter returns a fresh value each call. */
let resolved: Theme = resolve(preference);

function readPreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === "light" || raw === "dark" ? raw : "system";
  } catch {
    // Storage disabled, or Safari private mode. Following the OS is the right fallback:
    // the preference simply stops being remembered.
    return "system";
  }
}

/** `matchMedia` is absent under jsdom and in any non-browser context, so every read is
 *  optional-chained rather than assumed. */
function systemTheme(): Theme {
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches === true
    ? "dark"
    : "light";
}

export function resolve(pref: ThemePreference): Theme {
  return pref === "system" ? systemTheme() : pref;
}

export function getPreference(): ThemePreference {
  return preference;
}

export function getTheme(): Theme {
  return resolved;
}

/** Writes the resolved theme to `<html>`. Exported for the tests and for anything that
 *  needs to re-assert it after the document is replaced. */
export function applyTheme(): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset["theme"] = resolved;
}

/** Notifies unconditionally: the preference can change ("dark" → "system" on a machine
 *  already set to dark) without the resolved theme moving, and the toggle's label reads
 *  the preference. */
function sync(): void {
  resolved = resolve(preference);
  applyTheme();
  for (const listener of listeners) listener();
}

export function setPreference(next: ThemePreference): void {
  preference = next;
  try {
    if (next === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    // Unwritable storage means the choice lasts for this tab only, which is still better
    // than refusing to switch.
  }
  sync();
}

/** Flips to the opposite of what is on screen. From "system" this lands on an explicit
 *  preference, which is the point: clicking the toggle should stop tracking the OS. */
export function toggleTheme(): void {
  setPreference(resolved === "dark" ? "light" : "dark");
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== "undefined") {
  // Only meaningful while the preference is "system", but the listener is unconditional:
  // `sync` is a no-op for an explicit preference, and there is nothing to tear down.
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", sync);

  // Another tab changed the preference. `storage` fires only in the *other* tabs, so this
  // cannot loop back on the tab that made the change.
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== KEY) return;
    preference = readPreference();
    sync();
  });

  applyTheme();
}
