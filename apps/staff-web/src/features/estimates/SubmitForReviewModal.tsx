/**
 * Sending an estimate to the team's reviewer.
 *
 * **The recipient is no longer typed here.** It is the single user an admin chooses in
 * Settings, resolved server-side — `SubmitForReviewRequest` does not carry an address at
 * all. The typed field it replaced was a silent delivery failure waiting to happen: a
 * mistyped address means no send is ever attempted, so nothing appears in the mail
 * provider's dashboard to explain the estimate nobody reviewed.
 *
 * So this is a confirmation, not a form. Two things worth knowing before changing it:
 *
 * - Submitting is **not** reversible from here. It freezes the estimate behind a live
 *   approval link, and undoing it means Recall, which invalidates the reviewer's link
 *   and is a separate deliberate act. The copy says so.
 * - A second submission while one is outstanding is a 409, not a silent replacement.
 *   The legacy backend minted a fresh token and orphaned the first reviewer's link
 *   without telling anyone.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "@/api/client";
import { useSubmitForReview } from "@/api/queries/estimates";
import { useTeamSettings } from "@/api/queries/settings";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { Alert } from "@/components/feedback";
import { useToast } from "@/components/Toast";
import { formatMoney } from "@/domain/money";
import { displayName } from "@/lib/format";
import type { Decimal } from "decimal.js";

export function SubmitForReviewModal({
  open,
  estimateId,
  projectName,
  total,
  staged = false,
  onClose,
}: {
  open: boolean;
  estimateId: string;
  projectName: string;
  total: Decimal;
  /** Shown by the assistant as what it proposes: read-only, see `Modal`. */
  staged?: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const submit = useSubmitForReview(estimateId);
  const settings = useTeamSettings();
  const [failure, setFailure] = useState<string | null>(null);

  const reviewer = settings.data?.default_reviewer ?? null;

  function close() {
    setFailure(null);
    onClose();
  }

  async function send() {
    setFailure(null);
    try {
      await submit.mutateAsync({});
      toast.success(reviewer ? `Sent to ${displayName(reviewer)} for review.` : "Sent for review.");
      onClose();
    } catch (caught) {
      // Kept in the modal rather than a toast. The likeliest failure now is "no reviewer
      // configured", whose fix is a link the reader needs time to read and follow — a
      // toast that vanishes cannot carry that.
      setFailure(
        caught instanceof ApiError
          ? caught.message
          : "The estimate could not be sent. Please try again.",
      );
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      staged={staged}
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
            // Disabled while settings load, and while there is nobody to send to. The
            // server refuses either way; this just avoids offering a button that cannot
            // work.
            disabled={settings.isPending || !reviewer}
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

        {reviewer ? (
          <div className="rounded-md bg-gray-50 px-3 py-2.5 ring-1 ring-gray-200">
            <p className="text-xs font-medium tracking-wide text-gray-500 uppercase">Reviewer</p>
            <p className="mt-1 text-sm font-medium text-gray-900">{displayName(reviewer)}</p>
            <p className="truncate text-sm text-gray-500">{reviewer.email}</p>
          </div>
        ) : (
          !settings.isPending && (
            <Alert tone="warning">
              No reviewer is set up yet, so there is nobody to send this to. An owner or admin
              can choose one in <Link to="/settings" className="underline">Settings</Link>.
            </Alert>
          )
        )}

        <Alert tone="info">
          The estimate moves to <strong>Submitted</strong> while it awaits a decision. To edit it
          again you will need to recall it, which invalidates the reviewer&rsquo;s link.
        </Alert>
      </div>
    </Modal>
  );
}
