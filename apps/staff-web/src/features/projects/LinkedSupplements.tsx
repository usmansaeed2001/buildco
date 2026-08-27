/**
 * Estimates attached to a project.
 *
 * The link is a join row, so unlinking removes the association and never the estimate —
 * the copy says so, because "Remove" next to a document usually means the document.
 *
 * Linking the same estimate twice is a 409 from the unique constraint, not a silent
 * no-op. The picker already excludes what is linked, so a conflict here means someone
 * else linked it first; the message says that rather than showing a raw error.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "@/api/client";
import { useEstimates } from "@/api/queries/estimates";
import { useLinkSupplement, useUnlinkSupplement } from "@/api/queries/projects";
import type { SupplementLinkOut } from "@/api/types";
import { Button } from "@/components/Button";
import { EstimateStatusBadge } from "@/components/Badge";
import { Card } from "@/components/feedback";
import { Field, Select } from "@/components/form";
import { useToast } from "@/components/Toast";
import type { EstimateStatus } from "@/domain/enums";
import { formatMoney, toDecimal, ZERO } from "@/domain/money";

export function LinkedSupplements({
  projectId,
  supplements,
  canManage,
}: {
  projectId: string;
  supplements: SupplementLinkOut[];
  canManage: boolean;
}) {
  const toast = useToast();
  const link = useLinkSupplement(projectId);
  const unlink = useUnlinkSupplement(projectId);
  const [choice, setChoice] = useState("");

  // Only fetched when someone can act on it — a member with read-only access has no
  // use for a list of estimates they cannot link.
  const { data: estimates } = useEstimates({ trash: false, ...(canManage ? {} : { limit: 0 }) });

  const linkedIds = useMemo(
    () => new Set(supplements.map((supplement) => supplement.estimate_id)),
    [supplements],
  );

  const available = useMemo(
    () => (estimates?.items ?? []).filter((estimate) => !linkedIds.has(estimate.id)),
    [estimates?.items, linkedIds],
  );

  const total = supplements.reduce(
    (sum, supplement) => sum.plus(toDecimal(supplement.estimate?.total)),
    ZERO,
  );

  async function add() {
    if (!choice) return;
    try {
      await link.mutateAsync(choice);
      setChoice("");
    } catch (caught) {
      toast.error(
        caught instanceof ApiError && caught.isConflict
          ? "That estimate is already linked to this project."
          : caught instanceof ApiError
            ? caught.message
            : "The estimate could not be linked.",
      );
    }
  }

  async function remove(estimateId: string) {
    try {
      await unlink.mutateAsync(estimateId);
    } catch (caught) {
      toast.error(
        caught instanceof ApiError ? caught.message : "The estimate could not be unlinked.",
      );
    }
  }

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-medium tracking-wide text-gray-500 uppercase">
          Linked supplements
        </h2>
        {supplements.length > 0 && (
          <span className="tnum text-sm font-medium text-gray-900">{formatMoney(total)}</span>
        )}
      </div>

      {supplements.length === 0 ? (
        <p className="text-sm text-gray-500">No supplements linked to this project.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-gray-100">
          {supplements.map((supplement) => (
            <li key={supplement.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <Link
                  to={`/estimates/${supplement.estimate_id}`}
                  className="block truncate text-sm font-medium text-gray-900 hover:text-brand-700 hover:underline"
                >
                  {supplement.estimate?.project_name ?? "Estimate"}
                </Link>
                <p className="flex items-center gap-2 text-xs text-gray-500">
                  <span className="font-mono">{supplement.estimate?.identifier}</span>
                  {supplement.estimate && (
                    <EstimateStatusBadge status={supplement.estimate.status as EstimateStatus} />
                  )}
                </p>
              </div>

              <span className="tnum shrink-0 text-sm text-gray-900">
                {formatMoney(supplement.estimate?.total ?? 0)}
              </span>

              {canManage && (
                <button
                  type="button"
                  aria-label={`Unlink ${supplement.estimate?.identifier ?? "estimate"}`}
                  onClick={() => void remove(supplement.estimate_id)}
                  className="shrink-0 rounded p-1 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                >
                  &#10005;
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <div className="flex items-end gap-2 border-t border-gray-100 pt-4">
          <div className="flex-1">
            <Field label="Link an estimate">
              {(props) => (
                <Select
                  {...props}
                  value={choice}
                  onChange={(event) => setChoice(event.target.value)}
                >
                  <option value="">Choose an estimate…</option>
                  {available.map((estimate) => (
                    <option key={estimate.id} value={estimate.id}>
                      {estimate.identifier} — {estimate.project_name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <Button busy={link.isPending} disabled={!choice} onClick={() => void add()}>
            Link
          </Button>
        </div>
      )}

      {canManage && available.length === 0 && supplements.length > 0 && (
        <p className="text-xs text-gray-500">Every estimate is already linked to this project.</p>
      )}
    </Card>
  );
}
