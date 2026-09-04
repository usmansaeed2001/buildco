/**
 * The calendar.
 *
 * Month, week, day and year views, all built by hand — no calendar library. Adding a
 * dependency would be a lot of bundle for arithmetic that is a few dozen lines in
 * `domain/calendar.ts`, where it is pure and separately tested.
 *
 * View, anchor date and scope all live in the query string, so a particular week is
 * linkable and a refresh does not throw you back to today.
 *
 * **This calendar is no longer shared with the whole team.** It used to be, deliberately:
 * `GET /meetings` was not filtered at all and a member saw everything. It now returns
 * what you created and what you were invited to, and only owners and admins can ask for
 * everything. The scope control below chooses between those; the server enforces the
 * limit, so hiding the "Everyone" option from a member is a convenience, not the
 * mechanism. Anyone may now create a meeting, but only its creator (or an elevated user)
 * may change it.
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMeetings } from "@/api/queries/meetings";
import type { MeetingOut } from "@/api/types";
import { useActor, useIsElevated } from "@/auth/useAuth";
import { Button } from "@/components/Button";
import { ErrorState, LoadingState, PageHeader } from "@/components/feedback";
import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  dayWindow,
  groupByDay,
  localDayKey,
  monthGrid,
  monthWindow,
  weekGrid,
  weekWindow,
  yearGrid,
  yearWindow,
  WEEKDAY_LABELS,
} from "@/domain/calendar";
import { TimeGrid } from "./TimeGrid";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";
import { MeetingModal } from "./MeetingModal";

type View = "month" | "week" | "day" | "year";

const VIEWS = ["month", "week", "day", "year"] as const;

/** Whose meetings to show. Mirrors the API's `scope` parameter. */
type Scope = "mine" | "invited" | "all";

const SCOPES: { value: Scope; label: string; elevatedOnly?: boolean }[] = [
  { value: "mine", label: "Mine" },
  { value: "invited", label: "Invited" },
  { value: "all", label: "Everyone", elevatedOnly: true },
];

const MONTH_LABEL = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });
const MONTH_NAME = new Intl.DateTimeFormat("en-US", { month: "long" });
const DAY_LABEL = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

