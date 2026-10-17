/**
 * The faces on a meeting card. Split from `meetingStyle.ts` so this file exports only a
 * component, which is what fast refresh needs.
 */
import type { AttendeeOut, MeetingOut } from "@/api/types";
import { cn } from "@/lib/cn";

const AVATAR_TONES = [
  "bg-lime-300 text-ink",
  "bg-sky-200 text-ink",
  "bg-amber-200 text-ink",
  "bg-rose-200 text-ink",
  "bg-indigo-200 text-ink",
  "bg-emerald-200 text-ink",
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0]!.charAt(0) + (parts.length > 1 ? parts.at(-1)!.charAt(0) : "")).toUpperCase();
}

/** Stable per person, so someone keeps the same colour across every meeting. */
function toneFor(attendee: AttendeeOut): string {
  const seed = attendee.email || attendee.name;
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length]!;
}

/**
 * Up to three overlapping faces and a "+N".
 *
 * Decorative: hidden from assistive tech, because the meeting's button is named by its
 * title and the attendee list is read in full on the meeting's own form.
 */
export function AttendeeStack({
  meeting,
  max = 3,
  className,
}: {
  meeting: MeetingOut;
  max?: number;
  className?: string;
}) {
  const attendees = meeting.attendees ?? [];
  if (attendees.length === 0) return null;
  const shown = attendees.slice(0, max);
  const rest = attendees.length - shown.length;

  return (
    <span aria-hidden="true" className={cn("flex items-center -space-x-1.5", className)}>
      {shown.map((attendee) =>
        attendee.profile?.avatar_url ? (
          <img
            key={attendee.id}
            src={attendee.profile.avatar_url}
            alt=""
            className="size-5 rounded-full object-cover ring-2 ring-surface"
          />
        ) : (
          <span
            key={attendee.id}
            className={cn(
              "grid size-5 place-items-center rounded-full text-[8px] font-bold ring-2 ring-surface",
              toneFor(attendee),
            )}
          >
            {initials(attendee.name || attendee.email)}
          </span>
        ),
      )}
      {rest > 0 && (
        <span className="grid size-5 place-items-center rounded-full bg-gray-900 text-[8px] font-bold text-surface ring-2 ring-surface">
          +{rest}
        </span>
      )}
    </span>
  );
}
