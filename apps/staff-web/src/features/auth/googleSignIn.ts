import { GoogleAuthProvider, signInWithPopup } from "firebase/auth";
import { getFirebaseAuth, googleProvider } from "@/auth/firebase";

/**
 * Google sign-in, capturing the Calendar OAuth access token.
 *
 * The access token is only ever available here, in the credential returned by the
 * sign-in call itself — it is not part of the Firebase session and cannot be recovered
 * later. That is why it is lifted out at this exact moment and handed to `AuthProvider`
 * to hold in memory.
 *
 * It is what `POST /meetings` needs as `google_access_token` to create a Meet link,
 * replacing the `session.provider_token` the legacy Supabase client provided. A null
 * token is fine: the backend creates the meeting without a Meet link, which it treats
 * as a supported outcome rather than an error.
 */
export async function signInWithGoogle(): Promise<{ accessToken: string | null }> {
  const result = await signInWithPopup(getFirebaseAuth(), googleProvider());
  const credential = GoogleAuthProvider.credentialFromResult(result);
  return { accessToken: credential?.accessToken ?? null };
}
