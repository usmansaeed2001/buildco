/**
 * Routes.
 *
 * Everything is a real URL, which the legacy app had none of — opening an estimate
 * there did not change the address bar, so a refresh dumped you back on the list.
 * Filter and tab state live in the query string for the same reason.
 *
 * The one structural rule: `/review/:token` sits **outside** every guard. It is opened
 * by external reviewers from an email, who have no account and never will. Putting it
 * under `RequireAuth` would redirect them to a login screen they cannot pass.
 */
import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { RedirectIfSignedIn, RequireAuth, RequireElevated } from "@/auth/guards";
import { LoginPage } from "@/features/auth/LoginPage";
import { SignupPage } from "@/features/auth/SignupPage";
import { ForgotPasswordPage } from "@/features/auth/ForgotPasswordPage";
import { SetupPage } from "@/features/auth/SetupPage";
import { HomePage } from "@/features/home/HomePage";
import { NotFoundPage } from "@/features/home/NotFoundPage";
import { EstimatesListPage } from "@/features/estimates/EstimatesListPage";
import { EstimateEditorPage } from "@/features/estimates/EstimateEditorPage";
import { ReviewPage } from "@/features/review/ReviewPage";
import { ProjectsListPage } from "@/features/projects/ProjectsListPage";
import { ProjectDetailPage } from "@/features/projects/ProjectDetailPage";
import { CalendarPage } from "@/features/calendar/CalendarPage";
import { TeamPage } from "@/features/team/TeamPage";
import { ProfilePage } from "@/features/profile/ProfilePage";
import { SettingsPage } from "@/features/settings/SettingsPage";

export const router = createBrowserRouter([
  // ── Public ────────────────────────────────────────────────────────────────
  { path: "/setup", element: <SetupPage /> },

  // Outside every guard, and outside AppShell. Reviewers arrive from an email with no
  // account and never will have one; RequireAuth would bounce them to a login screen
  // they cannot pass, which is exactly where every emailed link used to land.
  { path: "/review/:token", element: <ReviewPage /> },

  {
    element: <RedirectIfSignedIn />,
    children: [
      { path: "/login", element: <LoginPage /> },
      { path: "/signup", element: <SignupPage /> },
      { path: "/forgot-password", element: <ForgotPasswordPage /> },
    ],
  },

  // ── Authenticated ─────────────────────────────────────────────────────────
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppShell />,
        children: [
          { path: "/", element: <HomePage /> },

          { path: "/estimates", element: <EstimatesListPage /> },
          { path: "/estimates/:estimateId", element: <EstimateEditorPage /> },
          { path: "/projects", element: <ProjectsListPage /> },
          { path: "/projects/:projectId", element: <ProjectDetailPage /> },
          { path: "/calendar", element: <CalendarPage /> },
          { path: "/profile", element: <ProfilePage /> },
          { path: "/settings", element: <SettingsPage /> },

          {
            element: <RequireElevated />,
            children: [{ path: "/team", element: <TeamPage /> }],
          },
        ],
      },
    ],
  },

  // The assistant in every state, drawn from fixed values: how its look is reviewed
  // without holding a conversation. Development only. `import.meta.env.DEV` is a
  // constant in a production build, so the route and everything it imports are left
  // out of the bundle. It is outside the guards because it shows no real data.
  ...(import.meta.env.DEV
    ? [
        {
          path: "/dev/assistant",
          lazy: async () => ({
            Component: (await import("@/features/agent/AgentGallery")).AgentGallery,
          }),
        },
        {
          path: "/dev/calendar",
          lazy: async () => ({
            Component: (await import("@/features/calendar/CalendarGallery")).CalendarGallery,
          }),
        },
      ]
    : []),

  { path: "/index.html", element: <Navigate to="/login" replace /> },
  { path: "*", element: <NotFoundPage /> },
]);
