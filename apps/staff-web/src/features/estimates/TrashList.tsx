/**
 * Soft-deleted estimates.
 *
 * Two actions, deliberately asymmetric: restore is one click, permanent deletion asks
 * first and is elevated-only. `canRestore` and `canPermanentlyDelete` both reduce to
 * "elevated", but they are called separately so this reads the same way the backend's
 * rules do.
 */
import { useState } from "react";
import { ApiError } from "@/api/client";
import { useDeleteEstimatePermanently, useRestoreEstimate } from "@/api/queries/estimates";
import type { EstimateOut } from "@/api/types";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/feedback";
import { useToast } from "@/components/Toast";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { canPermanentlyDelete, canRestore, type ActorSnapshot } from "@/domain/estimateRules";
import { formatMoney } from "@/domain/money";
import { daysLeftInTrash, formatDate } from "@/lib/format";

export function TrashList({
  estimates,
  actor,
}: {
  estimates: EstimateOut[];
  actor: ActorSnapshot | null;
}) {
  const restore = useRestoreEstimate();
  const destroy = useDeleteEstimatePermanently();
  const toast = useToast();
  const [confirming, setConfirming] = useState<EstimateOut | null>(null);

  if (estimates.length === 0) {
    return (
      <EmptyState
        title="The trash is empty"
        description="Deleted estimates appear here and can be restored."
      />
    );
  }

  const mayRestore = actor ? canRestore(actor) : false;
  const mayDestroy = actor ? canPermanentlyDelete(actor) : false;

  async function handleRestore(estimate: EstimateOut) {
    try {
      await restore.mutateAsync(estimate.id);
      toast.success(`Restored ${estimate.identifier}.`);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : "Could not restore it.");
    }
  }

  async function handleDestroy() {
    if (!confirming) return;
    const target = confirming;
    setConfirming(null);
    try {
      await destroy.mutateAsync(target.id);
      toast.success(`Deleted ${target.identifier} permanently.`);
    } catch (caught) {
      toast.error(caught instanceof ApiError ? caught.message : "Could not delete it.");
    }
  }

  return (
    <>
      <ul className="divide-y divide-gray-100 overflow-hidden rounded-card bg-surface ring-1 ring-gray-200">
        {estimates.map((estimate) => {
          const daysLeft = daysLeftInTrash(estimate.deleted_at);
          return (
            <li key={estimate.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-gray-900">{estimate.project_name}</p>
                <p className="truncate text-xs text-gray-500">
                  <span className="font-mono">{estimate.identifier}</span> · deleted{" "}
                  {formatDate(estimate.deleted_at)}
                  {daysLeft !== null && ` · ${daysLeft} ${daysLeft === 1 ? "day" : "days"} left`}
                </p>
              </div>

              <p className="tnum text-sm font-medium text-gray-900">
                {formatMoney(estimate.totals?.total ?? "0")}
              </p>

              <div className="flex gap-2">
                <Button size="sm" disabled={!mayRestore} onClick={() => handleRestore(estimate)}>
                  Restore
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={!mayDestroy}
                  onClick={() => setConfirming(estimate)}
                >
                  Delete
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={confirming !== null}
        title="Delete permanently?"
        confirmLabel="Delete permanently"
        tone="danger"
        busy={destroy.isPending}
        onCancel={() => setConfirming(null)}
        onConfirm={handleDestroy}
      >
        <p>
          <strong>{confirming?.project_name}</strong> ({confirming?.identifier}) and its attachments
          will be removed for good. This cannot be undone.
        </p>
      </ConfirmDialog>
    </>
  );
}
