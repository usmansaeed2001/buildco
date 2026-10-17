/**
 * Lines the assistant proposes to add to a supplement, as they would be saved.
 *
 * Grouped by room, a new room marked as new, each line with where its price came from,
 * and the total before and after. Nothing here is worked out: every figure is the
 * server's, and money is only formatted, through `domain/money`.
 *
 * Used twice: read-only while the proposal is staged, and as what the user is offered
 * to keep after taking over with Stop.
 */
import { StagedMark } from "@/components/staged";
import { formatMoney, formatQuantity } from "@/domain/money";
import { SourceChip } from "@/features/agent/ApprovalCard";
import type { AddedLineLabel, ProposalLabels } from "@/features/agent/protocol";

interface RoomGroup {
  room: string;
  newRoom: boolean;
  lines: AddedLineLabel[];
}

function byRoom(lines: readonly AddedLineLabel[]): RoomGroup[] {
  const groups: RoomGroup[] = [];
  for (const line of lines) {
    const group = groups.find((each) => each.room === line.room && each.newRoom === line.new_room);
    if (group) group.lines.push(line);
    else groups.push({ room: line.room, newRoom: line.new_room, lines: [line] });
  }
  return groups;
}

export function AddedLines({ labels }: { labels: ProposalLabels }) {
  const lines = labels.lines ?? [];
  return (
    <div className="flex flex-col gap-4">
      {byRoom(lines).map((group) => (
        <section key={`${group.newRoom ? "new" : "old"}:${group.room}`}>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
            {group.room}
            {group.newRoom && (
              <span className="rounded-full bg-assistant-50 px-1.5 py-px text-[11px] font-medium text-assistant-700 ring-1 ring-assistant-100 ring-inset dark:text-assistant-300">
                New room
              </span>
            )}
          </h3>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {group.lines.map((line, index) => (
              <li key={index}>
                <StagedMark>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 font-medium text-gray-900">{line.name}</span>
                    <span className="tnum shrink-0 text-gray-900">{formatMoney(line.total)}</span>
                  </div>
                  <p className="tnum text-xs text-gray-500">
                    {formatQuantity(line.quantity)} {line.unit} × {formatMoney(line.unit_cost)}
                    <SourceChip source={line.source} />
                    {line.source === "differs" && line.catalogue_unit_cost && (
                      <span className="ml-1">
                        (catalogue {formatMoney(line.catalogue_unit_cost)})
                      </span>
                    )}
                  </p>
                </StagedMark>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {labels.old_total !== undefined && labels.new_total !== undefined && (
        <div className="flex items-baseline justify-between border-t border-gray-100 pt-3 text-sm">
          <span className="font-medium text-gray-700">Total</span>
          <span className="tnum">
            <span className="text-gray-500 line-through">
              <span className="sr-only">Now: </span>
              {formatMoney(labels.old_total)}
            </span>{" "}
            <span className="font-semibold text-gray-900">
              <span className="sr-only">Would become: </span>
              {formatMoney(labels.new_total)}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}
