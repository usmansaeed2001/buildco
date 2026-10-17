/**
 * The calendar, drawn from fixed meetings: how its look is reviewed without a backend.
 *
 * `/dev/calendar` renders the real `CalendarPage` — every view, the modal, the scope
 * control — against a week of sample meetings placed around today. Requests for meetings
 * and users are answered in the browser; anything else (saving, say) goes to the network
 * as usual and fails without an API, which is fine for looking.
 *
 * Development only. The route is not registered in a production build, so none of this
 * is shipped.
 */
import { useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AttendeeOut, MeetingOut, UserOut } from "@/api/types";
import { AuthContext, type AuthState } from "@/auth/AuthProvider";
import { ToastProvider } from "@/components/Toast";
import { addDays, startOfDay } from "@/domain/calendar";
import { CalendarPage } from "./CalendarPage";

const OWNER = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "owner@buildco.test",
  full_name: "Casey Owner",
  role: "owner",
} as unknown as UserOut;

const PEOPLE = ["Alex Rivera", "Jordan Lee", "Priya Shah", "Sam Carter", "Mia Chen", "Noah Patel"];

function attendees(count: number): AttendeeOut[] {
  return PEOPLE.slice(0, count).map(
    (name, index) =>
      ({
        id: `a-${index}`,
        name,
        email: `${name.split(" ")[0]!.toLowerCase()}@buildco.test`,
        user_id: null,
        profile: null,
      }) as unknown as AttendeeOut,
  );
}

/** Day offset from today, start hour, length in minutes, title, colour, people. */
const PLAN: [number, number, number, string, string, number][] = [
  [0, 9, 60, "Site walkthrough", "#10B981", 3],
  [0, 11, 30, "Supplier call", "#3B82F6", 0],
  [0, 14, 90, "Kitchen remodel review", "#8B5CF6", 5],
  [-1, 8, 60, "Morning crew huddle", "#84CC16", 4],
  [-1, 13, 120, "Insurance adjuster visit", "#F59E0B", 2],
  [1, 10, 60, "Client sign-off", "#EC4899", 2],
  [1, 10, 45, "Permit check", "#06B6D4", 0],
  [1, 15, 60, "Estimate review", "#3B82F6", 3],
  [2, 9, 180, "Roof inspection", "#EF4444", 4],
  [2, 16, 30, "Quick sync", "#6366F1", 1],
  [-2, 12, 60, "Lunch with architect", "#F97316", 1],
  [3, 11, 60, "Drywall delivery", "#10B981", 0],
  [-3, 10, 60, "Payment milestone", "#84CC16", 2],
  [5, 9, 60, "Weekly planning", "#8B5CF6", 6],
  [8, 14, 60, "Final walkthrough", "#EC4899", 3],
  [-9, 10, 60, "Kickoff", "#3B82F6", 4],
  [12, 9, 60, "Inspection", "#F59E0B", 2],
];

function buildMeetings(): MeetingOut[] {
  const today = startOfDay(new Date());
  return PLAN.map(([offset, hour, minutes, title, color, people], index) => {
    const start = addDays(today, offset);
    start.setHours(hour, 0, 0, 0);
    const end = new Date(start.getTime() + minutes * 60_000);
    return {
      id: `m-${index}`,
      title,
      description: "",
      location: "",
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      color,
      meet_link: null,
      project_id: null,
      created_by: OWNER.id,
      creator: null,
      attendees: attendees(people),
      created_at: start.toISOString(),
      updated_at: start.toISOString(),
    } as MeetingOut;
  });
}

const AUTH: AuthState = {
  loading: false,
  firebaseUser: null,
  profile: OWNER,
  error: null,
  isNewAccount: false,
  signOut: async () => {},
  refreshProfile: async () => {},
  googleAccessToken: null,
  googleCalendarAvailable: false,
  requestGoogleCalendarAccess: async () => {
    throw new Error("Not available in the gallery.");
  },
};

/** Answers meeting and user reads in the browser for as long as the gallery is open. */
function useFixtureFetch(meetings: MeetingOut[]) {
  useEffect(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url, location.origin);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.pathname.endsWith("/meetings")) {
        const from = Date.parse(url.searchParams.get("from") ?? "");
        const to = Date.parse(url.searchParams.get("to") ?? "");
        const within = meetings.filter((meeting) => {
          const at = Date.parse(meeting.start_time);
          return (Number.isNaN(from) || at >= from) && (Number.isNaN(to) || at < to);
        });
        return Response.json(within);
      }
      if (method === "GET" && url.pathname.endsWith("/users")) return Response.json([OWNER]);
      return original(input, init);
    };
    return () => {
      window.fetch = original;
    };
  }, [meetings]);
}

export function CalendarGallery() {
  const meetings = useMemo(buildMeetings, []);
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (document.documentElement.dataset["theme"] as "light" | "dark" | undefined) ?? "light",
  );
  useFixtureFetch(meetings);

  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
  }, [theme]);

  return (
    <QueryClientProvider client={client}>
      <AuthContext.Provider value={AUTH}>
        <ToastProvider>
          <div className="min-h-screen bg-canvas">
            <div className="flex items-center justify-between border-b border-gray-200 bg-surface px-6 py-2 text-xs text-gray-500">
              <span>Calendar gallery — sample data, development only</span>
              <button
                type="button"
                onClick={() => setTheme(theme === "light" ? "dark" : "light")}
                className="rounded-full px-3 py-1 font-medium ring-1 ring-gray-300 hover:bg-gray-100"
              >
                {theme === "light" ? "Dark" : "Light"} theme
              </button>
            </div>
            {/* The page's `app-*` breakpoints ask this container, as they ask AppFrame's,
                and the main column is AppShell's own width and padding. */}
            <div className="@container/app">
              <main className="mx-auto w-full max-w-[1600px] px-4 pt-6 pb-10 app-sm:px-6">
                <CalendarPage />
              </main>
            </div>
          </div>
        </ToastProvider>
      </AuthContext.Provider>
    </QueryClientProvider>
  );
}
