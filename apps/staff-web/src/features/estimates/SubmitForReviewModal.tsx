/**
 * Sending an estimate to an external reviewer.
 *
 * The server mints a single-use token and emails a link; this only collects who it goes
 * to. Two things worth knowing before changing it:
 *
 * - Submitting is **not** reversible from here. It freezes the estimate behind a live
 *   approval link, and undoing it means Recall, which invalidates the reviewer's link
 *   and is a separate deliberate act. The copy says so.
 * - A second submission while one is outstanding is a 409, not a silent replacement.
 *   The legacy backend minted a fresh token and orphaned the first reviewer's link
 *   without telling anyone.
 */
import { useState } from "react";
import { ApiError } from "@/api/client";
import { useSubmitForReview } from "@/api/queries/estimates";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { Alert } from "@/components/feedback";
import { TextField } from "@/components/form";
import { useToast } from "@/components/Toast";
import { formatMoney } from "@/domain/money";
import type { Decimal } from "decimal.js";

export function SubmitForReviewModal({
  open,
  estimateId,
  projectName,
  total,
  onClose,
}: {
  open: boolean;
  estimateId: string;
  projectName: string;
  total: Decimal;
  onClose: () => void;
}) {
  const toast = useToast();
  const submit = useSubmitForReview(estimateId);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  function close() {
    setFailure(null);
    onClose();
  }

  async function send() {
    setFailure(null);
    try {
      await submit.mutateAsync({
        recipient_email: email.trim(),
        ...(name.trim() ? { recipient_name: name.trim() } : {}),
      });
      toast.success(`Sent to ${email.trim()} for review.`);
      setEmail("");
      setName("");
      onClose();
    } catch (caught) {
      // Kept in the modal rather than a toast: the reviewer's address is still on
      // screen and usually needs correcting, which a toast that vanishes cannot help
      // with.
      setFailure(
        caught instanceof ApiError
          ? caught.message
          : "The estimate could not be sent. Please try again.",
      );
    }
  }

  // Deliberately loose. The API validates the address properly (`EmailStr`); this only
  // stops the obviously-empty submission, because a stricter regex here would reject
  // valid addresses the server accepts.
  const looksLikeEmail = /.+@.+\..+/.test(email.trim());

  return (
    <Modal
      open={open}
      onClose={close}
      title="Send for approval"
      description="The reviewer gets a link to a page where they can approve, reject, or request changes."
      footer={
        <>
          <Button onClick={close} disabled={submit.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={submit.isPending}
            disabled={!looksLikeEmail}
            onClick={() => void send()}
          >
            Send for approval
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-gray-600">
          <span className="font-medium text-gray-900">{projectName}</span> —{" "}
          <span className="tnum">{formatMoney(total)}</span>
        </p>

        {failure && <Alert tone="danger">{failure}</Alert>}

        <TextField
          label="Reviewer email"
          type="email"
          required
          autoComplete="email"
          value={email}
          placeholder="adjuster@carrier.com"
          onChange={(event) => setEmail(event.target.value)}
        />

        <TextField
          label="Reviewer name"
          hint="Optional. Used to address the email."
          value={name}
          placeholder="Alex Adjuster"
          onChange={(event) => setName(event.target.value)}
        />

        <Alert tone="info">
          The estimate moves to <strong>Submitted</strong> while it awaits a decision. To edit
          it again you will need to recall it, which invalidates the reviewer&rsquo;s link.
        </Alert>
      </div>
    </Modal>
  );
}
