/**
 * The frame the signed-in app sits in: an app column, and room for a panel beside it.
 *
 * Several things live here because they all follow from a panel sitting beside the app.
 *
 * **The column is a container.** Page layouts ask it how wide it is (the `app-sm:`
 * variants in `styles/index.css`) rather than asking the window, so opening a panel
 * reflows the app into the space that is left.
 *
 * **The panel is a floating card.** 400px wide, inset 12px from the window on three
 * sides, with rounded corners and one shadow, so the page ground shows round it. It
 * takes 424px of the window and the app still reflows beside it: at 1024px and up the
 * app is never covered. The column takes its new width in one step. Its width is never
 * animated, because laying the whole app out again on every frame is the one animation
 * certain to stutter; the card is what moves.
 *
 * **Dialogs get somewhere to go.** A native `<dialog>` opened with `showModal()` makes
 * everything outside itself inert, the panel included. So while a panel is open,
 * `Modal` renders into the dialog layer here instead, which covers the column and
 * nothing else. The page behind it is made inert by hand, which is the one thing the
 * native element used to do for free.
 *
 * **Open dialogs are counted.** Whatever is in the panel may need to know that the
 * user has a dialog open, and nothing else in the app tracks that.
 *
 * **On a phone there is no beside.** Below 1024px the panel fills the screen, and the
 * column under it is inert. To show the app, with a change staged on it, the panel folds
 * down to a bar at the foot of the window, and the column is given room above the bar so
 * nothing on it is hidden under the bar. Dialogs size themselves to that room too.
 *
 * **The column can be locked.** While the assistant is working, the whole column is made
 * inert, its dialog layer included, and framed so that it is plain why nothing responds.
 * The panel is outside the column and stays live, and so does the banner drawn over the
 * column, because it carries the Stop button. A click on the locked column is caught by
 * the frame and counted, so that the banner can answer it.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";
import { usePresence } from "@/features/agent/usePresence";

export interface AppFrameState {
  /** Whether a panel is docked beside the app right now. */
  panelOpen: boolean;
  /** Where a dialog renders while a panel is open. Null until the frame has mounted. */
  dialogLayer: HTMLElement | null;
  /** How many dialogs the user has open. A dialog staged by the assistant is not one. */
  openDialogs: number;
  /** Report a dialog as open. The function it returns reports it closed. */
  registerDialog: () => () => void;
  /** How many times the locked app has been clicked. The lock's banner answers each. */
  lockedClicks: number;
  /** Laid out for a phone: dialogs over the column open as sheets. */
  phone: boolean;
}

const AppFrameContext = createContext<AppFrameState | null>(null);

/** Null outside the signed-in shell, where there is never a panel. */
export function useAppFrame(): AppFrameState | null {
  return useContext(AppFrameContext);
}

/**
 * A locked column is inert, and an inert scroll area does not answer the wheel or a
 * finger. A staged form taller than the window would then have a foot nobody could
 * read, on the one screen where reading all of it is the point. The lock's own layer is
 * not inert and is what the pointer lands on, so it passes the scrolling on to the
 * staged form underneath. Nothing in the form becomes operable by this.
 */
function useStagedScrolling(layer: HTMLElement | null) {
  useEffect(() => {
    if (!layer) return;

    const bodyUnder = (x: number, y: number): HTMLElement | null => {
      for (const body of document.querySelectorAll<HTMLElement>("[data-staged-body]")) {
        const box = body.getBoundingClientRect();
        const inside = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
        if (inside && body.scrollHeight > body.clientHeight) return body;
      }
      return null;
    };

    const onWheel = (event: WheelEvent) => {
      const body = bodyUnder(event.clientX, event.clientY);
      if (!body) return;
      body.scrollTop += event.deltaY;
      event.preventDefault();
    };

    let dragging: { body: HTMLElement; y: number } | null = null;
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      const body = touch ? bodyUnder(touch.clientX, touch.clientY) : null;
      dragging = body && touch ? { body, y: touch.clientY } : null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!dragging || !touch) return;
      dragging.body.scrollTop += dragging.y - touch.clientY;
      dragging.y = touch.clientY;
      event.preventDefault();
    };

    layer.addEventListener("wheel", onWheel, { passive: false });
    layer.addEventListener("touchstart", onTouchStart, { passive: true });
    layer.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      layer.removeEventListener("wheel", onWheel);
      layer.removeEventListener("touchstart", onTouchStart);
      layer.removeEventListener("touchmove", onTouchMove);
    };
  }, [layer]);
}

/** The panel's place on a phone: covering the window, or a bar along its foot. */
const PHONE_PANEL = {
  full: "fixed inset-0 z-50 h-dvh w-full border-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]",
  mini: "fixed inset-x-0 bottom-0 z-50 max-h-[80dvh] w-full rounded-t-2xl border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)] shadow-panel",
} as const;

/** How tall the folded panel is, for the column and its dialogs to keep clear of it. */
function useBarHeight(bar: HTMLElement | null, folded: boolean): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!bar || !folded) {
      setHeight(0);
      return;
    }
    const measure = () => setHeight(bar.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [bar, folded]);
  return height;
}

