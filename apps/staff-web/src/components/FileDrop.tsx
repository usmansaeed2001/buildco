/**
 * A file picker that also accepts a drop.
 *
 * Selection only — it hands files to `onFiles` and knows nothing about uploading. The
 * two-step signed-URL flow lives in the attachment hook, so this stays usable for the
 * closing-form photo, the avatar, and anything else that needs a file.
 *
 * Built around a real `<input type="file">` inside a `<label>` rather than a div with a
 * click handler: that is what makes it keyboard-reachable and announced as "Add photo,
 * button" without any ARIA at all.
 */
import { useId, useRef, useState } from "react";
import { cn } from "@/lib/cn";

export function FileDrop({
  onFiles,
  accept,
  multiple = false,
  disabled = false,
  label = "Add a file",
  hint,
}: {
  onFiles: (files: File[]) => void;
  /** Passed straight to the input, e.g. `"image/*,video/*"`. */
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  label?: string;
  hint?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [over, setOver] = useState(false);

  function emit(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
  }

  return (
    <label
      onDragOver={(event) => {
        if (disabled) return;
        // Both are required: without preventDefault the browser navigates to the file
        // instead of firing onDrop, and the drop is silently lost.
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        if (disabled) return;
        event.preventDefault();
        setOver(false);
        emit(event.dataTransfer.files);
      }}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-card border-2 border-dashed px-4 py-6 text-center transition-colors",
        disabled
          ? "cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400"
          : over
            ? "border-brand-500 bg-brand-50 text-brand-700"
            : "border-gray-300 text-gray-600 hover:border-gray-400 hover:bg-gray-50",
      )}
    >
      <input
        ref={input}
        type="file"
        className="sr-only"
        // The label element wraps both the label text and the hint, so without an
        // explicit name the control announces as "Add a photo Drag one here, or click
        // to choose". The hint belongs in the description, not the name.
        aria-label={label}
        {...(hint ? { "aria-describedby": hintId } : {})}
        disabled={disabled}
        multiple={multiple}
        {...(accept ? { accept } : {})}
        onChange={(event) => {
          emit(event.target.files);
          // Reset, so choosing the same file twice in a row fires onChange the second
          // time. Without this a failed upload cannot be retried with the same file.
          event.target.value = "";
        }}
      />
      <span className="text-sm font-medium">{label}</span>
      {hint && (
        <span id={hintId} className="text-xs text-gray-500">
          {hint}
        </span>
      )}
    </label>
  );
}
