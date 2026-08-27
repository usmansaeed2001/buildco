/**
 * The shared team calendar.
 *
 * Month and day views, both built by hand — no calendar library. The grid is six weeks
 * of `<button>`s and a list; adding a dependency for that would be a lot of bundle for a
 * layout that is fifty lines of `monthGrid`.
 *
 * View and anchor date live in the query string, so a particular month is linkable and
 * a refresh does not throw you back to today.
 *
 * `GET /meetings` is **not** role-filtered — the calendar is shared across the team, so
 * a member sees everything. Only creating, editing and cancelling are elevated.
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMeetings } from "@/api/queries/meetings";
import type { MeetingOut } from "@/api/types";
import { useIsElevated } from "@/auth/useAuth";
import { Button } from "@/components/Button";
import { ErrorState, LoadingState, PageHeader } from "@/components/feedback";
import {
  addDays,
  addMonths,
  dayWindow,
  groupByDay,
  localDayKey,
  monthGrid,
  monthWindow,
  WEEKDAY_LABELS,
} from "@/domain/calendar";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";
import { MeetingModal } from "./MeetingModal";

type View = "month" | "day";

const MONTH_LABEL = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });
const DAY_LABEL = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

export function CalendarPage() {
  const [params, setParams] = useSearchParams();
  const elevated = useIsElevated();

  const view: View = params.get("view") === "day" ? "day" : "month";
  // An unparseable `on=` falls back to today rather than rendering an Invalid Date.
  const anchor = useMemo(() => {
    const raw = params.get("on");
    const parsed = raw ? new Date(`${raw}T00:00:00`) : new Date();
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }, [params]);

  const [editing, setEditing] = useState<MeetingOut | null>(null);
  const [creatingOn, setCreatingOn] = useState<Date | null>(null);

  const window = view === "month" ? monthWindow(anchor) : dayWindow(anchor);
  const { data: meetings, isPending, error, refetch } = useMeetings(window);

  const byDay = useMemo(() => groupByDay(meetings ?? []), [meetings]);

  function go(next: Date, nextView: View = view) {
    const search = new URLSearchParams(params);
    search.set("on", localDayKey(next));
    search.set("view", nextView);
    setParams(search, { replace: true });
  }

  const step = (direction: number) =>
    view === "month" ? addMonths(anchor, direction) : addDays(anchor, direction);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Calendar"
        actions={
          elevated ? (
            <Button variant="primary" onClick={() => setCreatingOn(anchor)}>
              New meeting
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" aria-label="Previous" onClick={() => go(step(-1))}>
          &larr;
        </Button>
        <Button size="sm" onClick={() => go(new Date())}>
          Today
        </Button>
        <Button size="sm" aria-label="Next" onClick={() => go(step(1))}>
          &rarr;
        </Button>

        <h2 className="ml-2 text-lg font-semibold text-gray-900">
          {view === "month" ? MONTH_LABEL.format(anchor) : DAY_LABEL.format(anchor)}
        </h2>

        <div className="ml-auto flex gap-1" role="group" aria-label="Calendar view">
          {(["month", "day"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              onClick={() => go(anchor, value)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium capitalize",
                view === value
                  ? "bg-gray-900 text-white"
                  : "bg-white text-gray-600 ring-1 ring-inset ring-gray-300 hover:bg-gray-50",
              )}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      {isPending ? (
        <LoadingState label="Loading meetings…" />
      ) : error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : view === "month" ? (
        <MonthGrid
          anchor={anchor}
          byDay={byDay}
          onOpenDay={(day) => go(day, "day")}
          onOpenMeeting={setEditing}
        />
      ) : (
        <DayList
          day={anchor}
          meetings={byDay.get(localDayKey(anchor)) ?? []}
          canCreate={elevated}
          onCreate={() => setCreatingOn(anchor)}
          onOpenMeeting={setEditing}
        />
      )}

      {(editing !== null || creatingOn !== null) && (
        <MeetingModal
          key={editing?.id ?? "new"}
          open
          meeting={editing}
          defaultDate={creatingOn ?? anchor}
          canManage={elevated}
          onClose={() => {
            setEditing(null);
            setCreatingOn(null);
          }}
        />
      )}
    </div>
  );
}

function MonthGrid({
  anchor,
  byDay,
  onOpenDay,
  onOpenMeeting,
}: {
  anchor: Date;
  byDay: Map<string, MeetingOut[]>;
  onOpenDay: (day: Date) => void;
  onOpenMeeting: (meeting: MeetingOut) => void;
}) {
  const weeks = monthGrid(anchor);

  return (
    <div className="overflow-hidden rounded-card bg-surface ring-1 ring-gray-200">
      <div className="grid grid-cols-7 border-b border-gray-200 bg-gray-50">
        {WEEKDAY_LABELS.map((label) => (
          <div
            key={label}
            className="px-2 py-1.5 text-center text-xs font-medium tracking-wide text-gray-500 uppercase"
          >
            {label}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {weeks.flat().map((day) => {
          const dayMeetings = byDay.get(day.key) ?? [];

          return (
            <div
              key={day.key}
              className={cn(
                "flex min-h-24 flex-col gap-1 border-r border-b border-gray-100 p-1.5",
                !day.inMonth && "bg-gray-50/60",
              )}
            >
              <button
                type="button"
                onClick={() => onOpenDay(day.date)}
                aria-label={`Open ${day.key}`}
                className={cn(
                  "self-start rounded px-1.5 py-0.5 text-xs font-medium",
                  day.isToday
                    ? "bg-brand-600 text-white"
                    : day.inMonth
                      ? "text-gray-700 hover:bg-gray-100"
                      : "text-gray-400 hover:bg-gray-100",
                )}
              >
                {day.date.getDate()}
              </button>

              {dayMeetings.slice(0, 3).map((meeting) => (
                <MeetingChip key={meeting.id} meeting={meeting} onClick={onOpenMeeting} />
              ))}

              {dayMeetings.length > 3 && (
                <button
                  type="button"
                  onClick={() => onOpenDay(day.date)}
                  className="px-1 text-left text-[11px] text-gray-500 hover:text-gray-800"
                >
                  +{dayMeetings.length - 3} more
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DayList({
  day,
  meetings,
  canCreate,
  onCreate,
  onOpenMeeting,
}: {
  day: Date;
  meetings: MeetingOut[];
  canCreate: boolean;
  onCreate: () => void;
  onOpenMeeting: (meeting: MeetingOut) => void;
}) {
  if (meetings.length === 0) {
    return (
      <div className="rounded-card bg-surface px-6 py-16 text-center ring-1 ring-gray-200">
        <p className="font-medium text-gray-900">Nothing scheduled</p>
        <p className="mt-1 text-sm text-gray-500">{DAY_LABEL.format(day)}</p>
        {canCreate && (
          <Button variant="primary" size="sm" className="mt-4" onClick={onCreate}>
            New meeting
          </Button>
        )}
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {meetings.map((meeting) => (
        <li key={meeting.id}>
          <button
            type="button"
            onClick={() => onOpenMeeting(meeting)}
            className="flex w-full items-start gap-3 rounded-card bg-surface p-4 text-left ring-1 ring-gray-200 hover:shadow-md"
          >
            <span
              aria-hidden="true"
              className="mt-1 w-1 self-stretch rounded-full"
              style={{ backgroundColor: meeting.color }}
            />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-gray-900">{meeting.title}</p>
              <p className="text-sm text-gray-500">
                {formatTime(meeting.start_time)} – {formatTime(meeting.end_time)}
                {meeting.location && ` · ${meeting.location}`}
              </p>
              {/* `default_factory=list` server-side, so this is always present in
                  practice; openapi-typescript marks a field with a default optional. */}
              {(meeting.attendees ?? []).length > 0 && (
                <p className="mt-0.5 truncate text-xs text-gray-500">
                  {(meeting.attendees ?? [])
                    .map((attendee) => attendee.name || attendee.email)
                    .join(", ")}
                </p>
              )}
            </div>
            {meeting.meet_link && (
              <span className="shrink-0 rounded bg-brand-50 px-2 py-0.5 text-xs text-brand-700">
                Meet
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function MeetingChip({
  meeting,
  onClick,
}: {
  meeting: MeetingOut;
  onClick: (meeting: MeetingOut) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(meeting)}
      title={`${formatTime(meeting.start_time)} ${meeting.title}`}
      className="flex items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] hover:bg-gray-100"
    >
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: meeting.color }}
      />
      <span className="truncate text-gray-700">{meeting.title}</span>
    </button>
  );
}
