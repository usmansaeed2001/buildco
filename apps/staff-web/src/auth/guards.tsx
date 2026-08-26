/**
 * Route guards.
 *
 * These are navigation, not authorisation. The backend re-checks the role on every
 * request and is the only thing standing between a member and an admin action; these
 * exist so a member does not click into a page that would render nothing but 403s.
 */
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "./useAuth";
import { isElevated, type Role } from "@/domain/enums";
import { LoadingState } from "@/components/feedback";
import { isFirebaseConfigured } from "./firebase";

/** Requires a signed-in user with a provisioned profile. */
export function RequireAuth() {
  const { loading, firebaseUser, profile } = useAuth();
  const location = useLocation();

  if (!isFirebaseConfigured) return <Navigate to="/setup" replace />;
  if (loading) return <LoadingState label="Signing you in…" />;

  if (!firebaseUser) {
    // Remember where they were headed so sign-in can return them there rather than
    // dumping everyone on the launcher.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  // Signed in to Firebase but with no profile: provisioning failed. AuthProvider holds
  // the reason; the login screen renders it.
  if (!profile) return <Navigate to="/login" replace />;

  return <Outlet />;
}

/** Requires `owner` or `admin`. Mirrors the API's `Elevated` dependency. */
export function RequireElevated() {
  const { profile } = useAuth();

  if (!isElevated(profile?.role as Role | undefined)) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}

/** For `/login` and `/signup`: bounce an already-signed-in user to the app. */
export function RedirectIfSignedIn() {
  const { loading, firebaseUser, profile } = useAuth();

  // Without a web config there is nothing to sign in against, and letting the form
  // render would turn a missing .env.local into "Sign-in failed. Please try again." —
  // which sends the reader looking in entirely the wrong place.
  if (!isFirebaseConfigured) return <Navigate to="/setup" replace />;

  if (loading) return <LoadingState />;
  if (firebaseUser && profile) return <Navigate to="/" replace />;

  return <Outlet />;
}
