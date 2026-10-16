/**
 * Crop a chosen photo to a square before it becomes an avatar.
 *
 * One square over the picture: drag inside it to move it, drag a corner to resize it.
 * Pointer events rather than mouse and touch separately, so the same handlers serve a
 * phone; `touch-none` on the stage stops the browser treating the drag as a scroll or
 * a pinch-zoom of the page. The square can also be moved with the arrow keys (and
 * resized with Shift + arrows) once focused.
 *
 * The geometry lives in `lib/crop.ts`; this file only turns gestures into calls to it.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Button } from "./Button";
import { Modal } from "./Modal";
import {
  initialCrop,
  moveCrop,
  renderCrop,
  resizeCrop,
  type Corner,
  type Square,
} from "@/lib/crop";

export function AvatarCropper({
  file,
  onCancel,
  onCrop,
}: {
  /** The photo to crop; the dialog is open while this is set. */
  file: File | null;
  onCancel: () => void;
  onCrop: (cropped: Blob) => void;
}) {
  return (
    <Modal
      open={file !== null}
      onClose={onCancel}
      title="Crop your photo"
      description="Drag the square to move it, or drag a corner to resize it."
    >
      {/* Keyed by the file, so picking a second photo starts from a fresh crop. */}
      {file && <CropStage key={`${file.name}-${file.lastModified}-${file.size}`} file={file} onCancel={onCancel} onCrop={onCrop} />}
    </Modal>
  );
}

type Gesture = {
  pointerId: number;
  mode: "move" | Corner;
  startX: number;
  startY: number;
  start: Square;
  /** Natural pixels per screen pixel, fixed for the gesture. */
  scale: number;
};

// Inside the square, not straddling its corners: the stage clips at the photo's edge,
// and a square filling the photo would leave only a sliver of a straddling handle to
// grab — too little for a finger.
const CORNERS: { corner: Corner; className: string }[] = [
  { corner: "nw", className: "left-0 top-0 items-start justify-start cursor-nwse-resize" },
  { corner: "ne", className: "right-0 top-0 items-start justify-end cursor-nesw-resize" },
  { corner: "sw", className: "bottom-0 left-0 items-end justify-start cursor-nesw-resize" },
  { corner: "se", className: "bottom-0 right-0 items-end justify-end cursor-nwse-resize" },
];

function CropStage({
  file,
  onCancel,
  onCrop,
}: {
  file: File;
  onCancel: () => void;
  onCrop: (cropped: Blob) => void;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [crop, setCrop] = useState<Square | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const image = useRef<HTMLImageElement>(null);
  const gesture = useRef<Gesture | null>(null);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setSource(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  function onLoad() {
    const element = image.current;
    if (!element || !element.naturalWidth || !element.naturalHeight) return;
    setNatural({ width: element.naturalWidth, height: element.naturalHeight });
    setCrop(initialCrop(element.naturalWidth, element.naturalHeight));
  }

  function begin(event: PointerEvent<HTMLElement>, mode: Gesture["mode"]) {
    const element = image.current;
    if (!crop || !natural || !element) return;
    event.preventDefault();
    // A corner sits inside the square; without this the square would start a move too.
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const shown = element.getBoundingClientRect().width;
    gesture.current = {
      pointerId: event.pointerId,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      start: crop,
      scale: shown > 0 ? natural.width / shown : 1,
    };
  }

  function drag(event: PointerEvent<HTMLElement>) {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId || !natural) return;
    const dx = (event.clientX - current.startX) * current.scale;
    const dy = (event.clientY - current.startY) * current.scale;
    setCrop(
      current.mode === "move"
        ? moveCrop(current.start, dx, dy, natural.width, natural.height)
        : resizeCrop(current.start, current.mode, dx, dy, natural.width, natural.height),
    );
  }

  function end(event: PointerEvent<HTMLElement>) {
    if (gesture.current?.pointerId === event.pointerId) gesture.current = null;
  }

  function nudge(event: KeyboardEvent<HTMLElement>) {
    if (!crop || !natural) return;
    const step = Math.max(1, Math.round(Math.min(natural.width, natural.height) / 50));
    const offsets: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const offset = offsets[event.key];
    if (!offset) return;
    event.preventDefault();
    const [dx, dy] = offset;
    setCrop(
      event.shiftKey
        ? resizeCrop(crop, "se", dx, dy, natural.width, natural.height)
        : moveCrop(crop, dx, dy, natural.width, natural.height),
    );
  }

  async function save() {
    if (!crop || !image.current) return;
    setFailure(null);
    setBusy(true);
    try {
      onCrop(await renderCrop(image.current, crop));
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : "The photo could not be cropped.");
      setBusy(false);
    }
  }

  const percent = (value: number, of: number) => `${(value / of) * 100}%`;

  return (
    <div className="flex flex-col gap-4">
      <div className="relative mx-auto w-fit max-w-full touch-none select-none overflow-hidden rounded-md bg-gray-100">
        {source && (
          <img
            ref={image}
            src={source}
            alt="The photo you chose"
            draggable={false}
            onLoad={onLoad}
            onError={() => setFailure("That file could not be opened as an image.")}
            className="block max-h-[55vh] max-w-full"
          />
        )}

        {crop && natural && (
          <div
            role="group"
            aria-label="Crop area. Arrow keys move it; Shift and arrow keys resize it."
            tabIndex={0}
            onPointerDown={(event) => begin(event, "move")}
            onPointerMove={drag}
            onPointerUp={end}
            onPointerCancel={end}
            onKeyDown={nudge}
            // The huge spread shadow darkens everything outside the square; the stage's
            // overflow-hidden clips it to the picture.
            className="absolute cursor-move shadow-[0_0_0_9999px_rgba(0,0,0,0.55)] outline-2 outline-white outline-offset-0 focus-visible:outline-brand-400"
            style={{
              left: percent(crop.x, natural.width),
              top: percent(crop.y, natural.height),
              width: percent(crop.size, natural.width),
              height: percent(crop.size, natural.height),
            }}
          >
            {/* A circle inside the square previews how the avatar will be shown. */}
            <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-white/70" />
            {CORNERS.map(({ corner, className }) => (
              <span
                key={corner}
                aria-hidden="true"
                data-corner={corner}
                onPointerDown={(event) => begin(event, corner)}
                onPointerMove={drag}
                onPointerUp={end}
                onPointerCancel={end}
                // A 32px target for a finger, drawn as a smaller white handle in the corner.
                className={`absolute flex size-8 ${className}`}
              >
                <span className="size-4 bg-white shadow ring-1 ring-black/20" />
              </span>
            ))}
          </div>
        )}
      </div>

      {failure && <p className="text-sm text-danger-600">{failure}</p>}

      <div className="flex flex-col-reverse gap-2 app-sm:flex-row app-sm:justify-end">
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" busy={busy} disabled={!crop} onClick={() => void save()}>
          Save photo
        </Button>
      </div>
    </div>
  );
}
