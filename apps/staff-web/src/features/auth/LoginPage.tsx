import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { signInWithEmailAndPassword } from "firebase/auth";
import { apiFetch } from "@/api/client";
import type { AccountStatusOut } from "@/api/types";
import { describeAuthError, getFirebaseAuth } from "@/auth/firebase";
import { useAuth } from "@/auth/useAuth";
import { Button } from "@/components/Button";
import { Alert, LoadingState } from "@/components/feedback";
import { Field, Input } from "@/components/form";
import { AuthLayout } from "./AuthLayout";
import { signInWithGoogle } from "./googleSignIn";

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { error: sessionError } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);

  const destination = (location.state as { from?: string } | null)?.from ?? "/";

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setBlocked(false);
    setBusy(true);

    try {
      // Check for a removed account *before* attempting sign-in.
      //
      // This is public and unauthenticated by design (`GET /auth/status`). A banned
      // user would otherwise authenticate with Firebase successfully and then hit a
      // 401 on every API call with no explanation. Calling it also files an approval
      // request server-side, which is how the user gets back in — so this is part of
      // the flow, not just a nicety.
      const status = await apiFetch<AccountStatusOut>("/auth/status", {
        query: { email: email.trim() },
        anonymous: true,
      });

      if (status.status === "banned") {
        setBlocked(true);
        setBusy(false);
        return;
      }
    } catch {
      // Non-fatal: if the status check is unreachable, let the sign-in attempt
      // proceed. The backend still rejects a banned user on the first API call.
    }

    try {
      await signInWithEmailAndPassword(getFirebaseAuth(), email.trim(), password);
      navigate(destination, { replace: true });
    } catch (caught) {
      setMessage(describeAuthError(caught));
      setBusy(false);
    }
  }

  async function handleGoogle() {
    setMessage(null);
    setBlocked(false);
    setBusy(true);
    try {
      await signInWithGoogle();
      navigate(destination, { replace: true });
    } catch (caught) {
      setMessage(describeAuthError(caught));
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Sign in"
      footer={
        <>
            Need an account?{" "}
            <Link to="/signup" className="font-medium text-brand-600 dark:text-brand-300 hover:text-brand-700 hover:dark:text-brand-300">
              Create one
            </Link>
        </>
      }
    >
      {blocked && (
        <Alert tone="warning">
          Your access has been removed. An approval request has been sent to the team, and you will
          be notified once it is reviewed.
        </Alert>
      )}
      {sessionError && <Alert tone="danger">{sessionError}</Alert>}
      {message && <Alert tone="danger">{message}</Alert>}

      {/* While the sign-in is in flight the form is replaced outright rather than just
          disabled. Provisioning takes a few seconds, and leaving a filled-in form on
          screen reads as "nothing happened" — inviting a second submit. `busy` stays
          true through the redirect and is only cleared when sign-in fails. */}
      {busy ? (
        <LoadingState label="Signing you in…" />
      ) : (
        <>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
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

          <div className="flex flex-col gap-1.5">
            <Field label="Password" required>
              {(props) => (
                <Input
                  {...props}
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              )}
            </Field>
            <div className="text-right">
              <Link
                to="/forgot-password"
                className="text-xs font-medium text-brand-600 dark:text-brand-300 hover:text-brand-700 hover:dark:text-brand-300"
              >
                Forgot your password?
              </Link>
            </div>
          </div>

          <Button type="submit" variant="primary" className="w-full">
            Sign in
          </Button>
        </form>

        <Divider />

        <Button variant="secondary" onClick={handleGoogle} className="w-full">
          <GoogleMark />
          Continue with Google
        </Button>
        </>
      )}
    </AuthLayout>
  );
}

function Divider() {
  return (
    <div className="relative py-1">
      <div className="absolute inset-0 flex items-center" aria-hidden="true">
        <div className="w-full border-t border-gray-200" />
      </div>
      <div className="relative flex justify-center">
        <span className="bg-surface px-2 text-xs text-gray-400">or</span>
      </div>
    </div>
  );
}

export function GoogleMark() {
  return (
    <svg className="size-4" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1A12 12 0 0 0 12 24Z"
      />
      <path fill="#FBBC05" d="M5.4 14.4a7.2 7.2 0 0 1 0-4.6V6.7H1.4a12 12 0 0 0 0 10.8l4-3.1Z" />
      <path
        fill="#EA4335"
        d="M12 4.8c1.8 0 3.3.6 4.5 1.8l3.4-3.4A12 12 0 0 0 1.4 6.7l4 3.1C6.3 6.9 8.9 4.8 12 4.8Z"
      />
    </svg>
  );
}
