/**
 * An hour-by-hour grid, shared by the day and week views.
 *
 * One implementation, two column counts — a day is a week with a single column, and
 * building them separately is how the two drift until only one of them handles overlaps.
 *
 * Three things here are load-bearing:
 *
 * **All positioning goes through one `PIXELS_PER_MINUTE`.** Every `top`, every `height`,
 * and every pointer-offset-to-time conversion uses it, so the geometry cannot disagree
 * with itself. Change the constant and the whole grid rescales.
 *
 * **Overlap layout is not done here.** `assignColumns` in `domain/calendar.ts` is a pure
 * function with its own tests; this component only turns its output into percentages. A
 * layout bug is then reproducible without a DOM.
 *
 * **Drag is an accelerator, never the only way in.** The grid background is a stack of
 * real buttons, one per half hour, so Enter or Space creates a meeting at that time with
 * no pointer at all. Building it the other way round — a div that only responds to
 * pointermove — would make the calendar unusable by keyboard and unreliable on touch,
 * where a drag competes with scrolling.
 *
 * Those slots use a **roving tabindex**: exactly one is tabbable and the arrow keys move
 * between them, so the whole grid is a single tab stop. Making all 48 slots tabbable —
 * 336 across a week — would be technically accessible and practically unusable, and
 * would trap anyone tabbing toward the content below for a minute.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MeetingOut } from "@/api/types";
import {
  SLOT_MINUTES,
  assignColumns,
  localDayKey,
  minutesSinceMidnight,
  snapToSlot,
  startOfDay,
} from "@/domain/calendar";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";
import { AttendeeStack } from "./AttendeeStack";
import { meetingTint } from "./meetingStyle";

/** An hour is 64px tall. Everything else is derived from this. Exported so the tests
 *  turn times into pointer offsets the same way the grid does. */
export const HOUR_HEIGHT = 64;
export const PIXELS_PER_MINUTE = HOUR_HEIGHT / 60;
const DAY_HEIGHT = 24 * HOUR_HEIGHT;

/** Default length of a meeting created by a click rather than a drag. */
const DEFAULT_MINUTES = 60;

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

const SLOT_LABEL = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  hour: "numeric",
  minute: "2-digit",
});

interface Drag {
  dayKey: string;
  fromMinutes: number;
  toMinutes: number;
}

/** Which slot currently holds the grid's single tab stop. */
interface Cursor {
  dayIndex: number;
  minutes: number;
}

/** The hour the grid opens scrolled to, unless something on screen starts earlier. */
const FIRST_VISIBLE_HOUR = 8;

/** Below this a card has room for its title and time, but not for faces as well. */
const MINUTES_FOR_ATTENDEES = 60;

/** Half-hourly, not quarter-hourly: 48 arrow presses to cross a day is already plenty. */
const SLOT_STEP = 30;

