/**
 * Photos and video attached to one line item.
 *
 * Attachments are addressed by `(room_index, item_index)` — plain integers, not foreign
 * keys. That is the legacy scheme, preserved so objects copied across from Supabase stay
 * addressable, and it has a consequence worth knowing: **reordering or deleting a room
 * or a line item does not move its attachments.** They stay pinned to the position, so
 * they would appear under whatever ends up at that index.
 *
 * Nothing here tries to fix that. Doing it properly means a real foreign key and a
 * migration, and quietly re-indexing on the client would only make the mismatch harder
 * to see. It is recorded in BACKLOG.md instead.
 */
import { useState } from "react";
import { ApiError } from "@/api/client";
import {
  UploadFailedError,
  useDeleteAttachment,
  useUploadAttachment,
} from "@/api/queries/attachments";
import type { AttachmentOut } from "@/api/types";
import { Spinner } from "@/components/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { FileDrop } from "@/components/FileDrop";
import { Modal } from "@/components/Modal";
import { Alert } from "@/components/feedback";
import { useToast } from "@/components/Toast";

/** What the API's own upload endpoint accepts, mirrored so the picker filters. */
const ACCEPT = "image/*,video/*";

export function LineItemAttachments({
  estimateId,
  roomIndex,
  itemIndex,
  attachments,
  readOnly,
  label,
}: {
  estimateId: string;
  roomIndex: number;
  itemIndex: number;
  /** Already filtered to this line by the caller. */
  attachments: AttachmentOut[];
  readOnly: boolean;
  /** Human name for the line, for accessible labels. */
  label: string;
}) {
  const toast = useToast();
  const upload = useUploadAttachment(estimateId);
  const remove = useDeleteAttachment(estimateId);

  const [viewing, setViewing] = useState<AttachmentOut | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AttachmentOut | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function send(files: File[]) {
    setFailure(null);
    for (const file of files) {
      try {
        await upload.mutateAsync({ roomIndex, itemIndex, file });
      } catch (caught) {
        setFailure(describe(caught));
        // Stop on the first failure rather than firing the rest at a storage backend
        // that has just refused one.
        return;
      }
    }
  }

  async function confirmDelete() {
    const doomed = pendingDelete;
    setPendingDelete(null);
    if (!doomed) return;

    try {
      await remove.mutateAsync(doomed.id);
      toast.success("Attachment deleted.");
    } catch (caught) {
      toast.error(describe(caught));
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {failure && <Alert tone="danger">{failure}</Alert>}

      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <Thumbnail
                attachment={attachment}
                readOnly={readOnly}
                onView={() => setViewing(attachment)}
                onDelete={() => setPendingDelete(attachment)}
              />
            </li>
          ))}
        </ul>
      )}

      {!readOnly &&
        (upload.isPending ? (
          <p className="flex items-center gap-2 text-sm text-gray-500">
            <Spinner className="size-4" /> Uploading…
          </p>
        ) : (
          <FileDrop
            multiple
            accept={ACCEPT}
            label={`Add a photo or video to ${label}`}
            hint="Drag one here, or click to choose"
            onFiles={(files) => void send(files)}
          />
        ))}

      <Modal
        open={viewing !== null}
        onClose={() => setViewing(null)}
        title={viewing?.file_name ?? "Attachment"}
        size="xl"
      >
        {viewing?.url ? (
          viewing.is_video ? (
            // No caption track: these are phone clips of a job site uploaded by staff,
            // and there is nowhere for one to come from. The file name is the
            // accessible description, which is the best available here.
            <video
              src={viewing.url}
              controls
              aria-label={viewing.file_name}
              className="max-h-[70vh] w-full"
            />
          ) : (
            <img src={viewing.url} alt={viewing.file_name} className="max-h-[70vh] w-full object-contain" />
          )
        ) : (
          <Alert tone="warning">
            This file has no download link. Cloud Storage signing is unavailable, so the
            file exists but cannot be fetched right now.
          </Alert>
        )}
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this attachment?"
        confirmLabel="Delete"
        busy={remove.isPending}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      >
        <p>
          <strong>{pendingDelete?.file_name}</strong> will be removed from this line item and
          from storage. This cannot be undone.
        </p>
      </ConfirmDialog>
    </div>
  );
}

function Thumbnail({
  attachment,
  readOnly,
  onView,
  onDelete,
}: {
  attachment: AttachmentOut;
  readOnly: boolean;
  onView: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onView}
        aria-label={`View ${attachment.file_name}`}
        className="block size-16 overflow-hidden rounded-md bg-gray-100 ring-1 ring-gray-200 hover:ring-brand-400"
      >
        {/* A missing URL is the visible symptom of storage signing being unavailable —
            the row exists, the file exists, the link does not. Showing a placeholder
            rather than a broken image keeps that distinguishable from a failed upload. */}
        {attachment.url && !attachment.is_video ? (
          <img
            src={attachment.url}
            // Empty: the enclosing button is already labelled "View <file name>", and
            // repeating it here makes a screen reader say the name twice.
            alt=""
            className="size-full object-cover"
          />
        ) : (
          <span className="flex size-full items-center justify-center text-xl text-gray-400">
            {attachment.is_video ? "▶" : attachment.url ? "🖼" : "⚠"}
          </span>
        )}
      </button>

      {!readOnly && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${attachment.file_name}`}
          className="absolute -top-1.5 -right-1.5 hidden size-5 items-center justify-center rounded-full bg-gray-900 text-xs text-surface group-focus-within:flex group-hover:flex"
        >
          &#10005;
        </button>
      )}
    </div>
  );
}

function describe(error: unknown): string {
  if (error instanceof UploadFailedError) return error.message;
  if (error instanceof ApiError) {
    return error.isIntegrationUnavailable
      ? "File storage is not configured, so uploads are unavailable. The rest of the estimate is unaffected."
      : error.message;
  }
  return "The file could not be uploaded. Please try again.";
}
