/**
 * The room list beside the editor.
 *
 * Renaming is inline. The legacy version used `prompt()`, which cannot be styled, does
 * not say which estimate it belongs to, and on mobile Safari suspends the page — the
 * autosave timer with it.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Input } from "@/components/form";
import { cn } from "@/lib/cn";
import { formatMoney } from "@/domain/money";
import { roomTotal } from "@/domain/estimateTotals";
import type { RoomDoc } from "./document";

export function RoomRail({
  rooms,
  activeIndex,
  readOnly,
  onSelect,
  onAdd,
  onRename,
  onDelete,
}: {
  rooms: readonly RoomDoc[];
  activeIndex: number | null;
  readOnly: boolean;
  onSelect: (index: number) => void;
  onAdd: () => void;
  onRename: (index: number, name: string) => void;
  onDelete: (index: number) => void;
}) {
  const [renaming, setRenaming] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);

  const doomed = pendingDelete === null ? null : rooms[pendingDelete];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium tracking-wide text-gray-500 uppercase">Rooms</h2>
        {!readOnly && (
          <Button size="sm" variant="ghost" onClick={onAdd}>
            + Add room
          </Button>
        )}
      </div>

      {rooms.length === 0 ? (
        <p className="rounded-card bg-surface px-3 py-6 text-center text-sm text-gray-500 ring-1 ring-gray-200">
          No rooms yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rooms.map((room, index) => (
            <li key={index}>
              {renaming === index ? (
                <RenameField
                  value={room.name}
                  onCommit={(name) => {
                    if (name.trim()) onRename(index, name.trim());
                    setRenaming(null);
                  }}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <div
                  className={cn(
                    "group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm",
                    index === activeIndex
                      ? "bg-brand-50 text-brand-800"
                      : "text-gray-700 hover:bg-gray-100",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(index)}
                    aria-current={index === activeIndex ? "true" : undefined}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate font-medium">{room.name || "Untitled"}</span>
                    <span className="block text-xs text-gray-500">
                      {room.items.length} {room.items.length === 1 ? "item" : "items"} ·{" "}
                      <span className="tnum">{formatMoney(roomTotal(room))}</span>
                    </span>
                  </button>

                  {!readOnly && (
                    // Always in the DOM rather than rendered on hover: a control that
                    // only exists on :hover is unreachable by keyboard and invisible to
                    // a screen reader.
                    <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                      <IconButton label={`Rename ${room.name}`} onClick={() => setRenaming(index)}>
                        ✎
                      </IconButton>
                      <IconButton
                        label={`Delete ${room.name}`}
                        onClick={() => setPendingDelete(index)}
                      >
                        ✕
                      </IconButton>
                    </span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={doomed !== undefined && doomed !== null}
        title="Delete this room?"
        confirmLabel="Delete room"
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete !== null) onDelete(pendingDelete);
          setPendingDelete(null);
        }}
      >
        <p>
          <strong>{doomed?.name || "This room"}</strong> and its {doomed?.items.length ?? 0}{" "}
          {doomed?.items.length === 1 ? "line item" : "line items"} will be removed.
        </p>
        <p className="mt-2">You can undo this.</p>
      </ConfirmDialog>
    </div>
  );
}

function RenameField({
  value,
  onCommit,
  onCancel,
}: {
  value: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => field.current?.select(), []);

  return (
    <Input
      ref={field}
      value={draft}
      aria-label="Room name"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onCommit(draft);
        if (event.key === "Escape") onCancel();
      }}
    />
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="rounded p-1 text-xs text-gray-400 hover:bg-gray-200 hover:text-gray-700"
    >
      {children}
    </button>
  );
}
