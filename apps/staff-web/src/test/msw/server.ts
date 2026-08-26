/**
 * The MSW request interceptor, shared by every test.
 *
 * `onUnhandledRequest: "error"` is the important setting. The alternative — letting an
 * unmatched call through — turns a missing stub into a network attempt that jsdom
 * fails asynchronously, which surfaces as an unrelated empty render rather than as the
 * missing stub it is.
 */
import { setupServer } from "msw/node";
import { handlers } from "./handlers";

export const server = setupServer(...handlers);
