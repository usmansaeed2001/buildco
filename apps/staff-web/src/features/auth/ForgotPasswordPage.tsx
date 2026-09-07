import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { sendPasswordResetEmail } from "firebase/auth";
import { describeAuthError, getFirebaseAuth } from "@/auth/firebase";
import { Button } from "@/components/Button";
import { Alert } from "@/components/feedback";
import { Field, Input } from "@/components/form";
import { AuthLayout } from "./AuthLayout";

/**
 * Request a password reset link.
 *
 * The app had no route back in for anyone who could not sign in — the only paths were
 * a password you already knew and a Google account you had already linked. That became
 * urgent with the move off Supabase: accounts came across with their bcrypt hashes, so
 * an old password still works, but anyone who never had one, or who no longer remembers
 * it, had nothing to click.
 *
 * Firebase sends the mail and hosts the page that sets the new password, so no reset
 * token is ever minted, stored or verified here. It also means this does not depend on
 * Resend — whose production sender is a known-open item — and the one flow people reach
 * for when they are already locked out is the last one that should have a second
 * moving part.
 *
 * The confirmation deliberately does not say whether the address is registered. Sign-in
 * already discloses that through `GET /auth/status`, which it needs in order to explain
 * a removed account at all, but there is no reason to repeat it on a page that anyone
 * can load and submit repeatedly.
 */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setBusy(true);

    try {
      await sendPasswordResetEmail(getFirebaseAuth(), email.trim());
      setSent(true);
    } catch (caught) {
      const code =
        typeof caught === "object" && caught !== null && "code" in caught
          ? String((caught as { code: unknown }).code)
          : "";
      // An unregistered address is not an error worth showing. Reporting it would turn
      // this form into a way to test whether someone has an account here.
      if (code === "auth/user-not-found") {
        setSent(true);
      } else {
        setMessage(describeAuthError(caught));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Reset your password"
      {...(sent ? {} : { subtitle: "We'll email you a link to set a new one." })}
      footer={
        <Link to="/login" className="font-medium text-brand-600 dark:text-brand-300 hover:text-brand-700 hover:dark:text-brand-300">
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <Alert tone="success">
          If an account exists for that address, a reset link is on its way. Check your spam
          folder — it arrives from <strong>noreply@buildco-production-505918.firebaseapp.com</strong>.
        </Alert>
      ) : (
        <>
          {message && <Alert tone="danger">{message}</Alert>}

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

            <Button type="submit" variant="primary" busy={busy} className="w-full">
              Send reset link
            </Button>
          </form>
        </>
      )}
    </AuthLayout>
  );
}
