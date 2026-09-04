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
import { useEffect, useRef, useState } from "react";
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

/** An hour is 48px tall. Everything else is derived from this. */
const HOUR_HEIGHT = 48;
const PIXELS_PER_MINUTE = HOUR_HEIGHT / 60;
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

  return (
    <div className="overflow-x-auto rounded-md bg-surface ring-1 ring-gray-200">
      {/* A minimum width so a seven-column week stays legible on a phone and scrolls
          sideways instead of crushing each day to nothing. */}
      <div style={{ minWidth: days.length > 1 ? 640 : undefined }}>
        <div className="flex border-b border-gray-200">
          <div className="w-14 shrink-0" />
          {days.map((day) => (
            <div key={localDayKey(day)} className="flex-1 px-2 py-2 text-center">
              <p className="text-xs text-gray-500">
                {day.toLocaleDateString("en-US", { weekday: "short" })}
              </p>
              <p
                className={cn(
                  "text-sm font-semibold",
                  localDayKey(day) === localDayKey(new Date())
                    ? "text-brand-700"
                    : "text-gray-900",
                )}
              >
                {day.getDate()}
              </p>
            </div>
          ))}
        </div>

        <div className="flex" style={{ height: DAY_HEIGHT }}>
          <div className="w-14 shrink-0">
            {HOURS.map((hour) => (
              <div
                key={hour}
                style={{ height: HOUR_HEIGHT }}
                className="relative border-r border-gray-200"
              >
                {/* Nudged up so the label sits *on* the line rather than below it. */}
                <span className="absolute -top-2 right-1 text-[10px] text-gray-400">
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
      className="relative flex-1 border-r border-gray-100 last:border-r-0"
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
          className="pointer-events-none absolute inset-x-1 z-20 rounded border border-dashed border-brand-500 bg-brand-500/20"
        >
          <span className="px-1 text-[10px] font-medium text-brand-700">
            {label(day, Math.min(drag.fromMinutes, drag.toMinutes))} –{" "}
            {label(day, Math.max(drag.fromMinutes, drag.toMinutes))}
          </span>
        </div>
      )}

      {placed.map(({ item, column: index, columnCount }) => {
        const top = minutesSinceMidnight(item.start_time) * PIXELS_PER_MINUTE;
        const minutes =
          minutesSinceMidnight(item.end_time) - minutesSinceMidnight(item.start_time);
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onOpenMeeting(item)}
            style={{
              top,
              // A 15-minute meeting is 12px tall, which is not enough to read or hit.
              height: Math.max(minutes * PIXELS_PER_MINUTE, 18),
              left: `${(index / columnCount) * 100}%`,
              width: `${(1 / columnCount) * 100}%`,
              borderLeftColor: item.color,
            }}
            className="absolute z-10 overflow-hidden rounded-r border-l-4 bg-gray-50 px-1.5 py-0.5 text-left ring-1 ring-gray-200 hover:bg-gray-100"
          >
            <span className="block truncate text-xs font-medium text-gray-900">{item.title}</span>
            <span className="block truncate text-[10px] text-gray-500">
              {formatTime(item.start_time)}
            </span>
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
      className="pointer-events-auto absolute inset-x-0 focus-visible:bg-brand-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500"
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
