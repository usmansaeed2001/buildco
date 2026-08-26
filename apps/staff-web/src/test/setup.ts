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

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetFactories();
  localStorage.clear();
});

afterAll(() => server.close());
