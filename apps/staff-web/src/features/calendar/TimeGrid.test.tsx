/**
 * The time grid's two ways of creating a meeting, tested on the component directly.
 *
 * Rendered here rather than through `CalendarPage` because these are about pointer and
 * keyboard mechanics, not about routing or fetching — and jsdom gives every element a
 * zero-sized box, so the geometry has to be stubbed for any of it to mean anything.
 *
 * Overlap layout is deliberately *not* tested here. `assignColumns` is a pure function
 * with its own matrix in `domain/calendar.test.ts`; asserting pixel percentages through
 * the DOM would test the same logic twice and the second one more slowly.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimeGrid } from "./TimeGrid";

const DAY = new Date(2026, 2, 15); // A Sunday.

/** 48px an hour, so y=480 is 10:00 and y=576 is 12:00. */
function stubGeometry() {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = () =>
    ({
      top: 0,
      left: 0,
      right: 200,
      bottom: 1152,
      width: 200,
      height: 1152,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

function renderGrid(onCreateRange = vi.fn(), canCreate = true) {
  render(
    <TimeGrid
      days={[DAY]}
      byDay={new Map()}
      canCreate={canCreate}
      onOpenMeeting={vi.fn()}
      onCreateRange={onCreateRange}
    />,
  );
  return onCreateRange;
}

/** The element carrying the pointer handlers: two hops up from any slot button. */
function dragSurface(): HTMLElement {
  const slot = screen.getByRole("button", { name: /Create a meeting at Sunday 12:00 AM/ });
  return slot.parentElement!.parentElement as HTMLElement;
}

/**
 * Dispatch a pointer event that actually carries coordinates.
 *
 * jsdom does not implement `PointerEvent`, so `fireEvent.pointerDown` falls back to a
 * bare `Event` — which reaches the handler but has no `clientY` and no `button`, making
 * every drag resolve to midnight. A `MouseEvent` carries both and React reads the fields
 * off the native event rather than checking its class, so this is what the browser
 * actually delivers, minus the pointer-specific fields the grid does not use.
 */
function pointer(target: HTMLElement, type: string, init: MouseEventInit = {}) {
  fireEvent(target, new MouseEvent(type, { bubbles: true, ...init }));
}

function times(call: [Date, Date]) {
  const format = (at: Date) =>
    `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return [format(call[0]), format(call[1])];
}

describe("TimeGrid", () => {
  it("draws all twenty-four hours", () => {
    renderGrid();

    expect(screen.getByText("1 AM")).toBeVisible();
    expect(screen.getByText("11 PM")).toBeVisible();
  });

  describe("drag to create", () => {
    it("turns a drag into the range it covered", () => {
      restore = stubGeometry();
      const onCreateRange = renderGrid();
      const column = dragSurface();

      pointer(column, "pointerdown", { button: 0, clientY: 480 });
      pointer(column, "pointermove", { clientY: 576 });
      pointer(column, "pointerup", { clientY: 576 });

      expect(times(onCreateRange.mock.calls[0] as [Date, Date])).toEqual(["10:00", "12:00"]);
    });

    it("reads an upward drag the same as a downward one", () => {
      restore = stubGeometry();
      const onCreateRange = renderGrid();
      const column = dragSurface();

      pointer(column, "pointerdown", { button: 0, clientY: 576 });
      pointer(column, "pointermove", { clientY: 480 });
      pointer(column, "pointerup", { clientY: 480 });

      expect(times(onCreateRange.mock.calls[0] as [Date, Date])).toEqual(["10:00", "12:00"]);
    });

    it("snaps to the quarter hour rather than to the pixel", () => {
      restore = stubGeometry();
      const onCreateRange = renderGrid();
      const column = dragSurface();

      // 484px is 10:05, which nobody meant.
      pointer(column, "pointerdown", { button: 0, clientY: 484 });
      pointer(column, "pointermove", { clientY: 540 });
      pointer(column, "pointerup", { clientY: 540 });

      expect(times(onCreateRange.mock.calls[0] as [Date, Date])).toEqual(["10:00", "11:15"]);
    });

    it("treats a drag shorter than a slot as a click, not a zero-length meeting", () => {
      // Which is also what makes a tap work on a phone, where a precise drag is awkward.
      restore = stubGeometry();
      const onCreateRange = renderGrid();
      const column = dragSurface();

      pointer(column, "pointerdown", { button: 0, clientY: 480 });
      pointer(column, "pointerup", { clientY: 482 });

      expect(times(onCreateRange.mock.calls[0] as [Date, Date])).toEqual(["10:00", "11:00"]);
    });

    it("ignores a right-click", () => {
      restore = stubGeometry();
      const onCreateRange = renderGrid();
      const column = dragSurface();

      pointer(column, "pointerdown", { button: 2, clientY: 480 });
      pointer(column, "pointerup", { clientY: 576 });

      expect(onCreateRange).not.toHaveBeenCalled();
    });

    it("offers no drag surface to someone who cannot create", () => {
      renderGrid(vi.fn(), false);

      expect(screen.queryByRole("button", { name: /Create a meeting/ })).not.toBeInTheDocument();
    });
  });

  describe("keyboard", () => {
    it("creates without any pointer at all", async () => {
      // The accessibility guarantee, asserted rather than claimed in a comment: drag is
      // an accelerator layered over real buttons, never the only way in.
      const user = userEvent.setup();
      const onCreateRange = renderGrid();

      await user.click(
        screen.getByRole("button", { name: /Create a meeting at Sunday 9:00 AM/ }),
      );

      expect(times(onCreateRange.mock.calls[0] as [Date, Date])).toEqual(["09:00", "10:00"]);
    });

    it("is a single tab stop, with arrows moving inside it", async () => {
      // 48 slots a day — 336 across a week — would be technically accessible and
      // practically a trap for anyone tabbing toward the content below.
      const user = userEvent.setup();
      renderGrid();

      const tabbable = screen
        .getAllByRole("button", { name: /Create a meeting/ })
        .filter((slot) => slot.tabIndex === 0);
      expect(tabbable).toHaveLength(1);
      expect(tabbable[0]).toHaveAccessibleName(/9:00 AM/);

      tabbable[0]!.focus();
      await user.keyboard("{ArrowDown}");

      expect(
        screen.getByRole("button", { name: /Create a meeting at Sunday 9:30 AM/ }),
      ).toHaveFocus();
    });

    it("does not run past midnight", async () => {
      const user = userEvent.setup();
      renderGrid();

      const midnight = screen.getByRole("button", {
        name: /Create a meeting at Sunday 12:00 AM/,
      });
      midnight.focus();
      await user.keyboard("{ArrowUp}");

      expect(midnight).toHaveFocus();
    });
  });
});
