/**
 * The assistant's icons: inline SVG on a 20px grid with a 1.6px stroke, matching the
 * ones already drawn in `AppShell` and `Modal`.
 *
 * Drawn here and not taken from an icon package, like everything else in the app. And
 * drawn at all, because a "✓" or a "•" typed as text is a different shape on every
 * platform.
 *
 * Every icon is decoration: the control or line it sits in carries the words.
 */
import type { ReactNode, SVGProps } from "react";
import { cn } from "@/lib/cn";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children">;

function icon(paths: ReactNode) {
  return function Icon({ className, ...rest }: IconProps) {
    return (
      <svg
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={cn("size-5 shrink-0", className)}
        {...rest}
      >
        {paths}
      </svg>
    );
  };
}

export const MicIcon = icon(
  <>
    <rect x="7.5" y="2.5" width="5" height="9" rx="2.5" />
    <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" />
  </>,
);

export const MicOffIcon = icon(
  <>
    <path d="M12.5 9V5a2.5 2.5 0 0 0-4.6-1.4M7.5 7.5V9a2.5 2.5 0 0 0 3.9 2.1" />
    <path d="M4.5 9.5a5.5 5.5 0 0 0 8.6 4.5M15.5 9.5c0 .7-.1 1.3-.4 1.9M10 15v2.5M3 3l14 14" />
  </>,
);

export const SpeakerIcon = icon(
  <>
    <path d="M3.5 8v4h2.5l3.5 3V5L6 8H3.5Z" />
    <path d="M12.5 7.5a3.5 3.5 0 0 1 0 5M14.5 5.5a6.5 6.5 0 0 1 0 9" />
  </>,
);

export const SpeakerOffIcon = icon(
  <>
    <path d="M3.5 8v4h2.5l3.5 3V5L6 8H3.5Z" />
    <path d="M13 8l4 4M17 8l-4 4" />
  </>,
);

export const CloseIcon = icon(<path d="M5 5l10 10M15 5L5 15" />);

export const ClockIcon = icon(
  <>
    <circle cx="10" cy="10" r="7" />
    <path d="M10 6v4l2.5 2" />
  </>,
);

export const CheckIcon = icon(<path d="M4.5 10.5l3.5 3.5 7.5-8" />);

export const CrossIcon = icon(<path d="M6 6l8 8M14 6l-8 8" />);

export const SendIcon = icon(<path d="M10 16V4M5 9l5-5 5 5" />);

export const ArrowDownIcon = icon(<path d="M10 4v12M5 11l5 5 5-5" />);

export const BackIcon = icon(<path d="M12 4.5L6.5 10l5.5 5.5" />);

/** Unfold the panel to fill a phone's screen. */
export const ExpandIcon = icon(<path d="M5 12.5l5-5 5 5" />);

/** Fold the panel down to a bar, to see the app. */
export const FoldIcon = icon(<path d="M5 7.5l5 5 5-5" />);

export const PauseIcon = icon(<path d="M7 5v10M13 5v10" />);

export const MailIcon = icon(
  <>
    <rect x="3" y="4.5" width="14" height="11" rx="2" />
    <path d="M3.5 6l6.5 5 6.5-5" />
  </>,
);

export const PadlockIcon = icon(
  <>
    <rect x="4.5" y="9" width="11" height="8" rx="2" />
    <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
  </>,
);

export const PointerIcon = icon(
  <path d="M5 3.5l10 5-4.2 1.3L9.5 14 5 3.5ZM11.5 11.5l3.5 4" />,
);

export const WarningIcon = icon(
  <>
    <path d="M10 3.5l7 12.5H3l7-12.5Z" />
    <path d="M10 8.5v3.5M10 14.2v.1" />
  </>,
);

export const ChatIcon = icon(
  <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3A1.5 1.5 0 0 1 4 11.5v-6Z" />,
);

export const CalendarIcon = icon(
  <>
    <rect x="3.5" y="4.5" width="13" height="12" rx="2" />
    <path d="M3.5 8.5h13M7 3v3M13 3v3" />
  </>,
);

export const DocumentIcon = icon(
  <>
    <path d="M6 3h5.5L15 6.5V16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
    <path d="M11.5 3v3.5H15M7.5 10.5h5M7.5 13.5h5" />
  </>,
);

export const BookmarkIcon = icon(<path d="M6 3.5h8v13l-4-3-4 3v-13Z" />);

export const TrashIcon = icon(
  <path d="M4 6h12M8 6V4h4v2M6 6l.7 10h6.6L14 6M8.5 9v4.5M11.5 9v4.5" />,
);

export const InfoIcon = icon(
  <>
    <circle cx="10" cy="10" r="7" />
    <path d="M10 9v4.5M10 6.5v.1" />
  </>,
);

/** A turning arc, for something in progress. The stylesheet turns it. */
export function ArcIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
      className={cn("ast-arc size-5 shrink-0", className)}
    >
      <path d="M10 3a7 7 0 0 1 7 7" />
    </svg>
  );
}

/** A check that draws itself, for something that has just been done. */
export function DrawnCheck({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("size-5 shrink-0", className)}
    >
      <path className="ast-draw" pathLength={1} d="M4.5 10.5l3.5 3.5 7.5-8" />
    </svg>
  );
}
