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
import { describe, expect, it } from "vitest";
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
