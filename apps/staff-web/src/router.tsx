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
import { SetupPage } from "@/features/auth/SetupPage";
import { HomePage } from "@/features/home/HomePage";
import { NotFoundPage } from "@/features/home/NotFoundPage";
import { EstimatesListPage } from "@/features/estimates/EstimatesListPage";
import { EstimateEditorPage } from "@/features/estimates/EstimateEditorPage";

export const router = createBrowserRouter([
  // ── Public ────────────────────────────────────────────────────────────────
  { path: "/setup", element: <SetupPage /> },

  {
    element: <RedirectIfSignedIn />,
    children: [
      { path: "/login", element: <LoginPage /> },
      { path: "/signup", element: <SignupPage /> },
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

          // Placeholders until each stage lands. Listed rather than omitted so the
          // navigation is never a dead link.
          { path: "/estimates", element: <EstimatesListPage /> },
          { path: "/estimates/:estimateId", element: <EstimateEditorPage /> },
          { path: "/projects", element: <Pending title="Projects" /> },
          { path: "/projects/:projectId", element: <Pending title="Project detail" /> },
          { path: "/calendar", element: <Pending title="Calendar" /> },
          { path: "/profile", element: <Pending title="Profile" /> },
          { path: "/settings", element: <Pending title="Settings" /> },

          {
            element: <RequireElevated />,
            children: [{ path: "/team", element: <Pending title="Team" /> }],
          },
        ],
      },
    ],
  },

  { path: "/index.html", element: <Navigate to="/login" replace /> },
  { path: "*", element: <NotFoundPage /> },
]);

function Pending({ title }: { title: string }) {
  return (
    <div className="rounded-card bg-surface px-6 py-16 text-center ring-1 ring-gray-200">
      <p className="font-medium text-gray-900">{title}</p>
      <p className="mt-1 text-sm text-gray-500">This screen is not built yet.</p>
    </div>
  );
}
