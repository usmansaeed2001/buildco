/**
 * The frame the signed-in app sits in: an app column, and room for a panel beside it.
 *
 * Three things live here because all three follow from a panel being able to dock on
 * the right.
 *
 * **The column is a container.** Page layouts ask it how wide it is (the `app-sm:`
 * variants in `styles/index.css`) rather than asking the window, so opening a panel
 * reflows the app into the space that is left.
 *
 * **Dialogs get somewhere to go.** A native `<dialog>` opened with `showModal()` makes
 * everything outside itself inert, the panel included. So while a panel is open,
 * `Modal` renders into the dialog layer here instead, which covers the column and
 * nothing else. The page behind it is made inert by hand, which is the one thing the
 * native element used to do for free.
 *
 * **Open dialogs are counted.** Whatever is in the panel may need to know that the
 * user has a dialog open, and nothing else in the app tracks that.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface AppFrameState {
  /** Whether a panel is docked beside the app right now. */
  panelOpen: boolean;
  /** Where a dialog renders while a panel is open. Null until the frame has mounted. */
  dialogLayer: HTMLElement | null;
  /** How many dialogs the user has open. A dialog staged by the assistant is not one. */
  openDialogs: number;
  /** Report a dialog as open. The function it returns reports it closed. */
  registerDialog: () => () => void;
}

const AppFrameContext = createContext<AppFrameState | null>(null);

/** Null outside the signed-in shell, where there is never a panel. */
export function useAppFrame(): AppFrameState | null {
  return useContext(AppFrameContext);
}

export function AppFrame({
  panel,
  launcher,
  children,
}: {
  /** What is docked beside the app. Leave it out and the app has the whole window. */
  panel?: ReactNode;
  /**
   * The control that opens the panel. Rendered outside the app column because it is
   * fixed to the window, and the column, being a container, would capture it: a fixed
   * element inside one is positioned against the container, not the viewport.
   */
  launcher?: ReactNode;
  children: ReactNode;
}) {
  const [dialogLayer, setDialogLayer] = useState<HTMLElement | null>(null);
  const [openDialogs, setOpenDialogs] = useState(0);

  const registerDialog = useCallback(() => {
    setOpenDialogs((count) => count + 1);
    return () => setOpenDialogs((count) => count - 1);
  }, []);

  const panelOpen = panel !== undefined && panel !== null;
  const state = useMemo(
    () => ({ panelOpen, dialogLayer, openDialogs, registerDialog }),
    [panelOpen, dialogLayer, openDialogs, registerDialog],
  );

  return (
    <AppFrameContext.Provider value={state}>
      <div className="flex min-h-dvh">
        {/* `relative` so the dialog layer can cover exactly this column. `min-w-0` so a
            wide table inside cannot push the panel off the screen. */}
        <div data-app-column className="@container/app relative flex min-w-0 flex-1 flex-col">
          <div
            className="flex flex-1 flex-col"
            // Only with a panel open. With none, dialogs are native and the browser
            // already makes the page behind them inert.
            inert={panelOpen && openDialogs > 0}
          >
            {children}
          </div>
          <div ref={setDialogLayer} data-dialog-layer />
        </div>

        {panelOpen && (
          <aside
            aria-label="Side panel"
            // Sticky and viewport-tall: the page scrolls on the document, and the panel
            // has to stay where it is while it does.
            className="sticky top-0 h-dvh w-[400px] shrink-0 border-l border-gray-200 bg-surface"
          >
            {panel}
          </aside>
        )}

        {launcher}
      </div>
    </AppFrameContext.Provider>
  );
}
