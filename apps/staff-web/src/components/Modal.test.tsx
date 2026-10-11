/**
 * `Modal` in its two forms, and the frame that decides between them.
 *
 * jsdom has no top layer and no layout, so nothing here can show that a native dialog
 * blocks a panel or that a scoped one is centred over the column. What it can show is
 * everything the markup and the handlers own: which form is rendered, what is made
 * inert, where focus goes, what Escape does, and what the frame is told.
 */
import { useState, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppFrame, useAppFrame } from "./AppFrame";
import { ConfirmDialog } from "./ConfirmDialog";
import { Modal } from "./Modal";

/** Stands in for whatever is docked beside the app, and shows what the frame tells it. */
function Panel() {
  const frame = useAppFrame();
  return (
    <div>
      <button type="button">Panel button</button>
      <output aria-label="Open dialogs">{frame?.openDialogs}</output>
    </div>
  );
}

function Page({ staged = false, children }: { staged?: boolean; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      <Modal
        open={open}
        staged={staged}
        onClose={() => setOpen(false)}
        title="Rename room"
        footer={
          <>
            <button type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button">Save</button>
          </>
        }
      >
        <label>
          Name <input defaultValue="Kitchen" />
        </label>
        {children}
      </Modal>
    </main>
  );
}

function renderFrame({ panel = true, staged = false }: { panel?: boolean; staged?: boolean } = {}) {
  const user = userEvent.setup();
  const view = render(
    <AppFrame panel={panel ? <Panel /> : undefined}>
      <Page staged={staged} />
    </AppFrame>,
  );
  return { user, ...view };
}

const page = () => screen.getByRole("main").parentElement as HTMLElement;

