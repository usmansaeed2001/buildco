/**
 * Closing-form submission and its photo upload.
 *
 * `PUT` rather than `POST`: submitting is idempotent and replaces the stored document,
 * so a form can be corrected and re-submitted rather than accumulating versions.
 *
 * The photo follows the same three-step signed-upload dance as line-item attachments,
 * with one difference that matters: the returned `storage_path` must be written into
 * the form's `material_photo_path` field, and the API validates that the key sits under
 * *this project's* own prefix before storing the form. A path from another project is
 * rejected outright.
 *
 * The legacy app stored the photo as a base64 data URI inside the `closing_form_1`
 * JSONB column, which bloated every project-detail read for every project. Only the key
 * is stored now.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../client";
import { queryKeys } from "./keys";
import { UploadFailedError } from "./attachments";
import type { ProjectOut, UploadUrlOut } from "../types";
import type { ClosingFormData, FormNumber } from "@/features/projects/closingForms";

export function useSubmitClosingForm(projectId: string) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ formNumber, data }: { formNumber: FormNumber; data: ClosingFormData }) =>
      apiFetch<ProjectOut>(`/projects/${projectId}/closing-forms/${formNumber}`, {
        method: "PUT",
        body: { data },
      }),
    onSuccess: () => {
      // Submitting the second form completes the work, which may in turn close the
      // project — so the whole detail response is stale, not just the form.
      void client.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
      void client.invalidateQueries({ queryKey: queryKeys.projects.all });
    },
  });
}

/** Uploads the photo and resolves to the `storage_path` to store on the form. */
export function useUploadClosingFormPhoto(projectId: string) {
  return useMutation({
    mutationFn: async ({ formNumber, file }: { formNumber: FormNumber; file: File }) => {
      const ticket = await apiFetch<UploadUrlOut>(
        `/projects/${projectId}/closing-forms/${formNumber}/photo-upload-url`,
        {
          method: "POST",
          body: {
            file_name: file.name,
            content_type: file.type || "application/octet-stream",
          },
        },
      );

      // Straight to Cloud Storage. No Authorization header — it would break the V4
      // signature and leak a credential to a third party.
      const response = await fetch(ticket.upload_url, {
        method: "PUT",
        headers: ticket.required_headers,
        body: file,
      });
      if (!response.ok) throw new UploadFailedError(response.status);

      return ticket.storage_path;
    },
  });
}
