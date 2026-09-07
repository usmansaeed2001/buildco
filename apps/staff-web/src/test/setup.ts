/**
 * Global test setup.
 *
 * The MSW lifecycle lives here rather than in each file so no test can forget to reset
 * handlers — a leaked per-test override is the kind of failure that appears in an
 * unrelated file and takes an hour to trace.
 */
import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { cleanup } from "@testing-library/react";
import { server } from "./msw/server";
import { resetFactories } from "./factories";
import { setPreference } from "@/lib/theme";

/**
 * jsdom ships `<dialog>` the element but not its behaviour: `showModal`, `show` and
 * `close` are simply absent, so anything built on `components/Modal` throws
 * "element.showModal is not a function" the moment it opens. That is every confirm
 * step and every modal in the app.
 *
 * This is the smallest polyfill that makes them testable — it toggles `open` and fires
 * the `close` event the component listens for. It does not emulate the top layer,
 * focus trapping or backdrop hit-testing, so a test must not assert on those; the
 * browser provides them and jsdom never will.
 */
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.show = function show(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement, value?: string) {
    this.open = false;
    if (value !== undefined) this.returnValue = value;
    this.dispatchEvent(new Event("close"));
  };
}

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetFactories();
  localStorage.clear();
  // The theme store is a module singleton, so a test that switches to dark leaks it into
  // every test that runs after it. `localStorage.clear()` alone does not undo that — the
  // preference is also held in memory.
  setPreference("system");
});

afterAll(() => server.close());
