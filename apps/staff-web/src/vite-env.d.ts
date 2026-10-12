/// <reference types="vite/client" />

/** Typed env vars, so a missing one is a compile error rather than `undefined` at
 *  runtime. Everything is optional except by convention — Vite inlines whatever is
 *  present at build time and leaves the rest `undefined`. */
interface ImportMetaEnv {
  /** Overrides the same-origin `/api/v1` default. Only needed to point a local build
   *  at a remote backend; a normal deploy does not set it. */
  readonly VITE_API_BASE_URL?: string;

  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET?: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;

  /** OAuth web client used to ask for Google Calendar access when a Meet link is
   *  wanted. Unset hides the option; see `auth/googleCalendarAccess.ts`. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