export function TimeGrid({
  days,
  byDay,
  canCreate,
  onOpenMeeting,
  onCreateRange,
}: {
  days: readonly Date[];
  byDay: Map<string, MeetingOut[]>;
  canCreate: boolean;
  onOpenMeeting: (meeting: MeetingOut) => void;
  onCreateRange: (start: Date, end: Date) => void;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  // 9am, because that is where a working day starts and nobody wants to arrow down from
  // midnight. `moved` gates the focus effect so the grid never steals focus on mount.
  const [cursor, setCursor] = useState<Cursor>({ dayIndex: 0, minutes: 9 * 60 });
  const [moved, setMoved] = useState(false);

  function moveCursor(dayIndex: number, minutes: number) {
    setCursor({
      dayIndex: Math.min(days.length - 1, Math.max(0, dayIndex)),
      minutes: Math.min(24 * 60 - SLOT_STEP, Math.max(0, minutes)),
    });
    setMoved(true);
  }

  const now = useNow();
  const todayKey = localDayKey(now);

  // The grid is 24 hours tall and scrolls inside itself, so it opens on the working day
  // rather than on midnight — or earlier, if something on screen starts earlier, so an
  // early meeting is never scrolled out of sight on arrival.
  const scroller = useRef<HTMLDivElement>(null);
  const earliest = Math.min(
    FIRST_VISIBLE_HOUR * 60,
    ...days.flatMap((day) =>
      (byDay.get(localDayKey(day)) ?? []).map((meeting) => minutesSinceMidnight(meeting.start_time)),
    ),
  );
  const daysKey = days.map(localDayKey).join();
  useLayoutEffect(() => {
    if (scroller.current) {
      scroller.current.scrollTop = Math.max(0, (earliest - 30) * PIXELS_PER_MINUTE);
    }
    // Only when the days change: re-scrolling whenever a meeting is added would yank
    // the grid away from wherever the user had scrolled to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daysKey]);

  return (
    <div ref={scroller} className="max-h-[min(72vh,56rem)] overflow-auto">
      {/* A minimum width so a seven-column week stays legible on a phone and scrolls
          sideways instead of crushing each day to nothing. */}
      <div style={{ minWidth: days.length > 1 ? 720 : undefined }}>
        <div className="sticky top-0 z-30 flex gap-1.5 border-b border-gray-100 bg-surface/95 px-1.5 py-2 backdrop-blur">
          <div className="flex w-14 shrink-0 items-end justify-center pb-1">
            <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
              {zoneLabel(now)}
            </span>
          </div>
          {days.map((day) => {
            const isToday = localDayKey(day) === todayKey;
            const weekend = day.getDay() === 0 || day.getDay() === 6;
            return (
              <div
                key={localDayKey(day)}
                className={cn(
                  "flex flex-1 items-baseline justify-center gap-1.5 rounded-xl px-2 py-2 transition-colors",
                  isToday
                    ? "bg-lime-300 text-ink shadow-sm shadow-lime-500/20"
                    : weekend
                      ? "bg-gray-50 text-gray-500"
                      : "bg-gray-100/70 text-gray-900",
                )}
              >
                <p
                  className={cn(
                    "text-xs font-medium",
                    isToday ? "text-ink/70" : "text-gray-500",
                  )}
                >
                  {day.toLocaleDateString("en-US", { weekday: "short" })}
                </p>
                <p className="text-xl leading-none font-semibold tnum">{day.getDate()}</p>
              </div>
            );
          })}
        </div>

        <div className="flex" style={{ height: DAY_HEIGHT }}>
          <div className="w-14 shrink-0">
            {HOURS.map((hour) => (
              <div key={hour} style={{ height: HOUR_HEIGHT }} className="relative">
                {/* Nudged up so the label sits *on* the line rather than below it. */}
                <span className="absolute -top-2 right-2 text-[10px] font-medium text-gray-400 tnum">
                  {hour === 0 ? "" : `${((hour + 11) % 12) + 1} ${hour < 12 ? "AM" : "PM"}`}
                </span>
              </div>
            ))}
          </div>

          {days.map((day, dayIndex) => (
            <DayColumn
              key={localDayKey(day)}
              day={day}
              meetings={byDay.get(localDayKey(day)) ?? []}
              canCreate={canCreate}
              drag={drag?.dayKey === localDayKey(day) ? drag : null}
              onDrag={setDrag}
              onOpenMeeting={onOpenMeeting}
              onCreateRange={onCreateRange}
              cursor={cursor.dayIndex === dayIndex ? cursor.minutes : null}
              autoFocus={moved}
              onMove={(deltaDays, minutes) => moveCursor(dayIndex + deltaDays, minutes)}
              nowMinutes={localDayKey(day) === todayKey ? minutesSinceMidnight(now) : null}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function DayColumn({
  day,
  meetings,
  canCreate,
  drag,
  onDrag,
  onOpenMeeting,
  onCreateRange,
  cursor,
  autoFocus,
  onMove,
  nowMinutes,
}: {
  day: Date;
  meetings: MeetingOut[];
  canCreate: boolean;
  drag: Drag | null;
  onDrag: (drag: Drag | null) => void;
  onOpenMeeting: (meeting: MeetingOut) => void;
  onCreateRange: (start: Date, end: Date) => void;
  /** Minutes of the tabbable slot, or null when the cursor is on another day. */
  cursor: number | null;
  autoFocus: boolean;
  /** Days to step sideways, and the absolute minute the cursor should land on. */
  onMove: (deltaDays: number, minutes: number) => void;
  /** Where the current-time line goes, or null when this column is not today. */
  nowMinutes: number | null;
}) {
  const column = useRef<HTMLDivElement>(null);
  const placed = assignColumns(meetings);
  const dayKey = localDayKey(day);

  function minutesAt(clientY: number): number {
    const box = column.current?.getBoundingClientRect();
    if (!box) return 0;
    return snapToSlot((clientY - box.top) / PIXELS_PER_MINUTE);
  }

  function create(fromMinutes: number, toMinutes: number) {
    const start = startOfDay(day);
    start.setMinutes(Math.min(fromMinutes, toMinutes));
    const end = startOfDay(day);
    // A drag shorter than one slot is a click. Rather than creating a zero-length
    // meeting nobody can see, it opens the modal at a sensible default length — which is
    // also what makes a tap work on a phone, where a precise drag is awkward.
    const span = Math.abs(toMinutes - fromMinutes);
    end.setMinutes(Math.min(fromMinutes, toMinutes) + (span < SLOT_MINUTES ? DEFAULT_MINUTES : span));
    onCreateRange(start, end);
  }

  return (
    <div
      ref={column}
      className={cn(
        "relative flex-1 border-l border-gray-100",
        nowMinutes !== null
          ? "bg-lime-300/[0.07]"
          : (day.getDay() === 0 || day.getDay() === 6) && "bg-gray-50/70",
      )}
      // Without this the browser tries to scroll the page while a drag is in progress on
      // a touch screen, and the selection never gets its move events.
      style={{ touchAction: canCreate ? "none" : undefined }}
      onPointerDown={(event) => {
        // Only a bare background press starts a drag. A press on a meeting chip is that
        // chip's business, and a press with a non-primary button is not a drag at all.
        if (!canCreate || event.button > 0 || event.target !== event.currentTarget) return;
        const at = minutesAt(event.clientY);
        // Capture on the column, so a fast drag that leaves this narrow column — very
        // easy in a seven-day week — keeps tracking instead of stopping dead. Guarded
        // because jsdom does not implement it, and a drag that works everywhere except
        // the test suite is not worth the crash.
        event.currentTarget.setPointerCapture?.(event.pointerId);
        onDrag({ dayKey, fromMinutes: at, toMinutes: at });
      }}
      onPointerMove={(event) => {
        if (!drag) return;
        onDrag({ ...drag, toMinutes: minutesAt(event.clientY) });
      }}
      onPointerUp={(event) => {
        if (!drag) return;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        const finished = drag;
        onDrag(null);
        create(finished.fromMinutes, finished.toMinutes);
      }}
      onPointerCancel={() => onDrag(null)}
    >
      {/* Hour lines, and the keyboard route to creating a meeting. Half-hour buttons
          rather than quarter-hour ones: 48 tab stops per day is already a lot, and 96
          would make tabbing past the grid tedious. */}
      {HOURS.map((hour) => (
        <div
          key={hour}
          style={{ top: hour * HOUR_HEIGHT, height: HOUR_HEIGHT }}
          className="pointer-events-none absolute inset-x-0 border-t border-gray-100"
        >
          {/* The half-hour, fainter than the hour so the hour still reads as the unit. */}
          <span
            aria-hidden="true"
            style={{ top: HOUR_HEIGHT / 2 }}
            className="absolute inset-x-0 border-t border-dashed border-gray-100/80"
          />
          {canCreate &&
            [hour * 60, hour * 60 + SLOT_STEP].map((minutes) => (
              <SlotButton
                key={minutes}
                day={day}
                minutes={minutes}
                onCreateRange={onCreateRange}
                tabbable={cursor === minutes}
                autoFocus={autoFocus && cursor === minutes}
                onMove={onMove}
              />
            ))}
        </div>
      ))}

      {drag && (
        <div
          style={{
            top: Math.min(drag.fromMinutes, drag.toMinutes) * PIXELS_PER_MINUTE,
            height: Math.max(
              Math.abs(drag.toMinutes - drag.fromMinutes) * PIXELS_PER_MINUTE,
              2,
            ),
          }}
          className="pointer-events-none absolute inset-x-1 z-20 rounded-xl border-2 border-dashed border-brand-500 bg-brand-500/15"
        >
          <span className="px-2 text-[10px] font-semibold text-brand-700 dark:text-brand-300">
            {label(day, Math.min(drag.fromMinutes, drag.toMinutes))} –{" "}
            {label(day, Math.max(drag.fromMinutes, drag.toMinutes))}
          </span>
        </div>
      )}

      {nowMinutes !== null && (
        <div
          aria-hidden="true"
          style={{ top: nowMinutes * PIXELS_PER_MINUTE }}
          className="pointer-events-none absolute inset-x-0 z-20 flex -translate-y-1/2 items-center"
        >
          <span className="-ml-1.5 size-3 rounded-full bg-ink ring-2 ring-lime-300 dark:bg-lime-300 dark:ring-ink" />
          <span className="h-0.5 flex-1 bg-ink dark:bg-lime-300" />
        </div>
      )}

      {placed.map(({ item, column: index, columnCount }) => {
        const top = minutesSinceMidnight(item.start_time) * PIXELS_PER_MINUTE;
        const minutes =
          minutesSinceMidnight(item.end_time) - minutesSinceMidnight(item.start_time);
        // A 15-minute meeting is 16px tall, which is not enough to read or hit.
        const height = Math.max(minutes * PIXELS_PER_MINUTE, 22);
        const compact = minutes < 45;
        return (
          <button
            key={item.id}
            type="button"
            // Named for the assistant, which tints a meeting for a moment after saving it.
            data-agent-record={`meeting:${item.id}`}
            onClick={() => onOpenMeeting(item)}
            title={`${item.title} · ${formatTime(item.start_time)} – ${formatTime(item.end_time)}`}
            style={{
              // Inset by a hair on every side, so two meetings back to back read as two
              // cards and not one long one.
              top: top + 1,
              height: height - 2,
              left: `calc(${(index / columnCount) * 100}% + 3px)`,
              width: `calc(${(1 / columnCount) * 100}% - 6px)`,
              backgroundColor: meetingTint(item.color, 22),
            }}
            className={cn(
              "group absolute z-10 flex flex-col overflow-hidden rounded-xl pr-1.5 pl-3 text-left ring-1 ring-gray-900/5",
              "transition-[translate,box-shadow] duration-(--motion-fast) ease-(--ease-standard)",
              "hover:z-20 hover:-translate-y-px hover:shadow-md focus-visible:z-20",
              compact ? "justify-center py-0.5" : "gap-0.5 py-1.5",
            )}
          >
            <span
              aria-hidden="true"
              className="absolute inset-y-1.5 left-1 w-1 rounded-full"
              style={{ backgroundColor: item.color }}
            />
            <span className="block truncate text-xs font-semibold text-gray-900">
              {item.title}
            </span>
            {!compact && (
              <span className="block truncate text-[10px] font-medium text-gray-600 tnum">
                {formatTime(item.start_time)} – {formatTime(item.end_time)}
              </span>
            )}
            {minutes >= MINUTES_FOR_ATTENDEES && <AttendeeStack meeting={item} className="mt-auto" />}
          </button>
        );
      })}
    </div>
  );
}

/**
 * An invisible, focusable half-hour slot.
 *
 * This is the keyboard and screen-reader route to creating a meeting, and the reason
 * drag can stay a pure accelerator. It is visually nothing, but it is a real button with
 * a real name — "Create a meeting at 2:00 PM on Tuesday" — so it is reachable, operable,
 * and announced.
 */
function SlotButton({
  day,
  minutes,
  onCreateRange,
  tabbable,
  autoFocus,
  onMove,
}: {
  day: Date;
  minutes: number;
  onCreateRange: (start: Date, end: Date) => void;
  tabbable: boolean;
  autoFocus: boolean;
  onMove: (deltaDays: number, minutes: number) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const start = startOfDay(day);
  start.setMinutes(minutes);

  // Follows the cursor only once an arrow has actually been pressed — otherwise merely
  // rendering the calendar would yank focus out of whatever the user was doing.
  useEffect(() => {
    if (autoFocus) button.current?.focus();
  }, [autoFocus]);

  return (
    <button
      ref={button}
      type="button"
      tabIndex={tabbable ? 0 : -1}
      style={{ top: (minutes % 60) * PIXELS_PER_MINUTE, height: HOUR_HEIGHT / 2 }}
      className="pointer-events-auto absolute inset-x-0 transition-colors hover:bg-gray-100/60 focus-visible:bg-brand-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500"
      onKeyDown={(event) => {
        const moves: Record<string, [number, number]> = {
          ArrowDown: [0, SLOT_STEP],
          ArrowUp: [0, -SLOT_STEP],
          ArrowRight: [1, 0],
          ArrowLeft: [-1, 0],
        };
        const delta = moves[event.key];
        if (!delta) return;
        // The grid scrolls, and letting the arrow do both would move the cursor and the
        // viewport at once, losing the slot the user was aiming at.
        event.preventDefault();
        // Relative to *this* slot, not to the stored cursor. Normally identical, but they
        // diverge the moment focus arrives some other way, and a cursor that jumps
        // somewhere unrelated on the first arrow press is disorienting.
        onMove(delta[0], minutes + delta[1]);
      }}
      onClick={() => {
        const end = startOfDay(day);
        end.setMinutes(minutes + DEFAULT_MINUTES);
        onCreateRange(start, end);
      }}
    >
      <span className="sr-only">Create a meeting at {SLOT_LABEL.format(start)}</span>
    </button>
  );
}

function label(day: Date, minutes: number): string {
  const at = startOfDay(day);
  at.setMinutes(minutes);
  return at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** The time now, ticking once a minute: what the current-time line follows. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** "GMT-7", "GMT+5:30" — the offset the grid's hours are drawn in. */
function zoneLabel(at: Date): string {
  const offset = -at.getTimezoneOffset();
  const hours = Math.floor(Math.abs(offset) / 60);
  const minutes = Math.abs(offset) % 60;
  return `GMT${offset < 0 ? "-" : "+"}${hours}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}`;
}
