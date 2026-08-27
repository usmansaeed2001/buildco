/**
 * The two closing forms on a project.
 *
 * Submitting the second one completes the work server-side, which may in turn close the
 * project — the whole chain runs through the rules engine rather than being asserted
 * here. The card says so before it happens, because "fill in this form" and "fill in
 * this form and the project closes" are different asks.
 *
 * Once submitted, a form is read-only in this card but still re-openable and
 * re-submittable: `PUT` replaces the stored document. That is deliberate — these get
 * signed on a phone in a driveway and a typo in a claim number should be fixable.
 */
import { useState } from "react";
import { ApiError } from "@/api/client";
import { useSubmitClosingForm, useUploadClosingFormPhoto } from "@/api/queries/closingForms";
import { UploadFailedError } from "@/api/queries/attachments";
import type { ProjectOut } from "@/api/types";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { Alert, Card } from "@/components/feedback";
import { useToast } from "@/components/Toast";
import { formatDate } from "@/lib/format";
import { ClosingFormDocument } from "./ClosingFormDocument";
import {
  FORMS,
  isComplete,
  isSubmitted,
  PHOTO_KEY,
  toWireData,
  type ClosingFormData,
  type FormNumber,
} from "./closingForms";

export function ClosingFormsCard({
  project,
  canSubmit,
}: {
  project: ProjectOut;
  canSubmit: boolean;
}) {
  const [open, setOpen] = useState<FormNumber | null>(null);

  const stored: Record<FormNumber, ClosingFormData | null> = {
    1: (project.closing_form_1 as ClosingFormData | null) ?? null,
    2: (project.closing_form_2 as ClosingFormData | null) ?? null,
  };

  const bothIn = isSubmitted(stored[1]) && isSubmitted(stored[2]);

  return (
    <Card className="flex flex-col gap-4 p-5">
      <h2 className="text-xs font-medium tracking-wide text-gray-500 uppercase">
        Closing forms
      </h2>

      <ul className="flex flex-col divide-y divide-gray-100">
        {([1, 2] as const).map((number) => {
          const submitted = isSubmitted(stored[number]);
          return (
            <li key={number} className="flex items-center gap-3 py-2">
              <span
                aria-hidden="true"
                className={
                  submitted
                    ? "flex size-5 shrink-0 items-center justify-center rounded-full bg-success-600 text-xs text-white"
                    : "size-5 shrink-0 rounded-full ring-1 ring-gray-300"
                }
              >
                {submitted ? "✓" : ""}
              </span>

              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900">{FORMS[number].title}</p>
                <p className="text-xs text-gray-500">
                  {submitted
                    ? `Submitted${
                        project.closing_form_submitted_at
                          ? ` ${formatDate(project.closing_form_submitted_at)}`
                          : ""
                      }`
                    : "Not submitted"}
                </p>
              </div>

              <Button size="sm" onClick={() => setOpen(number)}>
                {submitted ? "View" : canSubmit ? "Fill in" : "View"}
              </Button>
            </li>
          );
        })}
      </ul>

      {!bothIn && canSubmit && (
        <p className="text-xs text-gray-500">
          When both forms are in, the work is marked complete — which closes the project if
          every milestone is paid, or moves it to awaiting payment if any is not.
        </p>
      )}

      {open !== null && (
        <ClosingFormModal
          key={open}
          project={project}
          formNumber={open}
          stored={stored[open]}
          canSubmit={canSubmit}
          otherSubmitted={isSubmitted(stored[open === 1 ? 2 : 1])}
          onClose={() => setOpen(null)}
        />
      )}
    </Card>
  );
}

function ClosingFormModal({
  project,
  formNumber,
  stored,
  canSubmit,
  otherSubmitted,
  onClose,
}: {
  project: ProjectOut;
  formNumber: FormNumber;
  stored: ClosingFormData | null;
  canSubmit: boolean;
  /** Whether submitting this one will be the second, and so complete the work. */
  otherSubmitted: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const form = FORMS[formNumber];
  const submit = useSubmitClosingForm(project.id);
  const uploadPhoto = useUploadClosingFormPhoto(project.id);

  const [draft, setDraft] = useState<ClosingFormData>(() => ({ ...(stored ?? {}) }));
  const [editing, setEditing] = useState(!isSubmitted(stored) && canSubmit);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const readOnly = !editing;

  async function pickPhoto(file: File) {
    setFailure(null);
    // Shown immediately; replaced by nothing once stored, since the stored value is a
    // key rather than a URL and the project reload carries no signed link for it.
    setPhotoPreview(URL.createObjectURL(file));

    try {
      const path = await uploadPhoto.mutateAsync({ formNumber, file });
      setDraft((current) => ({ ...current, [PHOTO_KEY]: path }));
    } catch (caught) {
      setPhotoPreview(null);
      setFailure(
        caught instanceof UploadFailedError
          ? caught.message
          : caught instanceof ApiError && caught.isIntegrationUnavailable
            ? "File storage is not configured, so the photo cannot be attached. The rest of the form can still be submitted."
            : caught instanceof ApiError
              ? caught.message
              : "The photo could not be uploaded.",
      );
    }
  }

  async function send() {
    setFailure(null);
    try {
      await submit.mutateAsync({ formNumber, data: toWireData(form, draft) });
      toast.success(
        otherSubmitted
          ? "Both forms are in — the work is marked complete."
          : `${form.title} submitted.`,
      );
      onClose();
    } catch (caught) {
      setFailure(
        caught instanceof ApiError ? caught.message : "The form could not be submitted.",
      );
    }
  }

  const complete = isComplete(form, draft);

  return (
    <Modal
      open
      onClose={onClose}
      title={form.title}
      size="xl"
      footer={
        <>
          <Button onClick={onClose} disabled={submit.isPending}>
            Close
          </Button>
          <Button onClick={() => window.print()}>Print</Button>

          {readOnly && canSubmit && (
            <Button onClick={() => setEditing(true)}>Edit</Button>
          )}

          {editing && (
            <Button
              variant="primary"
              busy={submit.isPending}
              disabled={!complete}
              onClick={() => void send()}
            >
              Submit form
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {failure && <Alert tone="danger">{failure}</Alert>}

        {editing && otherSubmitted && (
          <Alert tone="warning">
            This is the second form. Submitting it marks the work complete, which closes the
            project if every milestone is paid.
          </Alert>
        )}

        {editing && !complete && (
          <p className="text-xs text-gray-500 print:hidden">
            A signature is required before this form can be submitted.
          </p>
        )}

        <div className="overflow-x-auto bg-gray-100 p-2 print:bg-white print:p-0">
          <ClosingFormDocument
            form={form}
            data={draft}
            readOnly={readOnly}
            photoUrl={photoPreview}
            uploading={uploadPhoto.isPending}
            onChange={(key, value) => setDraft((current) => ({ ...current, [key]: value }))}
            onPickPhoto={(file) => void pickPhoto(file)}
          />
        </div>
      </div>
    </Modal>
  );
}
