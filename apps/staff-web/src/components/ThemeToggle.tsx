/**
 * The header's light/dark switch.
 *
 * A single button rather than a three-way control, because the third state — "follow the
 * OS" — is the default nobody has to ask for, and it is only interesting once you have
 * left it. So the button is a plain flip, and getting back to the OS lives in the account
 * menu next to the other account-shaped settings (`AppShell`).
 *
 * The icon shows the theme you would *switch to*, not the one you are in. Both readings
 * are defensible and neither is guessable from an icon alone, so the accessible name and
 * the tooltip say it in words.
 */
import { cn } from "@/lib/cn";
import { toggleTheme } from "@/lib/theme";
import { useTheme } from "@/lib/useTheme";

export function ThemeToggle({ className }: { className?: string }) {
  const theme = useTheme();
  const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
      className={cn(
        "rounded-md p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900",
        className,
      )}
    >
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="size-5">
      <circle cx="10" cy="10" r="3.6" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M10 1.8v1.6M10 16.6v1.6M18.2 10h-1.6M3.4 10H1.8M15.8 4.2l-1.1 1.1M5.3 14.7l-1.1 1.1M15.8 15.8l-1.1-1.1M5.3 5.3 4.2 4.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="size-5">
      <path
        d="M16.5 12.4A7 7 0 0 1 7.6 3.5a7 7 0 1 0 8.9 8.9Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
