/**
 * Shown when no Firebase web config is present.
 *
 * Without this, a missing `.env.local` surfaces as `auth/invalid-api-key` from deep
 * inside the SDK, which reads like a broken build rather than a first-run step that
 * has not been done yet. `FIREBASE_SETUP.md` §7 records that the web app registration
 * is genuinely a separate task from the backend service account, so a new developer
 * hitting this is expected, not exceptional.
 */
import { AuthLayout } from "./AuthLayout";
import { Alert } from "@/components/feedback";

const VARS = [
  ["VITE_FIREBASE_API_KEY", "apiKey"],
  ["VITE_FIREBASE_AUTH_DOMAIN", "authDomain"],
  ["VITE_FIREBASE_PROJECT_ID", "projectId"],
  ["VITE_FIREBASE_STORAGE_BUCKET", "storageBucket"],
  ["VITE_FIREBASE_MESSAGING_SENDER_ID", "messagingSenderId"],
  ["VITE_FIREBASE_APP_ID", "appId"],
] as const;

export function SetupPage() {
  return (
    <AuthLayout title="Finish setting up" subtitle="Firebase is not configured yet.">
      <Alert tone="info">
        The app cannot sign anyone in until it knows which Firebase project to talk to.
      </Alert>

      <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-gray-600 marker:text-gray-400">
        <li>
          In the Firebase console, open <strong>Project settings → Your apps</strong> and add a{" "}
          <strong>Web app</strong> if one does not exist.
        </li>
        <li>Copy the config values it shows you.</li>
        <li>
          Copy <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-xs">.env.example</code>{" "}
          to <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-xs">.env.local</code>{" "}
          and fill in:
        </li>
      </ol>

      <dl className="flex flex-col gap-1 rounded-md bg-gray-50 p-3 font-mono text-xs ring-1 ring-inset ring-gray-200">
        {VARS.map(([envVar, source]) => (
          <div key={envVar} className="flex flex-wrap items-baseline gap-x-2">
            <dt className="text-gray-700">{envVar}</dt>
            <dd className="text-gray-400">← {source}</dd>
          </div>
        ))}
      </dl>

      <p className="text-sm text-gray-500">
        Restart the dev server afterwards — Vite reads env files only at startup.
      </p>
    </AuthLayout>
  );
}