export function AppFrame({
  panel,
  panelClosing = false,
  launcher,
  locked = false,
  lockBanner,
  phone = false,
  phoneView = "full",
  children,
}: {
  /** What is docked beside the app. Leave it out and the app has the whole window. */
  panel?: ReactNode;
  /** The panel is on its way out: it can still be seen and can no longer be used. */
  panelClosing?: boolean;
  /**
   * The control that opens the panel. Rendered outside the app column because it is
   * fixed to the window, and the column, being a container, would capture it: a fixed
   * element inside one is positioned against the container, not the viewport.
   */
  launcher?: ReactNode;
  /** Make the whole app column inert and frame it. The panel is not affected. */
  locked?: boolean;
  /** Shown over the locked column. It is not inert: it is where Stop lives. */
  lockBanner?: ReactNode;
  /** Laid out for a phone: the panel covers the app rather than sitting beside it. */
  phone?: boolean;
  /** On a phone, whether the panel fills the window or is folded down to a bar. */
  phoneView?: "full" | "mini";
  children: ReactNode;
}) {
  const [dialogLayer, setDialogLayer] = useState<HTMLElement | null>(null);
  const [lockLayer, setLockLayer] = useState<HTMLElement | null>(null);
  const [openDialogs, setOpenDialogs] = useState(0);
  const [lockedClicks, setLockedClicks] = useState(0);

  const registerDialog = useCallback(() => {
    setOpenDialogs((count) => count + 1);
    return () => setOpenDialogs((count) => count - 1);
  }, []);

  // The frame fades out when the lock lifts. The column itself is unlocked at once:
  // only the frame lingers, and while it does it cannot be pressed.
  const lock = usePresence(locked);
  const banner = useRef(lockBanner);
  if (locked) banner.current = lockBanner;
  useStagedScrolling(locked ? lockLayer : null);

  const panelOpen = panel !== undefined && panel !== null;
  const state = useMemo(
    () => ({ panelOpen, dialogLayer, openDialogs, registerDialog, lockedClicks, phone }),
    [panelOpen, dialogLayer, openDialogs, registerDialog, lockedClicks, phone],
  );
  const covered = phone && panelOpen && phoneView === "full";
  const [aside, setAside] = useState<HTMLElement | null>(null);
  const bar = useBarHeight(aside, phone && panelOpen && phoneView === "mini");

  return (
    <AppFrameContext.Provider value={state}>
      <div
        className="flex min-h-dvh"
        {...(phone ? { "data-phone": phoneView } : {})}
        style={{ "--ast-bar": `${bar}px` } as React.CSSProperties}
      >
        {/* The wrapper is what the lock's frame and banner are positioned against. It is
            never inert itself; the column inside it is. */}
        <div className="relative flex min-w-0 flex-1">
          {/* `relative` so the dialog layer can cover exactly this column. `min-w-0` so
              a wide table inside cannot push the panel off the screen. */}
          <div
            data-app-column
            className="@container/app relative flex min-w-0 flex-1 flex-col"
            // Under a panel that fills the window the column cannot be seen, so it must
            // not be reachable by the keyboard or a screen reader either.
            inert={locked || covered}
            style={bar ? { paddingBottom: bar } : undefined}
          >
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

          {lock.mounted && (
            // Covers the column, which is as tall as the page; the banner inside is
            // sticky, so it stays in view while the page is scrolled. It sits under
            // the navigation bar, not on it. The page is not dimmed: the user has to
            // read what is on it.
            <div
              ref={setLockLayer}
              data-app-lock
              {...(lock.closing ? { "data-closing": "" } : {})}
              onClick={(event) => {
                if (event.target === event.currentTarget) setLockedClicks((count) => count + 1);
              }}
              className="ast-lock absolute inset-0 z-50"
            >
              <span aria-hidden="true" className="ast-lock-sweep" />
              {/* On a phone Stop is on the bar at the foot, under the user's thumb, and
                  a banner here would sit on the staged form's title. */}
              {!phone && (
                <div className="sticky top-[65px] mx-auto w-fit max-w-[calc(100%-1.5rem)]">
                  {banner.current}
                </div>
              )}
            </div>
          )}
        </div>

        {panelOpen && (
          <aside
            ref={setAside}
            aria-label="Side panel"
            {...(panelClosing ? { "data-closing": "" } : {})}
            // Sticky and nearly viewport-tall: the page scrolls on the document, and
            // the card has to stay where it is while it does.
            //
            // Below 1024px there is no room beside the app, so it overlays the app's
            // right side instead, with the same inset. A panel is never hidden for want
            // of room: it may be holding a live conversation, and Stop, Approve and End
            // have to stay reachable.
            //
            // On a phone it is not beside anything: see `PHONE_PANEL`.
            className={cn(
              "ast-card overflow-hidden border border-gray-200 bg-surface",
              phone
                ? PHONE_PANEL[phoneView]
                : "sticky top-3 m-3 h-[calc(100dvh-1.5rem)] w-[400px] shrink-0 self-start rounded-2xl shadow-panel max-lg:fixed max-lg:top-3 max-lg:right-3 max-lg:z-50 max-lg:m-0 max-lg:max-w-[calc(100vw-1.5rem)]",
            )}
          >
            {panel}
          </aside>
        )}

        {launcher}
      </div>
    </AppFrameContext.Provider>
  );
}
