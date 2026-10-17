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
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useMeetings } from "@/api/queries/meetings";
import type { MeetingOut } from "@/api/types";
import { useActor, useIsElevated } from "@/auth/useAuth";
import { ErrorState, LoadingState } from "@/components/feedback";
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
import { useStagedProposal } from "@/features/agent/AgentProvider";
import type { Proposal } from "@/features/agent/protocol";
import { apiFetch } from "@/api/client";
import { MeetingModal, type MeetingDraft } from "./MeetingModal";
import { meetingTint } from "./meetingStyle";
import { AgendaPanel } from "./AgendaPanel";

type View = "month" | "week" | "day" | "year";

const VIEWS = ["month", "week", "day", "year"] as const;

/** Whose meetings to show. Mirrors the API's `scope` parameter. */
type Scope = "mine" | "invited" | "all";

const SCOPES: { value: Scope; label: string; swatch: string; elevatedOnly?: boolean }[] = [
  { value: "mine", label: "Mine", swatch: "bg-lime-400" },
  { value: "invited", label: "Invited", swatch: "bg-sky-400" },
  { value: "all", label: "Everyone", swatch: "bg-indigo-400", elevatedOnly: true },
];

const MONTH_LABEL = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });
const MONTH_NAME = new Intl.DateTimeFormat("en-US", { month: "long" });
const DAY_LABEL = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});
/**
 * How wide the page must be before the agenda panel joins the layout: enough for the
 * mini month, the panel, and a week that still has ~130px a day.
 */
const AGENDA_MIN_WIDTH = 1440;

