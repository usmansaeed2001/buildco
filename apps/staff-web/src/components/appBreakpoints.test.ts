/**
 * Layouts inside the signed-in shell must respond to the app column, not the window.
 *
 * `AppFrame` can dock a panel beside the app. A viewport breakpoint (`lg:grid-cols-3`)
 * cannot see that, and would lay a desktop grid into whatever is left of the window. So
 * every screen rendered inside `AppShell` uses the column's own variants (`app-lg:`),
 * defined in `styles/index.css`.
 *
 * jsdom has no layout and evaluates neither kind of query, so a test here cannot show a
 * screen reflowing; that was checked in a browser. What a test can do is keep the
 * convention from eroding, because the failure is silent: one stray `lg:` looks right
 * in every test and at every window size until somebody opens the panel.
 */
import { describe, expect, it } from "vitest";

/** Every component source, as text, keyed by its path from `src/`. */
const SOURCES = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("../**/*.tsx", { query: "?raw", import: "default", eager: true }),
    // Vite keys a file beside this one as `./Name.tsx` and everything else as `../…`.
  ).map(([path, text]) => [path.replace(/^\.\.\//, "").replace(/^\.\//, "components/"), text]),
);

/** Rendered outside `AppShell`, so the window is the right thing for them to measure. */
const OUTSIDE_THE_SHELL = ["features/auth/", "features/review/", "features/home/NotFoundPage.tsx"];

/** A viewport variant used as a class: after whitespace or a quote, before a utility. */
const VIEWPORT_VARIANT = /(?<=[\s"'`])(?:sm|md|lg|xl|2xl):(?=[a-z[-])/g;

describe("breakpoints inside the shell", () => {
  it("measure the app column, never the window", () => {
    const offenders = Object.entries(SOURCES)
      .filter(([path]) => !path.includes(".test.") && !path.startsWith("test/"))
      .filter(([path]) => !OUTSIDE_THE_SHELL.some((prefix) => path.startsWith(prefix)))
      .flatMap(([path, text]) => {
        const found = text.match(VIEWPORT_VARIANT);
        return found ? [`${path}: ${[...new Set(found)].join(" ")}`] : [];
      });

    expect(offenders, "use app-sm: / app-md: / app-lg: / app-xl: instead").toEqual([]);
  });

  it("is looking at the real sources", () => {
    // Guards the guard: an empty or mistyped glob would pass the test above forever.
    expect(Object.keys(SOURCES)).toContain("components/AppShell.tsx");
    expect(Object.keys(SOURCES).length).toBeGreaterThan(50);
    expect(SOURCES["components/AppShell.tsx"]).toContain("app-md:hidden");
  });

  it("still finds a viewport variant when there is one", () => {
    expect('className="grid lg:grid-cols-3"'.match(VIEWPORT_VARIANT)).toEqual(["lg:"]);
    expect('className="grid app-lg:grid-cols-3"'.match(VIEWPORT_VARIANT)).toBeNull();
    expect('const sizes = { sm: "h-8", md: "h-9" }'.match(VIEWPORT_VARIANT)).toBeNull();
  });

  it("has a column to measure", () => {
    // The variants themselves are declared in `styles/index.css`, which the test
    // runner does not load: it stubs stylesheets out. Without this class on the frame
    // they would match nothing and every screen would fall back to its narrowest layout.
    expect(SOURCES["components/AppFrame.tsx"]).toContain("@container/app");
  });
});
