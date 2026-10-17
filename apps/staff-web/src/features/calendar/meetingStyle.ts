/**
 * How a meeting is drawn, shared by the month chips and the time-grid cards.
 *
 * A meeting's colour is chosen by whoever created it, from `MEETING_COLORS`, and is a
 * saturated hex. Filled at full strength it shouts and makes dark text unreadable, so it
 * is mixed into the surface instead. Mixing with `--color-surface` rather than white is
 * what makes the same tint work in dark mode: there it becomes a dark wash of the hue,
 * and `text-gray-900` (which inverts) stays readable on it.
 */
export function meetingTint(color: string, strength = 18): string {
  return `color-mix(in srgb, ${color} ${strength}%, var(--color-surface))`;
}
