import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="font-display text-3xl font-semibold text-gray-900">Page not found</p>
      <p className="max-w-sm text-sm text-gray-500">
        The link may be out of date, or the page may have moved.
      </p>
      <Link
        to="/"
        className="mt-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
      >
        Go to the dashboard
      </Link>
    </main>
  );
}