describe("Modal", () => {
  describe("with no panel beside the app", () => {
    it("is the native dialog, as it always was", async () => {
      const { user, container } = renderFrame({ panel: false });

      await user.click(screen.getByRole("button", { name: "Open dialog" }));

      const dialog = container.querySelector("dialog");
      expect(dialog).not.toBeNull();
      expect(dialog).toHaveAttribute("open");
      expect(within(dialog as HTMLElement).getByLabelText("Name")).toHaveValue("Kitchen");
      expect(container.querySelector("[data-scoped-dialog]")).toBeNull();
    });

    it("leaves the page alone: the browser makes it inert, not us", async () => {
      const { user } = renderFrame({ panel: false });

      await user.click(screen.getByRole("button", { name: "Open dialog" }));

      expect(page()).not.toHaveAttribute("inert");
    });

    it("works outside the frame altogether", async () => {
      // The sign-in screens and the reviewer's page have no frame around them.
      const user = userEvent.setup();
      const { container } = render(<Page />);

      await user.click(screen.getByRole("button", { name: "Open dialog" }));

      expect(container.querySelector("dialog")).toHaveAttribute("open");
    });
  });

  describe("with a panel beside the app", () => {
    it("renders into the app column's dialog layer instead of the top layer", async () => {
      const { user, container } = renderFrame();

      await user.click(screen.getByRole("button", { name: "Open dialog" }));

      const layer = container.querySelector("[data-dialog-layer]") as HTMLElement;
      expect(within(layer).getByRole("dialog", { name: "Rename room" })).toBeVisible();
      // `showModal()` is what would have made the panel unusable.
      expect(container.querySelector("dialog")).toBeNull();
      expect(container.querySelector("[data-app-column]")).toContainElement(layer);
    });

    it("makes the page behind it inert, and not the panel", async () => {
      const { user } = renderFrame();

      await user.click(screen.getByRole("button", { name: "Open dialog" }));

      expect(page()).toHaveAttribute("inert");
      const panel = screen.getByRole("complementary", { name: "Side panel" });
      expect(panel.closest("[inert]")).toBeNull();
      expect(screen.getByRole("dialog").closest("[inert]")).toBeNull();
    });

    it("leaves the panel usable while the dialog is open", async () => {
      const { user } = renderFrame();
      await user.click(screen.getByRole("button", { name: "Open dialog" }));

      await user.click(screen.getByRole("button", { name: "Panel button" }));

      expect(screen.getByRole("button", { name: "Panel button" })).toHaveFocus();
      expect(screen.getByRole("dialog")).toBeVisible();
    });

    it("moves focus into the dialog, and back when it closes", async () => {
      const { user } = renderFrame();
      const opener = screen.getByRole("button", { name: "Open dialog" });

      await user.click(opener);
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();

      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(opener).toHaveFocus();
    });

    it("keeps Tab inside the dialog in both directions", async () => {
      const { user } = renderFrame();
      await user.click(screen.getByRole("button", { name: "Open dialog" }));
      const first = screen.getByRole("button", { name: "Close" });
      const last = screen.getByRole("button", { name: "Save" });

      last.focus();
      await user.tab();
      expect(first).toHaveFocus();

      await user.tab({ shift: true });
      expect(last).toHaveFocus();
    });

    it("closes on Escape", async () => {
      const { user } = renderFrame();
      await user.click(screen.getByRole("button", { name: "Open dialog" }));

      await user.keyboard("{Escape}");

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(page()).not.toHaveAttribute("inert");
    });

    it("leaves Escape to the panel when that is where the user is working", async () => {
      const { user } = renderFrame();
      await user.click(screen.getByRole("button", { name: "Open dialog" }));
      await user.click(screen.getByRole("button", { name: "Panel button" }));

      await user.keyboard("{Escape}");

      expect(screen.getByRole("dialog")).toBeVisible();
    });

    it("closes on a click on the scrim, and not on a click inside", async () => {
      const { user, container } = renderFrame();
      await user.click(screen.getByRole("button", { name: "Open dialog" }));

      await user.click(screen.getByLabelText("Name"));
      expect(screen.getByRole("dialog")).toBeVisible();

      const scrim = container.querySelector("[data-scoped-dialog] > div") as HTMLElement;
      await user.click(scrim);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("tells the frame while it is open, and when it closes", async () => {
      const { user } = renderFrame();
      const count = screen.getByRole("status", { name: "Open dialogs" });
      expect(count).toHaveTextContent("0");

      await user.click(screen.getByRole("button", { name: "Open dialog" }));
      expect(count).toHaveTextContent("1");

      await user.keyboard("{Escape}");
      expect(count).toHaveTextContent("0");
    });

    it("closes only the innermost when one dialog is opened from another", async () => {
      function Nested() {
        const [outer, setOuter] = useState(true);
        const [inner, setInner] = useState(true);
        return (
          <>
            <Modal open={outer} onClose={() => setOuter(false)} title="Meeting">
              <p>Outer</p>
            </Modal>
            <ConfirmDialog
              open={inner}
              title="Cancel this meeting?"
              onConfirm={() => {}}
              onCancel={() => setInner(false)}
            >
              Inner
            </ConfirmDialog>
          </>
        );
      }
      const user = userEvent.setup();
      // Mounted with the panel already open, so the layer exists when they open.
      const { rerender } = render(
        <AppFrame panel={<Panel />}>
          <span />
        </AppFrame>,
      );
      rerender(
        <AppFrame panel={<Panel />}>
          <Nested />
        </AppFrame>,
      );

      await user.keyboard("{Escape}");

      expect(screen.queryByRole("dialog", { name: "Cancel this meeting?" })).not.toBeInTheDocument();
      expect(screen.getByRole("dialog", { name: "Meeting" })).toBeVisible();
    });
  });

  describe("staged by the assistant", () => {
    it("says it is the assistant's and not yet saved", async () => {
      const { user } = renderFrame({ staged: true });

      await user.click(screen.getByRole("button", { name: "Open dialog" }));

      expect(screen.getByText("Filled in by BuildCo Assistant · Not saved yet")).toBeVisible();
    });

    it("cannot be operated: no close, no save, and the fields are inert", async () => {
      const { user } = renderFrame({ staged: true });

      await user.click(screen.getByRole("button", { name: "Open dialog" }));

      const dialog = screen.getByRole("dialog");
      expect(within(dialog).queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
      expect(within(dialog).queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
      expect(within(dialog).getByLabelText("Name").closest("[inert]")).not.toBeNull();
    });

    it("does not take focus, and does not close on Escape", async () => {
      const { user } = renderFrame({ staged: true });
      const opener = screen.getByRole("button", { name: "Open dialog" });

      await user.click(opener);
      expect(opener).toHaveFocus();

      await user.keyboard("{Escape}");
      expect(screen.getByRole("dialog")).toBeVisible();
    });

    it("is not counted as a dialog the user has open", async () => {
      // Otherwise the assistant would refuse to act because of its own form.
      const { user } = renderFrame({ staged: true });

      await user.click(screen.getByRole("button", { name: "Open dialog" }));

      expect(screen.getByRole("status", { name: "Open dialogs" })).toHaveTextContent("0");
      expect(page()).not.toHaveAttribute("inert");
    });
  });
});
