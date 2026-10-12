/**
 * Asking Google for calendar access, at the moment a Meet link is wanted.
 *
 * This is deliberately **not** part of sign-in. `calendar.events` is a sensitive scope,
 * and requesting it at the door is what once locked people out of the app — see
 * `googleProvider` in `./firebase`. Here it is asked for only when someone ticks "Add a
 * Google Meet link" on a new meeting, so a person who never wants one is never asked.
 *
 * It goes through Google Identity Services' token client rather than Firebase, for two
 * reasons. It has nothing to do with who is signed in to BuildCo, so someone using an
 * email and password can still pick a Google account to host the Meet. And it returns
 * exactly what `POST /meetings` needs — a short-lived access token — with no refresh
 * token to store.
 *
 * `VITE_GOOGLE_CLIENT_ID` is the OAuth **web client** of the Google Cloud project, and
 * every origin serving this app must be listed under its Authorised JavaScript origins.
 * Like the Firebase web config, it is an identifier, not a secret.
 */

const SCRIPT_SRC = "https://accounts.google.com/gsi/client";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

interface TokenResponse {
  access_token?: string;
  /** Seconds, as a string. */
  expires_in?: string | number;
  error?: string;
}

interface TokenClientConfig {
  client_id: string;
  scope: string;
  login_hint?: string;
  callback: (response: TokenResponse) => void;
  error_callback?: (error: { type?: string }) => void;
}

/** The slice of Google Identity Services this app uses. */
interface GoogleOAuth2 {
  initTokenClient: (config: TokenClientConfig) => { requestAccessToken: () => void };
  hasGrantedAllScopes: (response: TokenResponse, ...scopes: string[]) => boolean;
}

declare global {
  interface Window {
    google?: { accounts?: { oauth2?: GoogleOAuth2 } };
  }
}

/** Whether a build can offer Meet links at all. Without a client ID the option is hidden. */
export const isGoogleCalendarConfigured: boolean = Boolean(
  import.meta.env.VITE_GOOGLE_CLIENT_ID,
);

export interface CalendarToken {
  token: string;
  /** Epoch milliseconds. Google issues these for about an hour. */
  expiresAt: number;
}

/** Access was not obtained. The message is written to be shown to the person as is. */
export class CalendarAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarAccessError";
  }
}

const UNREACHABLE = "Could not reach Google. Check your connection and try again.";

let loading: Promise<void> | null = null;

/**
 * Load Google's script, once.
 *
 * Call this as soon as the option is on screen rather than when it is ticked: a popup
 * opened after waiting on a network request is one browsers are entitled to block.
 */
export function preloadGoogleIdentity(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();

  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      // Forgotten, so the next attempt tries again instead of failing for good.
      loading = null;
      script.remove();
      reject(new CalendarAccessError(UNREACHABLE));
    };
    document.head.append(script);
  });
  return loading;
}

/**
 * Ask for calendar access, opening Google's popup.
 *
 * `hint` is the address of the Google account to offer first. Pass it only when the
 * person is known to have one — hinting an address Google has never heard of sends them
 * to a sign-in page for an account that does not exist.
 */
export async function requestCalendarToken(
  options: { hint?: string } = {},
): Promise<CalendarToken> {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new CalendarAccessError("Google Meet links are not set up for this site.");
  }

  await preloadGoogleIdentity();
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) throw new CalendarAccessError(UNREACHABLE);

  return new Promise<CalendarToken>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: CALENDAR_SCOPE,
      ...(options.hint ? { login_hint: options.hint } : {}),
      callback: (response) => {
        // Google lets a person continue while leaving the permission unticked, which
        // comes back as a token that cannot create an event.
        if (
          response.error ||
          !response.access_token ||
          !oauth2.hasGrantedAllScopes(response, CALENDAR_SCOPE)
        ) {
          reject(
            new CalendarAccessError(
              "Google Calendar access was not granted, so no Meet link will be added.",
            ),
          );
          return;
        }
        resolve({
          token: response.access_token,
          expiresAt: Date.now() + (Number(response.expires_in) || 3600) * 1000,
        });
      },
      error_callback: (error) => {
        reject(
          new CalendarAccessError(
            error.type === "popup_failed_to_open"
              ? "Your browser blocked the Google window. Allow popups for this site and try again."
              : error.type === "popup_closed"
                ? "The Google window was closed before access was granted."
                : "Google Calendar access could not be requested. Try again.",
          ),
        );
      },
    });
    client.requestAccessToken();
  });
}
