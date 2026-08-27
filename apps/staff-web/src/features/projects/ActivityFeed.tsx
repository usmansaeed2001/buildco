/**
 * The project's audit trail.
 *
 * Append-only and written server-side by `log_activity` on almost every mutation,
 * including the rules engine's own automatic transitions — which is what makes a status
 * that appeared to change by itself explicable after the fact.
 *
 * `user_name` is a denormalised snapshot taken when the row was written, not a join. So
 * it keeps saying who did it even after that person is removed from the team, which is
 * the point of an audit trail.
 */
import { useState } from "react";
import type { ActivityOut } from "@/api/types";
import { Button } from "@/components/Button";
import { Card } from "@/components/feedback";
import { formatDateTime, formatRelative } from "@/lib/format";

const INITIALLY_SHOWN = 8;

export function ActivityFeed({ activity }: { activity: ActivityOut[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? activity : activity.slice(0, INITIALLY_SHOWN);
  const hidden = activity.length - shown.length;

  return (
    <Card className="flex flex-col gap-3 p-5">
      <h2 className="text-xs font-medium tracking-wide text-gray-500 uppercase">Activity</h2>

      {activity.length === 0 ? (
        <p className="text-sm text-gray-500">Nothing recorded yet.</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {shown.map((entry) => (
            <li key={entry.id} className="flex gap-3">
              <span
                aria-hidden="true"
                className="mt-1.5 size-1.5 shrink-0 rounded-full bg-gray-300"
              />
              <div className="min-w-0">
                <p className="text-sm text-gray-900">{entry.action}</p>
                {entry.details && (
                  <p className="text-xs text-gray-600">{entry.details}</p>
                )}
                <p className="text-xs text-gray-400">
                  {entry.user_name || "System"} ·{" "}
                  <time dateTime={entry.created_at} title={formatDateTime(entry.created_at)}>
                    {formatRelative(entry.created_at)}
                  </time>
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}

      {hidden > 0 && (
        <div>
          <Button size="sm" variant="ghost" onClick={() => setExpanded(true)}>
            Show {hidden} older {hidden === 1 ? "entry" : "entries"}
          </Button>
        </div>
      )}
    </Card>
  );
}
