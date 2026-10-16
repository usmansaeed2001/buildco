/**
 * The square crop behind the profile-photo cropper.
 *
 * All of it works in the image's own (natural) pixels, not screen pixels: the picture is
 * shown scaled to fit the dialog, and the crop has to land on the same part of the
 * photo whatever size it happened to be drawn at. The cropper converts pointer movement
 * into natural pixels before calling in here.
 *
 * Every gesture is applied to the crop as it was when the gesture *started*, with the
 * total distance moved so far. Applying each pointermove's small step to the previous
 * result instead would accumulate rounding, and a drag pushed against an edge would
 * leave the square somewhere other than under the finger once it came back.
 */

export type Square = { x: number; y: number; size: number };
export type Corner = "nw" | "ne" | "sw" | "se";

/** Smallest crop, in natural pixels. Below this an avatar is mostly upscaling blur. */
export const MIN_CROP = 32;

/** Edge of the saved image. Avatars are shown at 64px at most; 512 covers 2x and up. */
export const OUTPUT_SIZE = 512;

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/** The largest centred square: what most people want, so it is where the crop starts. */
export function initialCrop(width: number, height: number): Square {
  const size = Math.min(width, height);
  return { x: (width - size) / 2, y: (height - size) / 2, size };
}

export function moveCrop(start: Square, dx: number, dy: number, width: number, height: number): Square {
  return {
    size: start.size,
    x: clamp(start.x + dx, 0, width - start.size),
    y: clamp(start.y + dy, 0, height - start.size),
  };
}

/**
 * Drag one corner; the opposite corner stays put. The square stays square, so the two
 * axes of the drag are averaged into one change of size — taking only the larger would
 * make a mostly-sideways drag feel like it ignores the vertical half.
 */
export function resizeCrop(
  start: Square,
  corner: Corner,
  dx: number,
  dy: number,
  width: number,
  height: number,
): Square {
  const right = corner === "ne" || corner === "se";
  const bottom = corner === "sw" || corner === "se";

  const grow = ((right ? dx : -dx) + (bottom ? dy : -dy)) / 2;

  // The fixed corner, and how far the square can grow from it before leaving the image.
  const anchorX = right ? start.x : start.x + start.size;
  const anchorY = bottom ? start.y : start.y + start.size;
  const room = Math.min(right ? width - anchorX : anchorX, bottom ? height - anchorY : anchorY);

  const size = clamp(start.size + grow, Math.min(MIN_CROP, room), room);
  return {
    size,
    x: right ? anchorX : anchorX - size,
    y: bottom ? anchorY : anchorY - size,
  };
}

/**
 * Draw the cropped square onto a canvas and encode it. JPEG on a white ground: a
 * transparent PNG would otherwise come out with a black background, and JPEG keeps an
 * avatar to tens of kilobytes where PNG can run to megabytes.
 */
export function renderCrop(image: HTMLImageElement, crop: Square): Promise<Blob> {
  const edge = Math.round(Math.min(OUTPUT_SIZE, crop.size));
  const canvas = document.createElement("canvas");
  canvas.width = edge;
  canvas.height = edge;

  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new Error("This browser cannot crop images."));

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, edge, edge);
  context.imageSmoothingQuality = "high";
  context.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, edge, edge);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("The photo could not be cropped."))),
      "image/jpeg",
      0.9,
    );
  });
}
