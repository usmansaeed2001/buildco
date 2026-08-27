import { describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TabList, TabPanel, useTabParam } from "./Tabs";

const TABS = [
  { id: "items", label: "Line Items" },
  { id: "details", label: "Project Details" },
] as const;

function Harness({ param }: { param?: string }) {
  const [active, setActive] = useTabParam(TABS, param);
  const location = useLocation();

  return (
    <>
      <TabList tabs={TABS} active={active} onChange={setActive} label="Estimate sections" />
      <TabPanel id="items" active={active}>
        <p>items panel</p>
      </TabPanel>
      <TabPanel id="details" active={active}>
        <p>details panel</p>
      </TabPanel>
      <output data-testid="search">{location.search}</output>
    </>
  );
}

function renderAt(url: string, param?: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/" element={<Harness {...(param ? { param } : {})} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("useTabParam", () => {
  it("falls back to the first tab when the query string says nothing", () => {
    renderAt("/");
    expect(screen.getByRole("tab", { name: "Line Items" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("items panel")).toBeInTheDocument();
  });

  it("reads the active tab from the query string, so a shared link opens where the sender was", () => {
    renderAt("/?tab=details");
    expect(screen.getByText("details panel")).toBeInTheDocument();
    expect(screen.queryByText("items panel")).not.toBeInTheDocument();
  });

  it("falls back rather than rendering a blank screen for an unknown tab", () => {
    renderAt("/?tab=nonsense");
    expect(screen.getByText("items panel")).toBeInTheDocument();
  });

  it("writes the selection to the query string on click", async () => {
    const user = userEvent.setup();
    renderAt("/");

    await user.click(screen.getByRole("tab", { name: "Project Details" }));

    expect(screen.getByTestId("search")).toHaveTextContent("tab=details");
    expect(screen.getByText("details panel")).toBeInTheDocument();
  });

  it("honours a custom parameter name", async () => {
    const user = userEvent.setup();
    renderAt("/", "section");

    await user.click(screen.getByRole("tab", { name: "Project Details" }));

    expect(screen.getByTestId("search")).toHaveTextContent("section=details");
  });
});

describe("TabList", () => {
  it("keeps only the active tab in the tab order", () => {
    renderAt("/");
    expect(screen.getByRole("tab", { name: "Line Items" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Project Details" })).toHaveAttribute("tabindex", "-1");
  });

  it("moves between tabs with the arrow keys", async () => {
    const user = userEvent.setup();
    renderAt("/");

    screen.getByRole("tab", { name: "Line Items" }).focus();
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("tab", { name: "Project Details" })).toHaveFocus();
    expect(screen.getByText("details panel")).toBeInTheDocument();
  });

  it("wraps around at the ends", async () => {
    const user = userEvent.setup();
    renderAt("/");

    screen.getByRole("tab", { name: "Line Items" }).focus();
    await user.keyboard("{ArrowLeft}");

    expect(screen.getByRole("tab", { name: "Project Details" })).toHaveFocus();
  });

  it("associates each tab with its panel", () => {
    renderAt("/");
    const tab = screen.getByRole("tab", { name: "Line Items" });
    expect(tab).toHaveAttribute("aria-controls", "panel-items");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "tab-items");
  });
});
