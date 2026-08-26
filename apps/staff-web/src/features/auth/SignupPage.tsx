import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createUserWithEmailAndPassword, updateProfile } from "firebase/auth";
import { describeAuthError, getFirebaseAuth } from "@/auth/firebase";
import { useAuth } from "@/auth/useAuth";
import { Button } from "@/components/Button";
import { Alert } from "@/components/feedback";
import { Field, Input } from "@/components/form";
import { AuthLayout } from "./AuthLayout";
import { GoogleMark } from "./LoginPage";
import { signInWithGoogle } from "./googleSignIn";

/** Firebase's own minimum. Stated here so the message can be shown before the round
 *  trip rather than as an `auth/weak-password` error afterwards. */
const MIN_PASSWORD_LENGTH = 6;

export function SignupPage() {
  const navigate = useNavigate();
  const { setGoogleAccessToken } = useAuth();

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setMessage(`Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    setBusy(true);
    try {
      const credential = await createUserWithEmailAndPassword(
        getFirebaseAuth(),
        email.trim(),
        password,
      );

      // Set the display name before the profile is provisioned. `POST /auth/session`
      // reads it off the verified token to populate `profiles.full_name`, so doing
      // this after would leave the profile with a blank name until it was edited.
      const name = fullName.trim();
      if (name) await updateProfile(credential.user, { displayName: name });

      // AuthProvider's onIdTokenChanged listener handles provisioning from here.
      navigate("/", { replace: true });
    } catch (caught) {
      setMessage(describeAuthError(caught));
      setBusy(false);
    }
  }

  async function handleGoogle() {
    setMessage(null);
    setBusy(true);
    try {
      const { accessToken } = await signInWithGoogle();
      setGoogleAccessToken(accessToken);
      navigate("/", { replace: true });
    } catch (caught) {
      setMessage(describeAuthError(caught));
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Create your account"
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-brand-600 hover:text-brand-700">
            Sign in
          </Link>
        </>
      }
    >
      {message && <Alert tone="danger">{message}</Alert>}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field label="Full name">
          {(props) => (
            <Input
              {...props}
              autoComplete="name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
          )}
        </Field>

        <Field label="Email" required>
          {(props) => (
            <Input
              {...props}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>

        <Field label="Password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`} required>
          {(props) => (
            <Input
              {...props}
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>

        <Button type="submit" variant="primary" busy={busy} className="w-full">
          Create account
        </Button>
      </form>

      <div className="relative py-1">
        <div className="absolute inset-0 flex items-center" aria-hidden="true">
          <div className="w-full border-t border-gray-200" />
        </div>
        <div className="relative flex justify-center">
          <span className="bg-surface px-2 text-xs text-gray-400">or</span>
        </div>
      </div>

      <Button variant="secondary" onClick={handleGoogle} disabled={busy} className="w-full">
        <GoogleMark />
        Continue with Google
      </Button>
    </AuthLayout>
  );
}
