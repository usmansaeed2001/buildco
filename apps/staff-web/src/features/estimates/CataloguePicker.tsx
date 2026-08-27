/**
 * Add a priced line from the team's rate list.
 *
 * The legacy `addFromCat` was a dropdown attached to every row, searchable by name. Here
 * it is one dialog reached from the table, which does the same job with far less DOM —
 * and, unlike the legacy version, works when the rate list is long enough that a
 * per-row dropdown becomes unusable.
 *
 * A line added this way records `catalogueId`, but the *values* are copied. An estimate
 * stores the price it was built with, not a live reference, so changing a rate later
 * never rewrites a quote that has already gone out.
 */
import { useMemo, useState } from "react";
import { useCatalogue } from "@/api/queries/settings";
import type { CatalogueItemOut } from "@/api/types";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { EmptyState, LoadingState } from "@/components/feedback";
import { Input } from "@/components/form";
import { categoryColor } from "@/domain/enums";
import { formatMoney } from "@/domain/money";
import type { LineItemDoc } from "./document";

export function CataloguePicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (item: LineItemDoc) => void;
}) {
  const { data: items, isPending } = useCatalogue();
  const [search, setSearch] = useState("");

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const all = items ?? [];
    if (!needle) return all;
    return all.filter((item) =>
      [item.name, item.category, item.unit].some((field) =>
        (field ?? "").toLowerCase().includes(needle),
      ),
    );
  }, [items, search]);

  function pick(item: CatalogueItemOut) {
    onPick({
      name: item.name,
      category: item.category || "other",
      unit: item.unit || "Ea",
      quantity: "1",
      unitCost: item.unit_cost,
      // Not custom: this came from the rate list, which is what `isCustom` records.
      isCustom: false,
      catalogueId: item.id,
      notes: "",
    });
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add from the rate list"
      description="Values are copied into the line. Changing a rate later will not alter this estimate."
      size="lg"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="flex flex-col gap-3">
        <Input
          type="search"
          value={search}
          placeholder="Search the rate list…"
          aria-label="Search the rate list"
          onChange={(event) => setSearch(event.target.value)}
        />

        {isPending ? (
          <LoadingState label="Loading rates…" />
        ) : visible.length === 0 ? (
          <EmptyState
            title={search ? "No matching rates" : "The rate list is empty"}
            description={
              search
                ? "Try a different name, category, or unit."
                : "An owner or admin can add rates in Settings."
            }
          />
        ) : (
          <ul className="flex flex-col divide-y divide-gray-100">
            {visible.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => pick(item)}
                  className="flex w-full items-center gap-3 py-2 text-left hover:bg-gray-50"
                >
                  <span
                    aria-hidden="true"
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: categoryColor(item.category) }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-gray-900">{item.name}</span>
                    <span className="block text-xs text-gray-500">
                      {item.category || "—"} · per {item.unit || "unit"}
                    </span>
                  </span>
                  <span className="tnum shrink-0 text-sm font-medium text-gray-900">
                    {formatMoney(item.unit_cost)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
