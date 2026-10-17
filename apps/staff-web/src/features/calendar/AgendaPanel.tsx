/**
 * The selected day as a list, beside the calendar, on screens wide enough to spare it.
 *
 * Built from the meetings the page has already loaded — it asks the API for nothing — so
 * "Coming up" reaches only as far as the current view's window: the rest of the week in
 * week view, the rest of the month in month view, and nothing beyond the day in day view.
 */
import type { MeetingOut } from "@/api/types";
import { localDayKey } from "@/domain/calendar";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";
import { AttendeeStack } from "./AttendeeStack";
import { meetingTint } from "./meetingStyle";

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "long" });
const MONTH_DAY = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric" });
const SHORT_DAY = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" });

/** How many meetings after the selected day to list. */
const COMING_UP = 4;

export function AgendaPanel({
  day,
  meetings,
  onOpenMeeting,
  onCreate,
}: {
  day: Date;
  /** Everything loaded for the current view, in any order. */
  meetings: readonly MeetingOut[];
  onOpenMeeting: (meeting: MeetingOut) => void;
  onCreate: () => void;
}) {
  const now = Date.now();
  const dayKey = localDayKey(day);
  const sorted = [...meetings].sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
  const onDay = sorted.filter((meeting) => localDayKey(meeting.start_time) === dayKey);
  const later = sorted
    .filter((meeting) => localDayKey(meeting.start_time) > dayKey)
    .slice(0, COMING_UP);
  const isToday = dayKey === localDayKey(new Date());

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-3xl bg-surface p-4 ring-1 ring-gray-200/80">
        <div className="flex items-start justify-between gap-3 px-1">
          <div>
            <p className="text-xs font-semibold tracking-wider text-gray-400 uppercase">
              {isToday ? "Today" : WEEKDAY.format(day)}
            </p>
            <h3 className="text-lg font-semibold tracking-tight text-gray-900">
              {MONTH_DAY.format(day)}
            </h3>
          </div>
          <span className="mt-1 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-semibold text-gray-600 tnum">
            {onDay.length} {onDay.length === 1 ? "meeting" : "meetings"}
          </span>
        </div>

        {onDay.length === 0 ? (
          <div className="mt-4 flex flex-col items-center gap-3 rounded-2xl border border-dashed border-gray-200 px-4 py-8 text-center">
            <span aria-hidden="true" className="grid size-10 place-items-center rounded-full bg-lime-300 text-ink">
              <svg viewBox="0 0 16 16" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
                <rect x="2.5" y="3.5" width="11" height="10" rx="2" />
                <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
              </svg>
            </span>
            <p className="text-sm text-gray-500">Nothing scheduled.</p>
            <button
              type="button"
              onClick={onCreate}
              className="rounded-full bg-gray-900 px-3.5 py-1.5 text-xs font-semibold text-surface transition hover:opacity-90"
            >
              Add a meeting
            </button>
          </div>
        ) : (
          <ol className="mt-4 flex flex-col gap-2">
            {onDay.map((meeting) => {
              const start = Date.parse(meeting.start_time);
              const end = Date.parse(meeting.end_time);
              const live = start <= now && now < end;
              const past = end <= now;
              return (
                <li key={meeting.id}>
                  <AgendaItem meeting={meeting} live={live} past={past} onOpen={onOpenMeeting} />
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {later.length > 0 && (
        <section className="rounded-3xl bg-surface p-4 ring-1 ring-gray-200/80">
          <h3 className="px-1 text-sm font-semibold text-gray-900">Coming up</h3>
          <ol className="mt-3 flex flex-col">
            {later.map((meeting) => (
              <li key={meeting.id}>
                <button
                  type="button"
                  onClick={() => onOpenMeeting(meeting)}
                  className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-gray-50"
                >
                  <span
                    aria-hidden="true"
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: meeting.color }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-gray-900">{meeting.title}</span>
                    <span className="block text-xs text-gray-500 tnum">
                      {SHORT_DAY.format(new Date(meeting.start_time))} · {formatTime(meeting.start_time)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function AgendaItem({
  meeting,
  live,
  past,
  onOpen,
}: {
  meeting: MeetingOut;
  live: boolean;
  past: boolean;
  onOpen: (meeting: MeetingOut) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(meeting)}
      style={{ backgroundColor: meetingTint(meeting.color, live ? 26 : 14) }}
      className={cn(
        "flex w-full gap-3 rounded-2xl p-3 text-left ring-1 ring-gray-900/5 transition hover:-translate-y-px hover:shadow-md",
        past && "opacity-60",
      )}
    >
      <span className="w-14 shrink-0 text-xs tnum">
        <span className="block font-semibold text-gray-900">{formatTime(meeting.start_time)}</span>
        <span className="block text-gray-500">{formatTime(meeting.end_time)}</span>
      </span>
      <span aria-hidden="true" className="w-1 shrink-0 rounded-full" style={{ backgroundColor: meeting.color }} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-gray-900">{meeting.title}</span>
          {live && (
            <span className="shrink-0 rounded-full bg-lime-300 px-1.5 py-px text-[10px] font-bold text-ink uppercase">
              Now
            </span>
          )}
        </span>
        {meeting.location && <span className="truncate text-xs text-gray-500">{meeting.location}</span>}
        <AttendeeStack meeting={meeting} max={4} />
      </span>
    </button>
  );
}
