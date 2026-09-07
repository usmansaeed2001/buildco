/**
 * The store is module state initialised at import, and several of these tests need it to
 * start from a different world (storage pre-seeded, or an OS set to dark). `vi.resetModules`
 * plus a dynamic import is the only way to re-run that initialisation, so each test that
 * cares imports its own fresh copy via `load()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ThemeModule = typeof import("./theme");

/** Stands in for `window.matchMedia`, which jsdom does not implement at all. */
function stubMatchMedia(prefersDark: boolean) {
  const listeners = new Set<() => void>();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: prefersDark,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    })),
  );
  return listeners;
}

async function load(): Promise<ThemeModule> {
  vi.resetModules();
  return import("./theme");
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset["theme"];
});

afterEach(() => vi.unstubAllGlobals());

describe("the default preference", () => {
  it("follows a system set to dark", async () => {
    stubMatchMedia(true);
    const theme = await load();
    expect(theme.getPreference()).toBe("system");
    expect(theme.getTheme()).toBe("dark");
  });

  it("follows a system set to light", async () => {
    stubMatchMedia(false);
    const theme = await load();
    expect(theme.getTheme()).toBe("light");
  });

  it("falls back to light where matchMedia does not exist", async () => {
    vi.stubGlobal("matchMedia", undefined);
    const theme = await load();
    expect(theme.getTheme()).toBe("light");
  });
});

describe("an explicit preference", () => {
  it("outranks the operating system", async () => {
    stubMatchMedia(true);
    localStorage.setItem("buildco_theme", "light");
    const theme = await load();
    expect(theme.getTheme()).toBe("light");
  });

  it("survives a reload", async () => {
    stubMatchMedia(false);
    const first = await load();
    first.setPreference("dark");

    const second = await load();
    expect(second.getPreference()).toBe("dark");
    expect(second.getTheme()).toBe("dark");
  });

  it("is forgotten when the choice goes back to system", async () => {
    stubMatchMedia(false);
    const theme = await load();
    theme.setPreference("dark");
    theme.setPreference("system");
    expect(localStorage.getItem("buildco_theme")).toBeNull();
    expect(theme.getTheme()).toBe("light");
  });

  it("ignores a stored value that is not a theme", async () => {
    stubMatchMedia(false);
    localStorage.setItem("buildco_theme", "solarized");
    const theme = await load();
    expect(theme.getPreference()).toBe("system");
  });
});

describe("toggling", () => {
  it("lands on an explicit preference, so the OS stops being followed", async () => {
    stubMatchMedia(true);
    const theme = await load();
    expect(theme.getPreference()).toBe("system");

    theme.toggleTheme();

    expect(theme.getPreference()).toBe("light");
    expect(theme.getTheme()).toBe("light");
  });

  it("flips back", async () => {
    stubMatchMedia(false);
    const theme = await load();
    theme.toggleTheme();
    theme.toggleTheme();
    expect(theme.getTheme()).toBe("light");
  });

  it("notifies subscribers", async () => {
    stubMatchMedia(false);
    const theme = await load();
    const listener = vi.fn();
    const unsubscribe = theme.subscribe(listener);

    theme.toggleTheme();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    theme.toggleTheme();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("the document", () => {
  it("carries the resolved theme, which is what the CSS keys off", async () => {
    stubMatchMedia(true);
    const theme = await load();
    expect(document.documentElement.dataset["theme"]).toBe("dark");

    theme.setPreference("light");
    expect(document.documentElement.dataset["theme"]).toBe("light");
  });
});

describe("changes made elsewhere", () => {
  it("picks up the OS flipping while on system", async () => {
    const listeners = stubMatchMedia(false);
    const theme = await load();
    expect(theme.getTheme()).toBe("light");

    // The media query now reports dark, and fires.
    stubMatchMedia(true);
    for (const listener of listeners) listener();

    expect(theme.getTheme()).toBe("dark");
  });

  it("picks up another tab's choice", async () => {
    stubMatchMedia(false);
    const theme = await load();

    localStorage.setItem("buildco_theme", "dark");
    window.dispatchEvent(new StorageEvent("storage", { key: "buildco_theme" }));

    expect(theme.getPreference()).toBe("dark");
    expect(document.documentElement.dataset["theme"]).toBe("dark");
  });

  it("ignores a storage event for an unrelated key", async () => {
    stubMatchMedia(false);
    const theme = await load();
    theme.setPreference("dark");

    localStorage.setItem("buildco_seen_active", "[]");
    window.dispatchEvent(new StorageEvent("storage", { key: "buildco_seen_active" }));

    expect(theme.getTheme()).toBe("dark");
  });
});

describe("storage that throws", () => {
  it("still switches, for the rest of the session", async () => {
    stubMatchMedia(false);
    const theme = await load();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    theme.setPreference("dark");

    expect(theme.getTheme()).toBe("dark");
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    vi.restoreAllMocks();
  });

  it("falls back to system when it cannot be read", async () => {
    stubMatchMedia(true);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    const theme = await load();
    expect(theme.getPreference()).toBe("system");
    expect(theme.getTheme()).toBe("dark");
    vi.restoreAllMocks();
  });
});
