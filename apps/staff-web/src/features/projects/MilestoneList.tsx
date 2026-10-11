/**
 * Payment milestones.
 *
 * Paying the last outstanding one closes the project; un-paying any of them reopens it.
 * Both directions matter and both are the backend's decision, taken by the rules engine
 * after every change — the legacy code only ever moved a project forward, so a mistaken
 * "paid" click closed a project permanently with no way back.
 *
 * That is why the paid toggle is optimistic but the *status* is not: the checkbox flips
 * immediately, and the project's badge updates when the server says what it concluded.
 * Guessing the status here would mean two sources of truth for the most consequential
 * field on the screen.
 */
import { useState } from "react";
import { ApiError } from "@/api/client";
import {
  useCreateMilestone,
  useDeleteMilestone,
  useUpdateMilestone,
} from "@/api/queries/projects";
import type { MilestoneOut } from "@/api/types";
import { Button } from "@/components/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Card } from "@/components/feedback";
import { Field, Input } from "@/components/form";
import { useToast } from "@/components/Toast";
import { formatMoney, isNegativeMoney, toDecimal, toMoneyString, ZERO } from "@/domain/money";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/format";

export function MilestoneList({
  projectId,
  milestones,
  canManage,
  canDelete,
}: {
  projectId: string;
  milestones: MilestoneOut[];
  canManage: boolean;
  canDelete: boolean;
}) {
  const toast = useToast();
  const create = useCreateMilestone(projectId);
  const update = useUpdateMilestone(projectId);
  const remove = useDeleteMilestone(projectId);

  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [pendingDelete, setPendingDelete] = useState<MilestoneOut | null>(null);
  /** Ids whose paid state is mid-flight, so the row can show the new value at once. */
  const [flipping, setFlipping] = useState<ReadonlyMap<string, boolean>>(new Map());

  const total = milestones.reduce((sum, m) => sum.plus(toDecimal(m.amount)), ZERO);
  const paidTotal = milestones
    .filter((m) => shownPaid(m))
    .reduce((sum, m) => sum.plus(toDecimal(m.amount)), ZERO);

  function shownPaid(milestone: MilestoneOut): boolean {
    return flipping.get(milestone.id) ?? milestone.paid;
  }

  async function add() {
    if (!label.trim()) return;
    try {
      await create.mutateAsync({
        label: label.trim(),
        amount: toMoneyString(amount),
        ...(dueDate ? { due_date: dueDate } : {}),
        notes: "",
      });
      setLabel("");
      setAmount("");
      setDueDate("");
    } catch (caught) {
      toast.error(
        caught instanceof ApiError ? caught.message : "The milestone could not be added.",
      );
    }
  }

  async function togglePaid(milestone: MilestoneOut) {
    const next = !shownPaid(milestone);
    setFlipping((current) => new Map(current).set(milestone.id, next));

    try {
      await update.mutateAsync({ milestoneId: milestone.id, body: { paid: next } });
    } catch (caught) {
      toast.error(
        caught instanceof ApiError ? caught.message : "That payment could not be updated.",
      );
    } finally {
      // Either way, the refetched project is authoritative from here.
      setFlipping((current) => {
        const map = new Map(current);
        map.delete(milestone.id);
        return map;
      });
    }
  }

  async function confirmDelete() {
    const doomed = pendingDelete;
    setPendingDelete(null);
    if (!doomed) return;

    try {
      await remove.mutateAsync(doomed.id);
      toast.success("Milestone deleted.");
    } catch (caught) {
      toast.error(
        caught instanceof ApiError ? caught.message : "The milestone could not be deleted.",
      );
    }
  }

  const outstanding = milestones.filter((m) => !shownPaid(m)).length;

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-medium tracking-wide text-gray-500 uppercase">
          Payment milestones
        </h2>
        {milestones.length > 0 && (
          <span className="tnum text-sm text-gray-500">
            {formatMoney(paidTotal)} of {formatMoney(total)}
          </span>
        )}
      </div>

      {milestones.length === 0 ? (
        <p className="text-sm text-gray-500">
          No milestones scheduled. A project with none counts as fully paid, so it can close
          as soon as the work is complete.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-gray-100">
          {milestones.map((milestone) => {
            const paid = shownPaid(milestone);
            return (
              <li key={milestone.id} className="flex items-center gap-3 py-2">
                <input
                  type="checkbox"
                  checked={paid}
                  disabled={!canManage}
                  aria-label={`Mark ${milestone.label} as paid`}
                  onChange={() => void togglePaid(milestone)}
                  className="size-4 shrink-0 rounded border-gray-300 text-brand-600 dark:text-brand-300 focus:ring-brand-500"
                />

                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "truncate text-sm",
                      paid ? "text-gray-500 line-through" : "text-gray-900",
                    )}
                  >
                    {milestone.label}
                  </p>
                  <p className="text-xs text-gray-500">
                    {milestone.due_date ? `Due ${formatDate(milestone.due_date)}` : "No due date"}
                    {paid && milestone.paid_at && ` · Paid ${formatDate(milestone.paid_at)}`}
                  </p>
                </div>

                <span className="tnum shrink-0 text-sm font-medium text-gray-900">
                  {formatMoney(milestone.amount)}
                </span>

                {canDelete && (
                  <button
                    type="button"
                    aria-label={`Delete ${milestone.label}`}
                    onClick={() => setPendingDelete(milestone)}
                    className="shrink-0 rounded p-1 text-xs text-gray-400 hover:bg-danger-50 hover:text-danger-600 hover:dark:text-danger-400"
                  >
                    &#10005;
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {milestones.length > 0 && (
        <p className="text-xs text-gray-500">
          {outstanding === 0
            ? "All paid. The project closes once the work is complete."
            : `${outstanding} ${outstanding === 1 ? "milestone" : "milestones"} outstanding.`}
        </p>
      )}

      {canManage && (
        <div className="grid gap-3 border-t border-gray-100 pt-4 app-sm:grid-cols-[1fr_auto_auto_auto] app-sm:items-end">
          <Field label="New milestone">
            {(props) => (
              <Input
                {...props}
                value={label}
                placeholder="Deposit"
                onChange={(event) => setLabel(event.target.value)}
              />
            )}
          </Field>
          <Field
            label="Amount"
            {...(isNegativeMoney(amount) ? { error: "Cannot be negative." } : {})}
          >
            {(props) => (
              <Input
                {...props}
                inputMode="decimal"
                className="tnum w-32 text-right"
                value={amount}
                placeholder="0.00"
                onChange={(event) => setAmount(event.target.value)}
              />
            )}
          </Field>
          <Field label="Due">
            {(props) => (
              <Input
                {...props}
                type="date"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
              />
            )}
          </Field>
          <Button
            variant="secondary"
            busy={create.isPending}
            disabled={!label.trim() || isNegativeMoney(amount)}
            onClick={() => void add()}
          >
            Add
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this milestone?"
        confirmLabel="Delete"
        busy={remove.isPending}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
      >
        <p>
          <strong>{pendingDelete?.label}</strong> ({formatMoney(pendingDelete?.amount ?? 0)}) will
          be removed. This may change the project&rsquo;s status.
        </p>
      </ConfirmDialog>
    </Card>
  );
}
