/**
 * The line items of the selected room.
 *
 * Every cell writes straight through to the document on change — there is no per-row
 * save. Autosave debounces the result, and `useEstimateDocument` coalesces consecutive
 * keystrokes in one cell into a single undo step.
 *
 * Quantity and unit cost are held as the raw text the user typed rather than as
 * numbers. Parsing on each keystroke would fight the user: "1." is not a number, and
 * coercing it to 1 moves the caret and makes "1.5" impossible to type.
 */
import { useState, type ReactNode } from "react";
import { Button } from "@/components/Button";
import { Input, Select, Textarea } from "@/components/form";
import { Table, TableWrap, TBody, Td, TFoot, Th, THead, Tr } from "@/components/Table";
import { EmptyState } from "@/components/feedback";
import { categoryColor, ITEM_CATEGORIES, ITEM_UNITS } from "@/domain/enums";
import { formatMoney, lineTotal } from "@/domain/money";
import { roomTotal } from "@/domain/estimateTotals";
import type { LineItemDoc, RoomDoc } from "./document";

export type UpdateItem = <K extends keyof LineItemDoc>(
  index: number,
  field: K,
  value: LineItemDoc[K],
) => void;

export function LineItemsTable({
  room,
  readOnly,
  onAddItem,
  onUpdateItem,
  onDeleteItem,
}: {
  room: RoomDoc;
  readOnly: boolean;
  onAddItem: () => void;
  onUpdateItem: UpdateItem;
  onDeleteItem: (index: number) => void;
}) {
  // Which rows have their notes field open. Presentational only, so it is not part of
  // the document and never triggers a save.
  const [openNotes, setOpenNotes] = useState<ReadonlySet<number>>(new Set());

  function toggleNotes(index: number) {
    setOpenNotes((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  if (room.items.length === 0) {
    return (
      <div className="rounded-card bg-surface ring-1 ring-gray-200">
        <EmptyState
          title="No line items in this room"
          {...(readOnly ? {} : { description: "Add the first one to start pricing it." })}
          {...(readOnly
            ? {}
            : {
                action: (
                  <Button variant="primary" size="sm" onClick={onAddItem}>
                    + Add item
                  </Button>
                ),
              })}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <TableWrap>
        <Table>
          <THead>
            <Tr>
              <Th>Item</Th>
              <Th>Category</Th>
              <Th>Unit</Th>
              <Th numeric>Qty</Th>
              <Th numeric>Unit cost</Th>
              <Th numeric>Total</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </Tr>
          </THead>

          <TBody>
            {room.items.map((item, index) => (
              <LineItemRows
                key={index}
                item={item}
                index={index}
                readOnly={readOnly}
                notesOpen={openNotes.has(index)}
                onToggleNotes={() => toggleNotes(index)}
                onUpdate={onUpdateItem}
                onDelete={() => onDeleteItem(index)}
              />
            ))}
          </TBody>

          <TFoot>
            <Tr>
              <Td colSpan={5} className="text-right text-gray-500">
                {room.name || "Untitled"} subtotal
              </Td>
              <Td numeric className="font-semibold">
                {formatMoney(roomTotal(room))}
              </Td>
              <Td />
            </Tr>
          </TFoot>
        </Table>
      </TableWrap>

      {!readOnly && (
        <div>
          <Button size="sm" onClick={onAddItem}>
            + Add item
          </Button>
        </div>
      )}
    </div>
  );
}

function LineItemRows({
  item,
  index,
  readOnly,
  notesOpen,
  onToggleNotes,
  onUpdate,
  onDelete,
}: {
  item: LineItemDoc;
  index: number;
  readOnly: boolean;
  notesOpen: boolean;
  onToggleNotes: () => void;
  onUpdate: UpdateItem;
  onDelete: () => void;
}) {
  const label = item.name || `line ${index + 1}`;
  const hasNotes = item.notes.trim().length > 0;

  if (readOnly) {
    return (
      <>
        <Tr>
          <Td>{item.name || <span className="text-gray-400">Unnamed</span>}</Td>
          <Td>
            <CategoryDot category={item.category} /> {item.category}
          </Td>
          <Td>{item.unit}</Td>
          <Td numeric>{item.quantity}</Td>
          <Td numeric>{formatMoney(item.unitCost)}</Td>
          <Td numeric className="font-medium">
            {formatMoney(lineTotal(item.quantity, item.unitCost))}
          </Td>
          <Td />
        </Tr>
        {hasNotes && <NotesRow>{item.notes}</NotesRow>}
      </>
    );
  }

  return (
    <>
      <Tr>
        <Td>
          <Input
            value={item.name}
            placeholder="Description"
            aria-label={`Name for ${label}`}
            onChange={(event) => onUpdate(index, "name", event.target.value)}
          />
        </Td>

        <Td>
          <div className="flex items-center gap-1.5">
            <CategoryDot category={item.category} />
            <Select
              value={item.category}
              aria-label={`Category for ${label}`}
              onChange={(event) =>
                onUpdate(index, "category", event.target.value as LineItemDoc["category"])
              }
            >
              {ITEM_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </Select>
          </div>
        </Td>

        <Td>
          <Select
            value={item.unit}
            aria-label={`Unit for ${label}`}
            onChange={(event) => onUpdate(index, "unit", event.target.value as LineItemDoc["unit"])}
          >
            {ITEM_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {unit}
              </option>
            ))}
          </Select>
        </Td>

        <Td numeric>
          <NumberCell
            value={item.quantity}
            label={`Quantity for ${label}`}
            onChange={(value) => onUpdate(index, "quantity", value)}
          />
        </Td>

        <Td numeric>
          <NumberCell
            value={item.unitCost}
            label={`Unit cost for ${label}`}
            onChange={(value) => onUpdate(index, "unitCost", value)}
          />
        </Td>

        <Td numeric className="font-medium">
          {formatMoney(lineTotal(item.quantity, item.unitCost))}
        </Td>

        <Td>
          <div className="flex justify-end gap-0.5">
            <button
              type="button"
              onClick={onToggleNotes}
              aria-expanded={notesOpen}
              aria-label={`${notesOpen ? "Hide" : "Show"} notes for ${label}`}
              className={
                hasNotes
                  ? "rounded p-1 text-xs text-brand-600 hover:bg-brand-50"
                  : "rounded p-1 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-700"
              }
            >
              &#9998;
            </button>
            <button
              type="button"
              onClick={onDelete}
              aria-label={`Delete ${label}`}
              className="rounded p-1 text-xs text-gray-400 hover:bg-danger-50 hover:text-danger-600"
            >
              &#10005;
            </button>
          </div>
        </Td>
      </Tr>

      {notesOpen && (
        <NotesRow>
          <Textarea
            rows={2}
            value={item.notes}
            placeholder="Notes for this line"
            aria-label={`Notes for ${label}`}
            onChange={(event) => onUpdate(index, "notes", event.target.value)}
          />
        </NotesRow>
      )}
    </>
  );
}

/**
 * A free-text numeric cell.
 *
 * `inputMode="decimal"` gets the numeric keypad on a phone without `type="number"`,
 * whose spinners, scroll-wheel capture and locale-dependent parsing all cause more
 * trouble than they solve on a table of prices.
 */
function NumberCell({
  value,
  label,
  onChange,
}: {
  value: string;
  label: string;
  onChange: (value: string) => void;
}) {
  return (
    <Input
      value={value}
      aria-label={label}
      inputMode="decimal"
      className="tnum text-right"
      onChange={(event) => onChange(event.target.value)}
      onFocus={(event) => event.target.select()}
    />
  );
}

function NotesRow({ children }: { children: ReactNode }) {
  return (
    <Tr className="bg-gray-50/60">
      <Td colSpan={7} className="text-sm text-gray-600">
        {children}
      </Td>
    </Tr>
  );
}

function CategoryDot({ category }: { category: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: categoryColor(category) }}
    />
  );
}
