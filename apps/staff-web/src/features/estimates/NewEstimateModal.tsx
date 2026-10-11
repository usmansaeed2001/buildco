/**
 * Naming an estimate before it exists.
 *
 * "New estimate" used to post an empty body and jump straight to the editor, so nothing
 * ever named the record. Every row on the list then read the same — not *unnamed*, but
 * literally all called "New Estimate", which is a wall of identical tiles you cannot
 * navigate by.
 *
 * Asking for one field up front is the whole fix. Client name and claim ID are here
 * because they cost nothing while the dialog is already open, and because a claim ID
 * typed now is one nobody has to remember to add later.
 */
import { useState } from "react";
import { ApiError } from "@/api/client";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { Alert } from "@/components/feedback";
import { TextField } from "@/components/form";

export interface NewEstimateValues {
  project_name: string;
  client_name: string;
  identifier?: string;
}

export function NewEstimateModal({
  open,
  busy,
  initial,
  staged = false,
  onClose,
  onCreate,
}: {
  open: boolean;
  busy: boolean;
  /**
   * Values to open the form with. Read once, when the form mounts: give the form a
   * `key` to seed it again. Used to show what the assistant proposes, and to hand that
   * proposal over as an ordinary editable form.
   */
  initial?: Partial<NewEstimateValues>;
  /** Shown by the assistant as what it proposes: read-only, see `Modal`. */
  staged?: boolean;
  onClose: () => void;
  onCreate: (values: NewEstimateValues) => Promise<void>;
}) {
  const [projectName, setProjectName] = useState(initial?.project_name ?? "");
  const [clientName, setClientName] = useState(initial?.client_name ?? "");
  const [identifier, setIdentifier] = useState(initial?.identifier ?? "");
  const [failure, setFailure] = useState<string | null>(null);

  function close() {
    setFailure(null);
    onClose();
  }

  async function submit() {
    setFailure(null);
    try {
      await onCreate({
        project_name: projectName.trim(),
        client_name: clientName.trim(),
        // Omitted rather than sent blank, so the server generates one. Sending "" would
        // be rejected as a blank claim ID rather than read as "you pick".
        ...(identifier.trim() ? { identifier: identifier.trim() } : {}),
      });
      setProjectName("");
      setClientName("");
      setIdentifier("");
    } catch (caught) {
      // Kept in the dialog rather than a toast: the likeliest failure is a claim ID
      // already in use, and the fix is to edit the field that is still on screen.
      setFailure(
        caught instanceof ApiError
          ? caught.message
          : "The estimate could not be created. Please try again.",
      );
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      staged={staged}
      title="New estimate"
      description="Give it a name now so you can find it later."
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!projectName.trim()}
            onClick={() => void submit()}
          >
            Create
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (projectName.trim() && !busy) void submit();
        }}
      >
        {failure && <Alert tone="danger">{failure}</Alert>}

        <TextField
          label="Project name"
          required
          // The one field that has to be filled, so it takes focus. Nothing else in the
          // estimates feature autofocuses anything, which is part of why the old flow
          // dropped you into an editor with no idea what to type first.
          autoFocus
          value={projectName}
          placeholder="11196 Schuyler Ave"
          onChange={(event) => setProjectName(event.target.value)}
        />

        <TextField
          label="Client name"
          value={clientName}
          placeholder="Acme Insurance"
          onChange={(event) => setClientName(event.target.value)}
        />

        <TextField
          label="Claim ID"
          hint="Optional. Leave blank and one is generated."
          value={identifier}
          placeholder="0833781057"
          onChange={(event) => setIdentifier(event.target.value)}
        />

        {/* Submits on Enter from any field. The button above is the visible affordance;
            this is for anyone who types a name and hits return without looking down. */}
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
