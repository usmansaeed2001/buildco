/**
 * Whether what is being drawn is inside a form the assistant is showing, as opposed to
 * one the user is filling in. `Modal` says so; the form controls and `staged.tsx` read
 * it. See `staged.tsx` for what follows from it.
 */
import { createContext, useContext } from "react";

const StagedContext = createContext(false);

export const StagedProvider = StagedContext.Provider;

export function useStaged(): boolean {
  return useContext(StagedContext);
}
