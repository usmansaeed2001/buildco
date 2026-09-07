import { signInWithPopup } from "firebase/auth";
import { getFirebaseAuth, googleProvider } from "@/auth/firebase";

/**
 * Google sign-in.
 *
 * Requests no scopes beyond the non-sensitive defaults, so it works for every member
 * without the OAuth app being verified and without each account being added to the
 * test-user allowlist. See `googleProvider` for why that matters.
 *
 * It used to also lift the Calendar OAuth access token out of the returned credential
 * and hand it to `AuthProvider`, which is what `POST /meetings` used to attach a Google
 * Meet link. That token came from the `calendar.events` scope, and requesting it here is
 * exactly what locked six people — including the workspace owner — out of signing in.
 * Meet links are off until Calendar access is asked for separately, at the point a
 * meeting is created. Meetings and their invites are unaffected.
 */
export async function signInWithGoogle(): Promise<void> {
  await signInWithPopup(getFirebaseAuth(), googleProvider());
}
