/**
 * Status actions for an estimate.
 *
 * Which buttons exist is decided by `domain/estimateRules.availableTransitions`, a port
 * of the backend's own `TRANSITIONS` table — so the toolbar cannot offer an action the
 * API would refuse. The legacy `renderEdActions` re-derived the same matrix inline with
 * a chain of `if (status === ...)` and disagreed with the server in both directions:
 * it hid Approve from admins and showed Lock to members.
 *
 * This gates affordances only. Every one of these is re-decided server-side.
 */
import { Button } from "@/components/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useState } from "react";
import {
  availableTransitions,
  canBeSubmitted,
  canSoftDelete,
  canSubmitForReview,
} from "@/domain/estimateRules";
import type { ActorSnapshot, EstimateSnapshot, TransitionAction } from "@/domain/estimateRules";

export function EstimateToolbar({
  actor,
  snapshot,
  busyAction,
  onTransition,
  onDelete,
  onExportCsv,
  onGenerateReport,
  onParseNotes,
  onSubmitForReview,
}: {
  actor: ActorSnapshot;
  snapshot: EstimateSnapshot;
  /** The action currently in flight, so only its own button shows a spinner. */
  busyAction: TransitionAction | "delete" | null;
  onTransition: (action: TransitionAction) => void;
  onDelete: () => void;
  onExportCsv: () => void;
  onGenerateReport: () => void;
  /** Absent on a read-only estimate: parsing writes into the document. */
  onParseNotes?: () => void;
  onSubmitForReview: () => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const transitions = availableTransitions(actor, snapshot);

  // Two separate questions, both mirrored from the backend: may this person submit, and
  // may an estimate in this status be submitted at all. `submitted` is excluded by the
  // second — resubmitting while a decision is outstanding is a 409, deliberately, so
  // that a second token cannot silently orphan the first reviewer's link.
  const canSubmit =
    !snapshot.isTrashed && canSubmitForReview(actor, snapshot) && canBeSubmitted(snapshot);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canSubmit && (
        <Button size="sm" variant="primary" onClick={onSubmitForReview}>
          Send for approval
        </Button>
      )}

      {onParseNotes && (
        <Button size="sm" onClick={onParseNotes}>
          Parse notes
        </Button>
      )}

      <Button size="sm" onClick={onGenerateReport}>
        Report
      </Button>

      <Button size="sm" onClick={onExportCsv}>
        Export CSV
      </Button>

      {transitions.map((transition) => (
        <Button
          key={transition.action}
          size="sm"
          variant={transition.action === "admin_approve" ? "success" : "secondary"}
          title={transition.description}
          busy={busyAction === transition.action}
          disabled={busyAction !== null && busyAction !== transition.action}
          onClick={() => onTransition(transition.action)}
        >
          {transition.label}
        </Button>
      ))}

      {canSoftDelete(actor, snapshot) && !snapshot.isTrashed && (
        <Button
          size="sm"
          variant="ghost"
          className="text-danger-600 hover:bg-danger-50"
          onClick={() => setConfirmingDelete(true)}
        >
          Delete
        </Button>
      )}

      <ConfirmDialog
        open={confirmingDelete}
        title="Move this estimate to the trash?"
        confirmLabel="Move to trash"
        busy={busyAction === "delete"}
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() => {
          setConfirmingDelete(false);
          onDelete();
        }}
      >
        <p>
          It leaves the active list but is not destroyed — an owner or admin can restore it
          from the trash.
        </p>
      </ConfirmDialog>
    </div>
  );
}
