/**
 * The shell's navigation, and specifically the narrow-screen drawer.
 *
 * The nav used to be a single row that scrolled sideways, so a phone showed the first
 * two links with no indication the rest existed. jsdom has no layout, so these cannot
 * assert that the drawer is *hidden* on a wide screen — that is a media query and belongs
 * to a screenshot, not a unit test. What they can assert is the behaviour the markup
 * owns: the toggle exists, it reveals a second navigation, and it closes on navigate.
 */
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/utils";
import { makeUser } from "@/test/factories";
import { AppShell } from "./AppShell";

const OWNER = makeUser({ id: "o", role: "owner", full_name: "Casey Owner" });
const MEMBER = makeUser({ id: "m", role: "member", full_name: "Sam Member" });

function renderShell(user = OWNER) {
  return renderWithProviders(<AppShell />, { user, route: "/estimates", path: "*" });
}

describe("AppShell", () => {
  it("offers a menu toggle for narrow screens", () => {
    renderShell();

    expect(screen.getByRole("button", { name: "Menu" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("reveals the navigation when the menu is opened", async () => {
    const { user } = renderShell();
    // One nav on a wide screen; the drawer adds a second, so the count is the signal.
    expect(screen.getAllByRole("navigation", { name: "Main" })).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Menu" }));

    const navs = screen.getAllByRole("navigation", { name: "Main" });
    expect(navs).toHaveLength(2);
    expect(within(navs[1]!).getByRole("link", { name: "Projects" })).toBeVisible();
  });

  it("closes the drawer once you navigate", async () => {
    const { user } = renderShell();
    await user.click(screen.getByRole("button", { name: "Menu" }));

    const drawer = screen.getAllByRole("navigation", { name: "Main" })[1]!;
    await user.click(within(drawer).getByRole("link", { name: "Projects" }));

    // Leaving it open over the page you just asked for reads as a broken tap.
    expect(screen.getAllByRole("navigation", { name: "Main" })).toHaveLength(1);
  });

  it("keeps the drawer role-aware, like the bar it replaces", async () => {
    const { user } = renderShell(MEMBER);

    await user.click(screen.getByRole("button", { name: "Menu" }));

    const drawer = screen.getAllByRole("navigation", { name: "Main" })[1]!;
    expect(within(drawer).queryByRole("link", { name: "Team" })).not.toBeInTheDocument();
  });
});

/**
 * The header toggle.
 *
 * `matchMedia` is stubbed to "light" so the starting theme is deterministic — without it
 * jsdom has no `matchMedia` at all and the store falls back to light anyway, but stating
 * it keeps the test honest about what it depends on.
 */
describe("the theme toggle", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.dataset["theme"] = "light";
  });

  it("names the theme it will switch to, and switches to it", async () => {
    const { user } = renderShell();

    await user.click(screen.getByRole("button", { name: "Switch to dark theme" }));

    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeVisible();
  });

  it("offers a way back to the system theme only once the OS has been overridden", async () => {
    const { user } = renderShell();

    await user.click(screen.getByRole("button", { name: "Account" }));
    expect(screen.queryByRole("menuitem", { name: "Match system theme" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Switch to dark theme" }));
    await user.click(screen.getByRole("button", { name: "Account" }));

    await user.click(screen.getByRole("menuitem", { name: "Match system theme" }));

    expect(localStorage.getItem("buildco_theme")).toBeNull();
    expect(document.documentElement.dataset["theme"]).toBe("light");
  });
});
