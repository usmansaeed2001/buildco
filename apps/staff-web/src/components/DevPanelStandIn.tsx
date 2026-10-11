/**
 * A placeholder for the assistant's panel. Development only.
 *
 * It exists so two things can be judged by eye before the real panel is built: how each
 * screen lays out when the app is squeezed into the space beside a panel, and whether a
 * dialog opened while the panel is showing leaves the panel usable. The controls do
 * nothing; they are here to be clicked and typed into while a dialog is open.
 *
 * Delete this file when the real panel replaces it in `AppShell`.
 */
import { useState } from "react";
import { Button } from "./Button";
import { useAppFrame } from "./AppFrame";

export function DevPanelStandIn({ onClose }: { onClose: () => void }) {
  const frame = useAppFrame();
  const [text, setText] = useState("");
  const [clicks, setClicks] = useState(0);

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-base font-semibold text-gray-900">Panel stand-in</h2>
        <Button size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      <p className="text-sm text-gray-600">
        Development only. The app on the left is now 400px narrower, and its layouts should
        follow that width, not the window&rsquo;s.
      </p>

      <dl className="rounded-card bg-gray-50 p-3 text-sm text-gray-700">
        <div className="flex justify-between">
          <dt>Dialogs you have open</dt>
          <dd className="tnum font-medium">{frame?.openDialogs ?? 0}</dd>
        </div>
      </dl>

      <p className="text-sm text-gray-600">
        Open any dialog in the app, then use these. They should still work, and the dialog
        should stay inside the app&rsquo;s side of the screen.
      </p>

      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Type here while a dialog is open"
        aria-label="Stand-in text box"
        className="h-9 rounded-md border border-gray-300 bg-surface px-3 text-sm text-gray-900"
      />
      <Button variant="primary" onClick={() => setClicks((count) => count + 1)}>
        Clicked {clicks} {clicks === 1 ? "time" : "times"}
      </Button>
    </div>
  );
}
