/**
 * The launcher — the React equivalent of `home.html`.
 *
 * Kept as the landing screen because it is what staff see first today and it costs one
 * click to preserve. The two cards carry their legacy colour coding: blue for
 * Supplements, green for Projects.
 */
import { Link } from "react-router-dom";
import { useAuth } from "@/auth/useAuth";

export function HomePage() {
  const { profile } = useAuth();
  const firstName = (profile?.full_name || profile?.email || "").split(/[\s@]/)[0] ?? "";

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 py-10">
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-gray-900">
          {firstName ? `Welcome back, ${firstName}.` : "Welcome back."}
        </h1>
        <p className="mt-1 text-sm text-gray-500">What would you like to work on today?</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <LauncherCard
          to="/estimates"
          title="Supplements"
          description="Build and submit restoration estimates."
          accent="text-brand-600"
          ring="hover:ring-brand-500/40"
          icon={
            <path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm7 1.5V8h3.5M9 12h6M9 16h6" />
          }
        />
        <LauncherCard
          to="/projects"
          title="Projects"
          description="Track jobs, milestones, and payments."
          accent="text-success-600"
          ring="hover:ring-success-500/40"
          icon={<path d="M3 9.5 12 4l9 5.5M5 11v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8M9.5 20v-6h5v6" />}
        />
      </div>
    </div>
  );
}

function LauncherCard({
  to,
  title,
  description,
  accent,
  ring,
  icon,
}: {
  to: string;
  title: string;
  description: string;
  accent: string;
  ring: string;
  icon: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      className={`group flex flex-col gap-3 rounded-card bg-surface p-6 ring-1 ring-gray-200 transition-all hover:-translate-y-0.5 hover:shadow-lg ${ring}`}
    >
      <svg
        className={`size-7 ${accent}`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {icon}
      </svg>
      <div>
        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        <p className="mt-0.5 text-sm text-gray-500">{description}</p>
      </div>
    </Link>
  );
}
