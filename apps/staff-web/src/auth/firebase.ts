/**
 * Firebase Auth setup.
 *
 * The web config is not secret — it identifies the project to Google's servers and is
 * visible in any browser's network tab by design. It lives in env vars only so the
 * same build can target a different project, not to keep it hidden.
 *
 * Register the web app under **Project settings → Your apps → Web** to obtain these
 * values, and add every origin that serves the app to **Authentication → Settings →
 * Authorized domains**. A missing authorized domain fails sign-in with an error that
 * does not mention domains at all.
 */
import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  type Auth,
  browserLocalPersistence,
  setPersistence,
} from "firebase/auth";

const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;
const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;

/**
 * Whether a usable config was supplied.
 *
 * Checked rather than assumed so a missing `.env.local` produces a clear setup message
 * instead of Firebase's `auth/invalid-api-key`, which reads like a broken deployment
 * rather than a first-run step. See `README.md` and `/setup`.
 *
 * `apiKey` and `projectId` are the two the SDK cannot start without; the rest are only
 * needed by products this app does not use (Storage, Messaging).
 */
export const isFirebaseConfigured: boolean = Boolean(apiKey && projectId);

let app: FirebaseApp | null = null;
let authInstance: Auth | null = null;

if (apiKey && projectId) {
  // Built inside the guard so the narrowed, definitely-present values are what reach
  // initializeApp. Optional entries are omitted rather than passed as undefined,
  // which `exactOptionalPropertyTypes` treats as a different thing from absent.
  app = initializeApp({
    apiKey,
    projectId,
    ...(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN
      ? { authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN }
      : {}),
    ...(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET
      ? { storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET }
      : {}),
    ...(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID
      ? { messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID }
      : {}),
    ...(import.meta.env.VITE_FIREBASE_APP_ID
      ? { appId: import.meta.env.VITE_FIREBASE_APP_ID }
      : {}),
  });
  authInstance = getAuth(app);
  // Survive a page reload. This is the SDK default, but stating it means a future
  // change to session-only persistence has to be deliberate.
  void setPersistence(authInstance, browserLocalPersistence);
}

/** The Auth instance. Throws when unconfigured — guard with `isFirebaseConfigured`. */
export function getFirebaseAuth(): Auth {
  if (!authInstance) {
    throw new Error(
      "Firebase is not configured. Copy .env.example to .env.local and fill in the " +
        "VITE_FIREBASE_* values from the Firebase console.",
    );
  }
  return authInstance;
}

/**
 * The Google provider used to **sign in**.
 *
 * Deliberately carries no scopes beyond the implicit `openid`/`email`/`profile`. Those
 * are non-sensitive, so the OAuth app needs no Google verification and can be published
 * without a review — which is the difference between every member signing in and only
 * the handful on the test-user allowlist.
 *
 * It used to request `calendar.events` here. That scope is *sensitive*, which pinned
 * the consent screen in Testing mode: a 100-user cap, an "unverified app" interstitial
 * on every sign-in, and refresh tokens that expire after seven days. The team's owner
 * signs in with Google and has no password, so that setting could lock the owner out of
 * their own workspace.
 *
 * The cost is that Google Meet links are no longer created: the access token that needed
 * came from this scope. Meetings and their calendar invites are unaffected. Restoring
 * Meet links means asking for `calendar.events` incrementally — at the point a meeting is
 * created, not at the door — rather than putting the sensitive scope back here.
 */
export function googleProvider(): GoogleAuthProvider {
  return new GoogleAuthProvider();
}


/** Turn a Firebase error code into something worth showing a person.
 *
 * The SDK's own messages leak internals ("Firebase: Error (auth/wrong-password)"), so
 * the common cases are mapped explicitly and anything unrecognised falls back to a
 * plain sentence rather than the raw code. */
export function describeAuthError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";

  switch (code) {
    case "auth/invalid-email":
      return "That email address is not valid.";
    case "auth/user-disabled":
      return "This account has been disabled. Contact your team's owner.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Email or password is incorrect.";
    case "auth/email-already-in-use":
      return "An account with that email already exists. Try signing in instead.";
    case "auth/weak-password":
      return "Choose a password of at least six characters.";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Sign-in was cancelled.";
    case "auth/popup-blocked":
      return "Your browser blocked the sign-in popup. Allow popups for this site and try again.";
    case "auth/unauthorized-domain":
      return "This site is not an authorized domain for sign-in. Add it in the Firebase console.";
    case "auth/network-request-failed":
      return "Could not reach the authentication service. Check your connection.";
    case "auth/too-many-requests":
      return "Too many attempts. Wait a moment and try again.";
    default:
      return "Sign-in failed. Please try again.";
  }
}
