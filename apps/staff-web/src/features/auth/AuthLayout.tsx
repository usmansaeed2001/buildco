import type { ReactNode } from "react";

/**
 * The shell for the signed-out screens.
 *
 * The legacy `index.html` was a dark split layout with a marketing panel; this is the
 * same information in the app's own light palette, so signing in and using the app no
 * longer look like two different products. See `src/styles/index.css`.
 */
export function AuthLayout({
  title,
  subtitle,
  footer,
  children,
}: {
  title: string;
  subtitle?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center gap-2 text-center">
          <BrandMark />
          <h1 className="font-display text-xl font-semibold text-gray-900">{title}</h1>
          {subtitle && <p className="text-sm text-gray-500">{subtitle}</p>}
        </div>

        <div className="flex flex-col gap-4 rounded-card bg-surface p-6 ring-1 ring-gray-200">
          {children}
        </div>

        {footer && <p className="mt-5 text-center text-sm text-gray-500">{footer}</p>}
      </div>
    </main>
  );
}

export function BrandMark() {
  return (
    <div className="flex items-center gap-2">
      <span className="size-2.5 rounded-full bg-brand-500" aria-hidden="true" />
      <span className="font-display text-lg font-bold tracking-tight text-gray-900">BuildCo</span>
    </div>
  );
}
