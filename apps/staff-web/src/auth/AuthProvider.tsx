/**
 * The session: Firebase identity plus the backend profile that authorises it.
 *
 * Two separate things, and conflating them is the mistake this file exists to prevent:
 *
 * - **Firebase** says *who you are*. It issues the ID token.
 * - **`profiles`** says *what you may do*. Role and status live in Postgres.
 *
 * `FIREBASE_SETUP.md` §9 is explicit that `profiles.role` is authoritative and the
 * Firebase custom claim is a convenience only, because a claim is stale until the
 * client refreshes its token — up to an hour. Reading the role from the claim would
 * leave a demoted admin with admin navigation for that window. So the role here always
 * comes from `GET /users/me`.
 */
import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  onIdTokenChanged,
  signOut as firebaseSignOut,
  type User as FirebaseUser,
} from "firebase/auth";
import { apiFetch, ApiError, configureApi } from "@/api/client";
import type { SessionOut, UserOut } from "@/api/types";
import { getFirebaseAuth, isFirebaseConfigured } from "./firebase";
import { clearInviteToken, pendingInviteToken } from "./invite";

export interface AuthState {
  /** Still resolving the initial session. Render nothing meaningful until false. */
  loading: boolean;
  firebaseUser: FirebaseUser | null;
  /** The backend profile. Null when signed out, or while provisioning. */
  profile: UserOut | null;
  /** Set when sign-in succeeded but the backend refused to provision a profile. */
  error: string | null;
  /** True on the very first sign-in for this identity — used to greet a new member. */
  isNewAccount: boolean;
  signOut: (options?: { keepError?: boolean }) => Promise<void>;
  /** Re-read `/users/me`, e.g. after editing your own profile. */
  refreshProfile: () => Promise<void>;
  /** Google OAuth access token carrying the Calendar scope. Memory only. */
  googleAccessToken: string | null;
  setGoogleAccessToken: (token: string | null) => void;
}

export const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [profile, setProfile] = useState<UserOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isNewAccount, setIsNewAccount] = useState(false);

  /**
   * The Google OAuth access token, held in a ref and mirrored into state.
   *
   * Deliberately never persisted. Firebase does not refresh it, so a stored copy goes
   * stale within the hour and the only symptom is meetings silently losing their Meet
   * link. Keeping it in memory means it is either fresh or absent, and absent is a
   * case the backend already handles.
   */
  const [googleAccessToken, setGoogleAccessToken] = useState<string | null>(null);

  /** Identities already provisioned this page-load, so a token refresh does not
   *  re-POST /auth/session. `onIdTokenChanged` fires on every refresh, not just
   *  sign-in. */
  const provisioned = useRef<Set<string>>(new Set());

  /**
   * `keepError` exists because of an ordering hazard.
   *
   * A rejected token calls `onUnauthorized`, which signs out. Sign-out awaits Firebase,
   * so its state updates land *after* the catch block that set the explanatory message
   * — and clearing the error there would wipe the only thing telling the user what
   * happened. The forced sign-out passes `keepError`; the menu's deliberate sign-out
   * does not, because then there is nothing to explain.
   */
  const signOut = useCallback(async (options?: { keepError?: boolean }) => {
    setGoogleAccessToken(null);
    provisioned.current.clear();
    if (isFirebaseConfigured) await firebaseSignOut(getFirebaseAuth());
    setProfile(null);
    setFirebaseUser(null);
    if (!options?.keepError) setError(null);
  }, []);

  // Wire the API client to this session. Done in an effect rather than at module load
  // so the client has no import-time dependency on Firebase — the public review page
  // must work with neither.
  useEffect(() => {
    configureApi({
      getToken: async () => {
        if (!isFirebaseConfigured) return null;
        const user = getFirebaseAuth().currentUser;
        // getIdToken() returns the cached token and refreshes it only when close to
        // expiry, so calling it per request is correct and cheap.
        return user ? user.getIdToken() : null;
      },
      onUnauthorized: () => {
        // The token was rejected. Almost always: the account was banned since it
        // was issued — the backend rechecks status per request, so this is
        // immediate. Keep any message the caller set explaining why.
        void signOut({ keepError: true });
      },
    });
  }, [signOut]);

  const refreshProfile = useCallback(async () => {
    const me = await apiFetch<UserOut>("/users/me");
    setProfile(me);
  }, []);

  useEffect(() => {
    if (!isFirebaseConfigured) {
      setLoading(false);
      return;
    }

    return onIdTokenChanged(getFirebaseAuth(), async (user) => {
      setFirebaseUser(user);

      if (!user) {
        setProfile(null);
        setLoading(false);
        return;
      }

      try {
        if (provisioned.current.has(user.uid)) {
          // A token refresh, not a new sign-in. The profile is already loaded.
          setLoading(false);
          return;
        }

        // Provision or link the profile. Idempotent: `created` is true only the first
        // time, and on an empty database the first caller becomes the owner.
        //
        // Someone who arrived by an invitation link sends its token along, which is
        // what lets the API hand them the profile — and role — an admin set up.
        const inviteToken = pendingInviteToken();
        const session = await apiFetch<SessionOut>("/auth/session", {
          method: "POST",
          ...(inviteToken ? { body: { invite_token: inviteToken } } : {}),
        });
        // Spent, whether or not it was needed. Left in place on failure, so a retry
        // after "that address is already registered — sign in instead" still carries it.
        clearInviteToken();
        provisioned.current.add(user.uid);
        setProfile(session.user);
        setIsNewAccount(session.created);
        setError(null);
      } catch (caught) {
        // Provisioning failed, so the user is authenticated with Firebase but has no
        // profile and cannot use the app. Every branch must leave a message behind:
        // without one the guard redirects to /login with the form cleared and nothing
        // explaining why, which is indistinguishable from "your password was wrong".
        setProfile(null);

        if (caught instanceof ApiError) {
          // 401 here means the backend rejected a token Firebase had just issued —
          // the account was banned, or the two disagree about the current time. Its
          // own message says "invalid or expired", so add the part it cannot know.
          setError(
            caught.status === 401
              ? `${caught.message} If this persists, check that this machine's clock is correct.`
              : caught.message,
          );
        } else {
          // Not an ApiError at all: the request never got a response. The API is down,
          // or the dev proxy has nothing to forward to.
          setError("Could not reach the server. Check that the API is running.");
        }
      } finally {
        setLoading(false);
      }
    });
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      loading,
      firebaseUser,
      profile,
      error,
      isNewAccount,
      signOut,
      refreshProfile,
      googleAccessToken,
      setGoogleAccessToken,
    }),
    [
      loading,
      firebaseUser,
      profile,
      error,
      isNewAccount,
      signOut,
      refreshProfile,
      googleAccessToken,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
