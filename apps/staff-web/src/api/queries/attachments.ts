/**
 * Line-item attachments: photos and video.
 *
 * Uploads are a three-step dance and the middle step does **not** go through
 * `apiFetch`:
 *
 *   1. `POST /estimates/{id}/attachments/upload-url` — the API mints a V4 signed PUT
 *   2. `PUT <signed url>` — the browser sends the bytes straight to Cloud Storage
 *   3. `POST /estimates/{id}/attachments` — the API records the row
 *
 * Step 2 is a bare `fetch`. Sending an `Authorization` header there would break the
 * signature, and the signed URL is not on our origin — it is a Google one. It also
 * means file bytes never pass through Cloud Run, which is the whole point of the
 * scheme.
 *
 * The `Content-Type` is baked into the signature, so the PUT must send exactly the
 * header the API returned in `required_headers`. Guessing it, or letting the browser
 * pick, produces a 403 from Google that says nothing about why.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "./keys";
import type { AttachmentOut, UploadUrlOut } from "../types";

export function useAttachments(estimateId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.estimates.attachments(estimateId ?? ""),
    // Each row carries a freshly signed download URL with a limited TTL, so a long-open
    // editor must not serve a cached list whose links have since expired.
    queryFn: () => apiFetch<AttachmentOut[]>(`/estimates/${estimateId}/attachments`),
    enabled: Boolean(estimateId),
    staleTime: 60_000,
  });
}

export interface UploadTarget {
  roomIndex: number;
  itemIndex: number;
  file: File;
}

/** Raised when the direct-to-storage PUT fails, which `ApiError` cannot describe —
 *  the response comes from Google, not from our API, and carries no error envelope. */
export class UploadFailedError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(
      status === 403
        ? "The upload link was rejected. It may have expired — try again."
        : `The file could not be uploaded (HTTP ${status}).`,
    );
    this.name = "UploadFailedError";
    this.status = status;
  }
}

export function useUploadAttachment(estimateId: string) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: async ({ roomIndex, itemIndex, file }: UploadTarget) => {
      const ticket = await apiFetch<UploadUrlOut>(
        `/estimates/${estimateId}/attachments/upload-url`,
        {
          method: "POST",
          body: {
            file_name: file.name,
            // A file dragged from some sources has an empty `type`. The API requires a
            // non-empty content type, and an octet-stream that round-trips is better
            // than a 422 the user cannot act on.
            content_type: file.type || "application/octet-stream",
            room_index: roomIndex,
            item_index: itemIndex,
          },
        },
      );

      const response = await fetch(ticket.upload_url, {
        method: "PUT",
        headers: ticket.required_headers,
        body: file,
      });
      if (!response.ok) throw new UploadFailedError(response.status);

      return apiFetch<AttachmentOut>(`/estimates/${estimateId}/attachments`, {
        method: "POST",
        body: {
          storage_path: ticket.storage_path,
          file_name: file.name,
          content_type: file.type || "application/octet-stream",
          room_index: roomIndex,
          item_index: itemIndex,
        },
      });
    },
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: queryKeys.estimates.attachments(estimateId),
      });
    },
  });
}

export function useDeleteAttachment(estimateId: string) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (attachmentId: string) =>
      apiFetch<void>(`/attachments/${attachmentId}`, { method: "DELETE" }),
    onSuccess: () => {
      void client.invalidateQueries({
        queryKey: queryKeys.estimates.attachments(estimateId),
      });
    },
  });
}
