import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "success";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-700 disabled:hover:bg-brand-600",
  secondary:
    "bg-surface text-gray-700 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 disabled:hover:bg-surface",
  ghost: "text-gray-600 hover:bg-gray-100 hover:text-gray-900 disabled:hover:bg-transparent",
  danger: "bg-danger-600 text-white hover:bg-danger-500 disabled:hover:bg-danger-600",
  success: "bg-success-600 text-white hover:bg-success-700 disabled:hover:bg-success-600",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5",
  md: "h-9 px-4 text-sm gap-2",
};

const BASE =
  "inline-flex items-center justify-center rounded-md font-medium transition-colors " +
  "disabled:opacity-50 disabled:cursor-not-allowed select-none whitespace-nowrap";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Shows a spinner and disables the button. Use for in-flight mutations. */
  busy?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  busy = false,
  disabled,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || busy}
      // Tells assistive tech the control is working, which a spinner alone does not.
      aria-busy={busy || undefined}
      className={cn(BASE, VARIANTS[variant], SIZES[size], className)}
      {...rest}
    >
      {busy && <Spinner className="size-3.5" />}
      {children}
    </button>
  );
}

/** A link styled as a button. Keeps navigation as a real anchor, so middle-click and
 *  "open in new tab" work — which they do not on a button with an onClick. */
export function LinkButton({
  to,
  variant = "secondary",
  size = "md",
  className,
  children,
}: {
  to: string;
  variant?: Variant;
  size?: Size;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link to={to} className={cn(BASE, VARIANTS[variant], SIZES[size], className)}>
      {children}
    </Link>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn("animate-spin", className ?? "size-4")}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"
      />
    </svg>
  );
}
