/**
 * What the job costs and what has been collected.
 *
 * Every figure here is a `Decimal` arriving as a string. Nothing in this file calls
 * `Number()` — the whole reason the money columns became `NUMERIC(12,2)` is that the
 * legacy app added them as floats, in the browser and in the emailed total
 * independently, and the two disagreed.
 *
 * The four editable figures autosave on blur rather than on every keystroke: they are
 * a `PATCH` each, and a debounce on a number someone is mid-way through typing sends
 * "12" on the way to "1200".
 */
import { useEffect, useState } from "react";
import { Decimal } from "decimal.js";
import { ApiError } from "@/api/client";
import { useUpdateProject } from "@/api/queries/projects";
import type { ProjectOut } from "@/api/types";
import { Card } from "@/components/feedback";
import { Field, Input } from "@/components/form";
import { useToast } from "@/components/Toast";
import {
  formatMoney,
  isNegativeMoney,
  percentOf,
  toDecimal,
  toMoneyString,
} from "@/domain/money";
import { cn } from "@/lib/cn";

/** The four figures a person types. `total_budget` is edited in the details card. */
const EDITABLE = [
  { field: "labor_cost", label: "Labor" },
  { field: "materials_cost", label: "Materials" },
  { field: "reimbursements", label: "Reimbursements" },
  { field: "amount_collected", label: "Collected" },
] as const;

type EditableField = (typeof EDITABLE)[number]["field"];

export function BudgetSummary({
  project,
  supplementsTotal,
  readOnly,
}: {
  project: ProjectOut;
  /** Rollup of the linked supplements, which are revenue on top of the base budget. */
  supplementsTotal: Decimal;
  readOnly: boolean;
}) {
  const toast = useToast();
  const update = useUpdateProject(project.id);

  const [draft, setDraft] = useState<Record<EditableField, string>>(() => ({
    labor_cost: project.labor_cost,
    materials_cost: project.materials_cost,
    reimbursements: project.reimbursements,
    amount_collected: project.amount_collected,
  }));

  // Re-seed when the server's copy changes — after a save, or if someone else edited it.
  useEffect(() => {
    setDraft({
      labor_cost: project.labor_cost,
      materials_cost: project.materials_cost,
      reimbursements: project.reimbursements,
      amount_collected: project.amount_collected,
    });
  }, [
    project.labor_cost,
    project.materials_cost,
    project.reimbursements,
    project.amount_collected,
  ]);

  async function commit(field: EditableField) {
    // Every money field is `Field(ge=0)` server-side. Catching it here means the field
    // can say what is wrong, rather than surfacing a generic validation envelope.
    if (isNegativeMoney(draft[field])) {
      setDraft((current) => ({ ...current, [field]: project[field] }));
      toast.error("That figure cannot be negative.");
      return;
    }

    const next = toMoneyString(draft[field]);
    if (next === toMoneyString(project[field])) return;

    try {
      await update.mutateAsync({ [field]: next });
    } catch (caught) {
      setDraft((current) => ({ ...current, [field]: project[field] }));
      toast.error(caught instanceof ApiError ? caught.message : "That figure could not be saved.");
    }
  }

  const budget = toDecimal(project.total_budget);
  const labor = toDecimal(draft.labor_cost);
  const materials = toDecimal(draft.materials_cost);
  const reimbursements = toDecimal(draft.reimbursements);
  const collected = toDecimal(draft.amount_collected);

  const totalCost = labor.plus(materials).plus(reimbursements);
  const revenue = budget.plus(supplementsTotal);
  const outstanding = revenue.minus(collected);
  const profit = collected.minus(totalCost);
  const overBudget = totalCost.greaterThan(revenue);

  return (
    <Card className="flex flex-col gap-4 p-5">
      <h2 className="text-xs font-medium tracking-wide text-gray-500 uppercase">Budget</h2>

      <div className="flex flex-col gap-2 text-sm">
        <Line label="Base budget" value={formatMoney(budget)} />
        {!supplementsTotal.isZero() && (
          <Line label="Linked supplements" value={formatMoney(supplementsTotal)} />
        )}
        <Line label="Total revenue" value={formatMoney(revenue)} strong />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {EDITABLE.map(({ field, label }) => (
          <Field key={field} label={label}>
            {(props) => (
              <Input
                {...props}
                inputMode="decimal"
                className="tnum text-right"
                disabled={readOnly}
                value={draft[field]}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, [field]: event.target.value }))
                }
                onFocus={(event) => event.target.select()}
                onBlur={() => void commit(field)}
              />
            )}
          </Field>
        ))}
      </div>

      <div className="flex flex-col gap-2 border-t border-gray-100 pt-3 text-sm">
        <Line
          label="Total cost"
          value={formatMoney(totalCost)}
          tone={overBudget ? "danger" : undefined}
        />
        <Line
          label={outstanding.isNegative() ? "Overpaid" : "Outstanding"}
          value={formatMoney(outstanding.abs())}
          tone={outstanding.isNegative() ? "success" : undefined}
        />
        <Line
          label={profit.isNegative() ? "Loss" : "Profit"}
          value={formatMoney(profit.abs())}
          strong
          tone={profit.isNegative() ? "danger" : "success"}
        />
      </div>

      {revenue.isZero() ? (
        <p className="text-xs text-gray-400">No budget set, so nothing to track against.</p>
      ) : (
        <div>
          <div className="h-2 overflow-hidden rounded-full bg-gray-100">
            <div
              className="h-full rounded-full bg-brand-500"
              style={{ width: `${percentOf(collected, revenue)}%` }}
              role="presentation"
            />
          </div>
          <p className="mt-1 tnum text-xs text-gray-500">
            {Math.round(percentOf(collected, revenue))}% collected
          </p>
        </div>
      )}

      {overBudget && (
        <p className="text-xs text-danger-600">
          Costs exceed revenue by {formatMoney(totalCost.minus(revenue))}.
        </p>
      )}
    </Card>
  );
}

function Line({
  label,
  value,
  strong,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: "danger" | "success" | undefined;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-gray-500">{label}</span>
      <span
        className={cn(
          "tnum",
          strong && "font-semibold",
          tone === "danger" && "text-danger-600",
          tone === "success" && "text-success-700",
          !tone && "text-gray-900",
        )}
      >
        {value}
      </span>
    </div>
  );
}
