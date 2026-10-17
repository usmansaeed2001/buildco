/**
 * A team member's face, at the larger sizes the Team page uses.
 *
 * A photo goes through the shared `Avatar`, which also opens it full size. Without one,
 * `Avatar` draws a single letter in a fixed small type size on the brand tint, which is
 * lost at 48px and makes every face the same colour; here it is two initials on a tone
 * picked from the person's address, so someone keeps the same colour every time.
 */
import { Avatar } from "@/components/AppShell";
import { cn } from "@/lib/cn";

const TONES = [
  "bg-lime-300",
  "bg-sky-200",
  "bg-amber-200",
  "bg-rose-200",
  "bg-indigo-200",
  "bg-emerald-200",
];

const TEXT_SIZE = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-lg",
  xl: "text-2xl",
} as const;

const BOX_SIZE = {
  sm: "size-9",
  md: "size-12",
  lg: "size-14",
  xl: "size-18",
} as const;

export function PersonAvatar({
  name,
  seed,
  url,
  size = "md",
  muted = false,
  className,
}: {
  name: string;
  /** What picks the tone: the email, which never changes, rather than the name. */
  seed: string;
  url?: string | null | undefined;
  size?: keyof typeof BOX_SIZE;
  /** Greyed, for someone who has been removed. */
  muted?: boolean;
  className?: string;
}) {
  if (url) {
    return (
      <span className={cn("shrink-0 rounded-full", muted && "opacity-50 grayscale", className)}>
        <Avatar url={url} name={name} size={BOX_SIZE[size]} viewable />
      </span>
    );
  }

  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0;

  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-display font-semibold",
        BOX_SIZE[size],
        TEXT_SIZE[size],
        muted ? "bg-gray-200 text-gray-500" : cn(TONES[Math.abs(hash) % TONES.length], "text-ink"),
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

function initials(name: string): string {
  // An invitee with no name yet is shown by address; its first letter is the useful one.
  const words = (name.includes("@") ? name.split("@")[0]! : name).split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]!.charAt(0);
  const last = words.length > 1 ? words.at(-1)!.charAt(0) : "";
  return (first + last).toUpperCase();
}