export function CalendarPage() {
  const [params, setParams] = useSearchParams();
  const elevated = useIsElevated();
  const actor = useActor();

  const view: View = (VIEWS as readonly string[]).includes(params.get("view") ?? "")
    ? (params.get("view") as View)
    : "month";

  // Defaults differ by role on purpose. An elevated user opening the calendar wants the
  // team's week, which is also what they saw before this change. Anyone else wants their
  // own — and since the server clamps `all` for them anyway, the difference is only in
  // which of the two allowed scopes loads first.
  const scope: Scope = ((): Scope => {
    const raw = params.get("scope");
    if (raw === "mine" || raw === "invited" || raw === "all") {
      return raw === "all" && !elevated ? "mine" : raw;
    }
    return elevated ? "all" : "mine";
  })();
  // An unparseable `on=` falls back to today rather than rendering an Invalid Date.
  const anchor = useMemo(() => {
    const raw = params.get("on");
    const parsed = raw ? new Date(`${raw}T00:00:00`) : new Date();
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }, [params]);

  const [editing, setEditing] = useState<MeetingOut | null>(null);
  const [creatingOn, setCreatingOn] = useState<Date | null>(null);
  const [creatingRange, setCreatingRange] = useState<{ start: Date; end: Date } | null>(null);

  const window =
    view === "month"
      ? monthWindow(anchor)
      : view === "week"
        ? weekWindow(anchor)
        : view === "year"
          ? yearWindow(anchor)
          : dayWindow(anchor);
  const {
    data: meetings,
    isPending,
    error,
    refetch,
    // A year is up to 500 meetings, the endpoint's ceiling. The year view only draws a
    // density dot per day, so a truncated result costs a dot, not a meeting — but it is
    // worth knowing that is the trade rather than discovering it.
  } = useMeetings({ ...window, scope, limit: view === "year" ? 500 : undefined });

  const byDay = useMemo(() => groupByDay(meetings ?? []), [meetings]);

  function go(next: Date, nextView: View = view) {
    const search = new URLSearchParams(params);
    search.set("on", localDayKey(next));
    search.set("view", nextView);
    setParams(search, { replace: true });
  }

  function setScope(next: Scope) {
    const search = new URLSearchParams(params);
    search.set("scope", next);
    setParams(search, { replace: true });
  }

  const step = (direction: number) => {
    switch (view) {
      case "month":
        return addMonths(anchor, direction);
      case "week":
        return addWeeks(anchor, direction);
      case "year":
        return addYears(anchor, direction);
      default:
        return addDays(anchor, direction);
    }
  };

  const heading =
    view === "month"
      ? MONTH_LABEL.format(anchor)
      : view === "year"
        ? String(anchor.getFullYear())
        : view === "week"
          ? `Week of ${DAY_LABEL.format(weekGrid(anchor)[0]!.date)}`
          : DAY_LABEL.format(anchor);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Calendar"
        actions={
          // Open to everyone now. It was elevated-only, which left a member unable to put
          // their own work on the calendar and made "Mine" a permanently empty tab.
          <Button variant="primary" onClick={() => setCreatingOn(anchor)}>
            New meeting
          </Button>
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

        <h2 className="ml-2 text-lg font-semibold text-gray-900">{heading}</h2>

        <div className="ml-auto flex gap-1" role="group" aria-label="Calendar view">
          {VIEWS.map((value) => (
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

      <div className="flex gap-1" role="radiogroup" aria-label="Whose meetings to show">
        {SCOPES.filter((option) => elevated || !option.elevatedOnly).map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={scope === option.value}
            onClick={() => setScope(option.value)}
            className={cn(
              "rounded-full px-3 py-1 text-sm font-medium transition-colors",
              scope === option.value
                ? "bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200"
                : "bg-white text-gray-600 ring-1 ring-inset ring-gray-300 hover:bg-gray-50",
            )}
          >
            {option.label}
          </button>
        ))}
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
      ) : view === "year" ? (
        <YearView anchor={anchor} byDay={byDay} onOpenDay={(day) => go(day, "day")} />
      ) : (
        <TimeGrid
          days={view === "week" ? weekGrid(anchor).map((day) => day.date) : [anchor]}
          byDay={byDay}
          canCreate
          onOpenMeeting={setEditing}
          onCreateRange={(start, end) => setCreatingRange({ start, end })}
        />
      )}

      {(editing !== null || creatingOn !== null || creatingRange !== null) && (
        <MeetingModal
          key={editing?.id ?? "new"}
          open
          meeting={editing}
          defaultDate={creatingRange?.start ?? creatingOn ?? anchor}
          {...(creatingRange ? { defaultRange: creatingRange } : {})}
          // Editing is row-level now: your own meeting, or any if you are elevated. An
          // attendee can open someone else's meeting to read it, but not change it.
          canManage={editing ? elevated || editing.created_by === actor?.id : true}
          onClose={() => {
            setEditing(null);
            setCreatingOn(null);
            setCreatingRange(null);
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

/**
 * Twelve small month grids, one dot per day that has anything on it.
 *
 * Deliberately not chips. A year of meeting titles is unreadable at any size, and the
 * question a year view answers is "which weeks were busy" — so it shows density and
 * hands off to the day view for detail.
 */
function YearView({
  anchor,
  byDay,
  onOpenDay,
}: {
  anchor: Date;
  byDay: Map<string, MeetingOut[]>;
  onOpenDay: (day: Date) => void;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {yearGrid(anchor).map(({ month, weeks }) => (
        <div key={month.getMonth()} className="rounded-md bg-surface p-3 ring-1 ring-gray-200">
          <h3 className="mb-2 text-sm font-semibold text-gray-900">{MONTH_NAME.format(month)}</h3>

          <div className="grid grid-cols-7 gap-px text-center">
            {WEEKDAY_LABELS.map((label) => (
              <span key={label} className="text-[9px] text-gray-400">
                {label.charAt(0)}
              </span>
            ))}

            {weeks.flat().map((day) => {
              const count = byDay.get(day.key)?.length ?? 0;
              return (
                <button
                  key={day.key}
                  type="button"
                  onClick={() => onOpenDay(day.date)}
                  className={cn(
                    "flex aspect-square flex-col items-center justify-center rounded text-[10px] hover:bg-gray-100",
                    day.inMonth ? "text-gray-700" : "text-gray-300",
                    day.isToday && "bg-brand-50 font-semibold text-brand-700",
                  )}
                >
                  {day.date.getDate()}
                  {/* Announced as well as drawn: a dot alone tells a screen reader
                      nothing, and this is the only signal the year view carries. */}
                  <span
                    className={cn(
                      "mt-0.5 size-1 rounded-full",
                      count > 0 ? "bg-brand-500" : "bg-transparent",
                    )}
                  >
                    {count > 0 && (
                      <span className="sr-only">
                        {count} {count === 1 ? "meeting" : "meetings"}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