const TODAY_LABEL = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
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

  // The assistant stages a new meeting here, on the real form. The server is told the
  // proposal is on screen only once this page has rendered it, which is what the effect
  // is for: saying so any earlier would let the agent describe a form nobody can see.
  const assistant = useStagedProposal("meeting.create", "meeting.update");
  const [takenOver, setTakenOver] = useState<{
    proposal: Proposal;
    meeting: MeetingOut | null;
  } | null>(null);
  const stagedId = assistant.staged?.id;
  const { confirm: confirmStaged, takeHandover, handover } = assistant;
  useEffect(() => {
    if (stagedId) confirmStaged(stagedId);
  }, [stagedId, confirmStaged]);
  useEffect(() => {
    if (!handover) return;
    takeHandover();
    const meetingId = handover.payload["meeting_id"];
    if (typeof meetingId !== "string") {
      setTakenOver({ proposal: handover, meeting: null });
      return;
    }
    // A change to an existing meeting is finished on that meeting's own form, so the
    // user saves an edit and not a second meeting. It may have been staged on a day
    // this page has not loaded, so it is fetched rather than looked up.
    let current = true;
    void apiFetch<MeetingOut>(`/meetings/${meetingId}`).then(
      (meeting) => current && setTakenOver({ proposal: handover, meeting }),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [handover, takeHandover]);

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
  const [page, pageWidth] = useWidth<HTMLDivElement>();
  const wide = pageWidth >= AGENDA_MIN_WIDTH;
  const stats = useMemo(() => summarise(meetings ?? []), [meetings]);

  // The days the main view is showing, lit up on the mini month so it is plain where in
  // the month you are.
  const shown = new Set(
    view === "week" ? weekGrid(anchor).map((day) => day.key) : view === "day" ? [localDayKey(anchor)] : [],
  );

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
    // On a wide column the calendar outgrows the shell's 1600px cap, up to 1920px and
    // centred. Sized against the app column (`cqw`), not the window, so a docked panel
    // beside the app is accounted for. Below `app-xl` it is the shell's width as usual.
    <div
      ref={page}
      className="flex flex-col gap-5 app-xl:mx-[calc((100%_-_min(100cqw_-_3rem,1920px))/2)] app-xl:w-[min(100cqw_-_3rem,1920px)]"
    >
      {/* The banner. A wash rather than a fill, so it lifts the page without competing
          with the meetings below for colour. */}
      <header className="relative overflow-hidden rounded-3xl bg-linear-to-br from-indigo-100 via-sky-50 to-lime-100 px-5 py-5 ring-1 ring-gray-900/5 app-md:px-7 app-md:py-6 dark:from-indigo-500/15 dark:via-surface dark:to-lime-400/10">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-16 -right-10 size-56 rounded-full bg-lime-300/40 blur-3xl dark:bg-lime-300/10"
        />
        <div className="relative flex flex-wrap items-end justify-between gap-5">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-gray-900">Calendar</h1>
            <p className="mt-1 text-sm text-gray-600">Today is {TODAY_LABEL.format(new Date())}</p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <dl className="flex items-stretch gap-2">
              <Stat label="Meetings" value={meetings ? String(stats.count) : "—"} />
              <Stat label="Hours booked" value={meetings ? formatHours(stats.minutes) : "—"} />
            </dl>
            {/* Open to everyone now. It was elevated-only, which left a member unable to put
                their own work on the calendar and made "Mine" a permanently empty tab. */}
            <button
              type="button"
              onClick={() => setCreatingOn(anchor)}
              className="inline-flex items-center gap-2 rounded-full bg-gray-900 px-5 py-3 text-sm font-semibold text-surface shadow-lg shadow-gray-900/15 transition hover:-translate-y-px hover:shadow-xl active:translate-y-0"
            >
              <PlusIcon />
              New meeting
            </button>
          </div>
        </div>
      </header>

      <div
        className={cn(
          "grid gap-5",
          wide
            ? "grid-cols-[17rem_minmax(0,1fr)_20rem]"
            : "app-lg:grid-cols-[17rem_minmax(0,1fr)]",
        )}
      >
        <aside className="order-2 flex flex-col gap-4 self-start app-lg:sticky app-lg:top-[4.5rem] app-lg:order-1">
          <MiniMonth
            // A new month on the main view resets the mini month to follow it.
            key={`${anchor.getFullYear()}-${anchor.getMonth()}`}
            anchor={anchor}
            shown={shown}
            byDay={byDay}
            onPick={(day) => go(day)}
          />

          <section className="rounded-3xl bg-surface p-4 ring-1 ring-gray-200/80">
            <h3 className="px-1 text-sm font-semibold text-gray-900">Calendars</h3>
            <p className="px-1 text-xs text-gray-500">Whose meetings to show</p>
            <div className="mt-3 flex flex-col gap-1" role="radiogroup" aria-label="Whose meetings to show">
              {SCOPES.filter((option) => elevated || !option.elevatedOnly).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={scope === option.value}
                  onClick={() => setScope(option.value)}
                  className={cn(
                    "flex items-center gap-3 rounded-xl px-3 py-2 text-left text-sm font-medium transition-colors",
                    scope === option.value
                      ? "bg-gray-900 text-surface"
                      : "text-gray-700 hover:bg-gray-100",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "grid size-4 shrink-0 place-items-center rounded-md",
                      option.swatch,
                    )}
                  >
                    {scope === option.value && <CheckIcon />}
                  </span>
                  {option.label}
                </button>
              ))}
            </div>
          </section>
        </aside>

        <section className="order-1 overflow-hidden rounded-3xl bg-surface shadow-sm ring-1 ring-gray-200/80 app-lg:order-2">
          <div className="flex flex-wrap items-center gap-3 border-b border-gray-100 bg-linear-to-r from-lime-100/80 via-surface to-indigo-100/70 px-4 py-3 app-md:px-5 dark:from-lime-400/10 dark:to-indigo-400/10">
            <div className="flex items-center gap-1">
              <RoundButton label="Previous" onClick={() => go(step(-1))}>
                <ChevronIcon direction="left" />
              </RoundButton>
              <RoundButton label="Next" onClick={() => go(step(1))}>
                <ChevronIcon direction="right" />
              </RoundButton>
            </div>

            <h2 className="text-lg font-semibold tracking-tight text-gray-900 app-md:text-xl">{heading}</h2>

            <button
              type="button"
              onClick={() => go(new Date())}
              className="rounded-full bg-gray-900 px-3 py-1 text-xs font-semibold text-surface transition hover:opacity-90"
            >
              Today
            </button>

            <div
              className="ml-auto flex gap-0.5 rounded-full bg-gray-900/5 p-1 ring-1 ring-gray-900/5 dark:bg-gray-100"
              role="group"
              aria-label="Calendar view"
            >
              {VIEWS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={view === value}
                  onClick={() => go(anchor, value)}
                  className={cn(
                    "rounded-full px-3.5 py-1.5 text-sm font-medium capitalize transition-all",
                    view === value
                      ? "bg-surface text-gray-900 shadow-sm"
                      : "text-gray-600 hover:text-gray-900",
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
        </section>

        {/* Rendered only when there is room, rather than hidden with CSS: a hidden copy
            of every meeting would still be in the accessibility tree twice over. */}
        {wide && (
          <aside
            className="order-3 max-h-[calc(100dvh-5.5rem)] self-start overflow-y-auto rounded-3xl app-lg:sticky app-lg:top-[4.5rem]"
            aria-label="Agenda"
          >
            <AgendaPanel
              day={anchor}
              meetings={meetings ?? []}
              onOpenMeeting={setEditing}
              onCreate={() => setCreatingOn(anchor)}
            />
          </aside>
        )}
      </div>

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

      {/* What the assistant proposes, shown on the real form. Read-only, and drawn from
          the proposal alone: the values it would save and the names it was given for the
          people on it. Keyed on the proposal, so a correction is a fresh form and not
          the old one with some fields changed. */}
      {assistant.staged && (
        <MeetingModal
          key={assistant.staged.id}
          open
          meeting={null}
          defaultDate={anchor}
          canManage
          draft={draftOf(assistant.staged)}
          staged={{ attendees: assistant.staged.labels.attendees ?? [] }}
          onClose={() => {}}
        />
      )}

      {/* The same proposal after Stop: an ordinary form, still filled, that the user
          finishes and saves as their own action. */}
      {takenOver && (
        <MeetingModal
          key={`taken-over-${takenOver.proposal.id}`}
          open
          meeting={takenOver.meeting}
          defaultDate={anchor}
          canManage
          draft={draftOf(takenOver.proposal)}
          onClose={() => setTakenOver(null)}
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
    // A container of its own: whether a chip has room for its time depends on how wide
    // the cells are, which the agenda panel changes without the app column changing.
    <div className="@container/month">
      <div className="grid grid-cols-7 border-b border-gray-100">
        {WEEKDAY_LABELS.map((label) => (
          <div
            key={label}
            className="px-2 py-2.5 text-center text-[11px] font-semibold tracking-wider text-gray-400 uppercase"
          >
            {label}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {weeks.flat().map((day) => {
          const dayMeetings = byDay.get(day.key) ?? [];
          const weekend = day.date.getDay() === 0 || day.date.getDay() === 6;

          return (
            <div
              key={day.key}
              className={cn(
                "group flex min-h-28 flex-col gap-1 border-r border-b border-gray-100 p-1.5 transition-colors [&:nth-child(7n)]:border-r-0",
                !day.inMonth
                  ? "bg-gray-50/80"
                  : day.isToday
                    ? "bg-lime-300/10"
                    : weekend && "bg-gray-50/40",
                "hover:bg-gray-50",
              )}
            >
              <button
                type="button"
                onClick={() => onOpenDay(day.date)}
                aria-label={`Open ${day.key}`}
                aria-current={day.isToday ? "date" : undefined}
                className={cn(
                  "grid size-7 place-items-center self-start rounded-full text-xs font-semibold tnum transition-colors",
                  day.isToday
                    ? "bg-lime-300 text-ink shadow-sm shadow-lime-500/30"
                    : day.inMonth
                      ? "text-gray-800 hover:bg-gray-900 hover:text-surface"
                      : "text-gray-400 hover:bg-gray-200",
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
                  className="self-start rounded-full px-1.5 text-left text-[11px] font-semibold text-gray-500 hover:bg-gray-900 hover:text-surface"
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
      // Named for the assistant, which tints a meeting for a moment after saving it.
      data-agent-record={`meeting:${meeting.id}`}
      onClick={() => onClick(meeting)}
      title={`${formatTime(meeting.start_time)} ${meeting.title}`}
      style={{ backgroundColor: meetingTint(meeting.color) }}
      className="flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[11px] ring-1 ring-gray-900/5 transition hover:-translate-y-px hover:shadow-sm"
    >
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: meeting.color }}
      />
      <span className="truncate font-medium text-gray-900">{meeting.title}</span>
      <span aria-hidden="true" className="ml-auto hidden shrink-0 text-[10px] text-gray-500 tnum @5xl/month:inline">
        {formatTime(meeting.start_time)}
      </span>
    </button>
  );
}

/**
 * Twelve small month grids, each day shaded by how much is on it.
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
    <div className="grid gap-3 p-3 app-sm:grid-cols-2 app-md:p-4 app-lg:grid-cols-3 app-xl:grid-cols-4">
      {yearGrid(anchor).map(({ month, weeks }) => {
        const total = weeks
          .flat()
          .filter((day) => day.inMonth)
          .reduce((sum, day) => sum + (byDay.get(day.key)?.length ?? 0), 0);
        return (
          <div
            key={month.getMonth()}
            className="rounded-2xl bg-gray-50/70 p-3 ring-1 ring-gray-100 transition hover:bg-surface hover:shadow-md hover:ring-gray-200"
          >
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-900">{MONTH_NAME.format(month)}</h3>
              {total > 0 && (
                <span
                  aria-hidden="true"
                  className="rounded-full bg-gray-900 px-2 py-0.5 text-[10px] font-semibold text-surface tnum"
                >
                  {total}
                </span>
              )}
            </div>

            <div className="grid grid-cols-7 gap-0.5 text-center">
              {WEEKDAY_LABELS.map((label) => (
                <span key={label} className="text-[9px] font-medium text-gray-400">
                  {label.charAt(0)}
                </span>
              ))}

              {weeks.flat().map((day) => {
                const count = byDay.get(day.key)?.length ?? 0;
                const busy = day.inMonth ? count : 0;
                return (
                  <button
                    key={day.key}
                    type="button"
                    onClick={() => onOpenDay(day.date)}
                    className={cn(
                      "flex aspect-square items-center justify-center rounded-lg text-[10px] font-medium tnum transition-colors",
                      day.isToday
                        ? "bg-lime-300 font-bold text-ink"
                        : !day.inMonth
                          ? "text-gray-300 hover:bg-gray-100"
                          : busy >= 3
                            ? "bg-brand-600 text-white hover:bg-brand-700"
                            : busy === 2
                              ? "bg-brand-500/45 text-gray-900 hover:bg-brand-500/60"
                              : busy === 1
                                ? "bg-brand-500/20 text-gray-900 hover:bg-brand-500/35"
                                : "text-gray-700 hover:bg-gray-200",
                    )}
                  >
                    {day.date.getDate()}
                    {/* Announced as well as drawn: a shade alone tells a screen reader
                        nothing, and this is the only signal the year view carries. */}
                    {count > 0 && (
                      <span className="sr-only">
                        {count} {count === 1 ? "meeting" : "meetings"}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A small month beside the main view, for jumping to any day without changing view.
 *
 * Its own month can be paged independently, so looking ahead does not move the main
 * view until a day is picked. Its buttons are named "Go to …" rather than "Open …",
 * which is the main month grid's wording and what its tests address it by.
 */
function MiniMonth({
  anchor,
  shown,
  byDay,
  onPick,
}: {
  anchor: Date;
  shown: Set<string>;
  byDay: Map<string, MeetingOut[]>;
  onPick: (day: Date) => void;
}) {
  const [month, setMonth] = useState(() => new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  const anchorKey = localDayKey(anchor);

  return (
    <section className="rounded-3xl bg-ink p-4 text-white shadow-lg shadow-ink/20 ring-1 ring-white/10">
      <div className="mb-3 flex items-center justify-between px-1">
        <p className="text-sm font-semibold">{MONTH_LABEL.format(month)}</p>
        <div className="flex gap-1">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => setMonth(addMonths(month, -1))}
            className="grid size-7 place-items-center rounded-full text-white/70 transition hover:bg-white/10 hover:text-white"
          >
            <ChevronIcon direction="left" />
          </button>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => setMonth(addMonths(month, 1))}
            className="grid size-7 place-items-center rounded-full text-white/70 transition hover:bg-white/10 hover:text-white"
          >
            <ChevronIcon direction="right" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-y-1 text-center">
        {WEEKDAY_LABELS.map((label) => (
          <span key={label} aria-hidden="true" className="pb-1 text-[10px] font-medium text-white/45">
            {label.slice(0, 2)}
          </span>
        ))}

        {monthGrid(month).flat().map((day) => {
          const inShown = shown.has(day.key);
          const hasMeetings = (byDay.get(day.key)?.length ?? 0) > 0;
          return (
            <button
              key={day.key}
              type="button"
              onClick={() => onPick(day.date)}
              aria-label={`Go to ${DAY_LABEL.format(day.date)}`}
              className={cn(
                "relative mx-auto grid size-8 place-items-center rounded-full text-xs tnum transition-colors",
                day.isToday
                  ? "bg-lime-300 font-bold text-ink"
                  : inShown
                    ? "bg-white/15 font-semibold text-white"
                    : day.inMonth
                      ? "text-white/85 hover:bg-white/10"
                      : "text-white/25 hover:bg-white/5",
                day.key === anchorKey && !day.isToday && "ring-1 ring-white/70",
              )}
            >
              {day.date.getDate()}
              {hasMeetings && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute bottom-1 size-1 rounded-full",
                    day.isToday ? "bg-ink" : "bg-lime-300",
                  )}
                />
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-24 rounded-2xl bg-surface/70 px-4 py-2 ring-1 ring-gray-900/5 backdrop-blur">
      <dt className="text-[11px] font-medium text-gray-500">{label}</dt>
      <dd className="text-xl font-semibold text-gray-900 tnum">{value}</dd>
    </div>
  );
}

function RoundButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-full bg-surface text-gray-700 shadow-sm ring-1 ring-gray-900/10 transition hover:bg-gray-900 hover:text-surface"
    >
      {children}
    </button>
  );
}

function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={direction === "left" ? "M10 3.5 5.5 8l4.5 4.5" : "M6 3.5 10.5 8 6 12.5"} />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3 text-ink" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  );
}

/**
 * The rendered width of an element, kept current.
 *
 * Reads 0 where `ResizeObserver` does not exist (jsdom, server rendering), which reads as
 * "narrow" — the layout every screen supports.
 */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** How many meetings are in view, and how long they add up to. */
function summarise(meetings: readonly MeetingOut[]): { count: number; minutes: number } {
  const minutes = meetings.reduce(
    (sum, meeting) =>
      sum + Math.max(0, (Date.parse(meeting.end_time) - Date.parse(meeting.start_time)) / 60_000),
    0,
  );
  return { count: meetings.length, minutes };
}

function formatHours(minutes: number): string {
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}

/**
 * The meeting form's values for a proposal.
 *
 * A new meeting's payload is the form. A change to a meeting carries only what changes,
 * so the server sends the whole form as it would be afterwards beside it, and the
 * attendee lists come from the change itself when the change touches them.
 */
function draftOf(proposal: Proposal): MeetingDraft {
  if (proposal.kind !== "meeting.update") return proposal.payload as MeetingDraft;
  const changes = (proposal.payload["changes"] ?? {}) as MeetingDraft;
  return {
    ...(proposal.labels.form as MeetingDraft | undefined),
    ...(changes.attendee_ids ? { attendee_ids: changes.attendee_ids } : {}),
    ...(changes.attendee_emails ? { attendee_emails: changes.attendee_emails } : {}),
  };
}
