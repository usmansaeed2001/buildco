/**
 * The token from an invitation email, carried from the link to the sign-in.
 *
 * An admin adds someone to the team; the API emails them
 * `/signup?invite=<token>&email=<address>`. The token is what proves the person signing
 * up can read that mailbox — without it, an invitation could be claimed by anyone who
 * registered the invited address first. It has to reach `POST /auth/session`, which
 * `AuthProvider` makes, and that can be a page, a redirect, or a "wait, I already have a
 * password" detour to `/login` away from where the link landed.
 *
 * So it is lifted out of the URL once, at startup, and parked in `sessionStorage`:
 *
 * - **At startup, not in the sign-up page.** If the browser is already signed in to
 *   Firebase, `AuthProvider` posts the session before any route has rendered. Capturing
 *   in a page component would lose that race.
 * - **`sessionStorage`, not `localStorage`.** It should survive a reload or a hop to
 *   `/login` in this tab, and nothing else. It is a credential; it has no business
 *   outliving the tab.
 * - **Every access is guarded**, as in `lib/seen.ts`: storage throws in Safari private
 *   mode. Failing to remember the token costs the invitee a second click on the link;
 *   an unguarded throw here would cost them the whole app.
 */

const KEY = "buildco_invite_token";

/** Remember the `invite` parameter of the URL the app was opened with, if there is one. */
export function captureInviteFromUrl(search: string = window.location.search): void {
  const token = new URLSearchParams(search).get("invite");
  if (!token) return;
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    // Storage is unavailable. The sign-in proceeds without the token and the API
    // explains what to do.
  }
}

export function pendingInviteToken(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Call once a session has been established: the token is single-use and now spent. */
export function clearInviteToken(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clear if it could never be stored.
  }
}
