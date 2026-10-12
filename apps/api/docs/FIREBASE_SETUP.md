# Firebase Auth — Setup Prerequisites

**What you need to do on the Firebase/GCP side before the backend can verify real
tokens.** The code is already written; this is the configuration it needs.

Work through §1–§6 and hand back the four items listed in §7. Nothing here requires a
frontend — the backend can be fully exercised once these exist.

---

## Status (as of 2026-08-18)

**Backend auth is fully configured and tested against the interim project
`buildco-production-505918`.** See §0 for why it's the interim project rather than the
client's org, and the go-live checklist there for what moving to the client's account
still requires.

| Section | Status |
|---|---|
| §1 Project | ✅ Done — `buildco-production-505918` |
| §2 Sign-in providers | ✅ Email/Password and Google enabled, domains authorized (`localhost` + Firebase Hosting domains — no production frontend domain yet, see below) |
| §3 Service account | ✅ Done — JSON key path, not ADC (org policy blocks key creation on the client's project, moot here since this is the personal-account project) |
| §4 Calendar API | ⏭️ Deferred — not needed until the meetings feature is worked on |
| §5 Supporting APIs | ✅ All enabled |
| §6 Password hash params | ⏭️ Skipped — no Supabase user migration for this project; fresh users only |
| §8 Verification | ✅ Fully tested — see results below |

**§8 was run for real**, not just read through: real Email/Password self-service
signup (`accounts:signUp`, not an Admin-SDK-created user) → `POST /auth/session` →
`GET /users/me`, plus the ban/revocation check with a second, separately-provisioned
admin account. Every row in the §8 table passed. Test accounts were deleted afterward
(both the Firebase users and their `profiles` rows) — nothing left over except the
original synthetic `dev-owner` profile from earlier `AUTH_DISABLED=true` testing.

Google sign-in is enabled and configured but **not** end-to-end tested — that provider
needs a real browser OAuth redirect, which isn't possible from curl. Nothing suggests
it won't work; it just hasn't been exercised the way Email/Password has.

**Frontend integration does not exist yet.** This entire setup only covers the
backend's ability to verify tokens — there is no frontend code calling Firebase Auth,
so no authorized domain has been added for a production frontend URL, and the "Web app
config" handoff in §7 hasn't happened (no web app is registered under **Your apps**
yet either). That's separate, upcoming work — see `README.md` / the frontend repo for
where that stands, and add the production domain to Authorized domains (§2) once it's
decided.

---

## 0. Interim setup: developing under a personal account

The client's Google Workspace (`buildcogrp.com`) does not yet have anyone confirmed as
Organization Administrator in GCP — `admin@buildcogrp.com` could not access
`admin.google.com`, and self-claiming the org-level IAM role requires Workspace Super
Admin status that account doesn't have. Resolving that is on the client; it should not
block development.

**Decision:** develop and deploy against a project under the developer's personal
Google account for now, then transition to the client's org once their GCP org access
is sorted out.

- **Interim project ID:** `buildco-production-505918` (personal account), not
  `buildco-production` — that ID is a separate project already created under the
  client's `buildcogrp.com` org during initial setup, and project IDs are globally
  unique, so the two cannot share a name.
- Cloud SQL, Cloud Run, and any other billed resources also run under the developer's
  personal billing during this interim period.
- Everything else in this document (§1–§9) applies as written — just substitute
  `buildco-production-505918` wherever the doc says `buildco-production` or
  `FIREBASE_PROJECT_ID`.

### Go-live transition checklist

When the client's org access is resolved, moving from the interim project to the
client-owned one is **not** a one-line credential swap. Work through this in order:

- [ ] Confirm someone has the `Organization Administrator` IAM role on the
      `buildcogrp.com` GCP org (see the org-access troubleshooting notes below if not).
- [ ] Create (or reuse) `buildco-production` under the client's org, and re-run §1–§6
      of this document against it from scratch — sign-in providers, service
      account/ADC, Calendar API, supporting APIs, and password hash parameters are all
      per-project and do not carry over.
- [ ] **Migrate Firebase Auth users.** Users created in `buildco-production-505918`
      during development do not exist in the new project. Either re-run the Supabase
      user import (see `USER_MIGRATION.md`) against the client's project directly, or
      export/re-import users between the two Firebase projects if real interim users
      need to be preserved.
- [ ] **Migrate Cloud SQL.** Provision the database under the client's billing and
      migrate data (`pg_dump`/`pg_restore` or Cloud SQL's built-in migration tooling)
      from the interim instance. Do not just re-point the connection string — the
      interim data has to actually move.
- [ ] Update `.env` / Secret Manager in every deploy target: `FIREBASE_PROJECT_ID`,
      `FIREBASE_CREDENTIALS_FILE` (or ADC project), and the database connection string.
- [ ] Update Authorized domains (§2) for the production frontend URL under the new
      project — this does not carry over automatically.
- [ ] Point DNS / frontend deploy at the new backend once it's verified against the new
      project (§8 verification steps).
- [ ] Decommission the interim `buildco-production-505918` project (or downgrade it to
      a personal scratch project) once the swap is confirmed working end-to-end.

### Finding who has GCP org access

If `admin.google.com` doesn't let a given account in (click-and-nothing-happens is the
typical symptom of no admin role, not a connectivity issue), that account is not a
Workspace admin. Check with:

```bash
gcloud organizations list                          # get the org ID
gcloud organizations get-iam-policy ORG_ID          # see who holds organizationAdmin
```

The second command itself requires org-level permission to run, so a "permission
denied" there confirms the account you're using has no org IAM access either. Only a
confirmed Workspace **Super Admin** (admin.google.com → Account → Admin roles) can
self-claim the `Organization Administrator` GCP role from a zero-permissions starting
point, via the IAM page in Cloud Console with the organization (not a project) selected
as the resource. If no such account is available, this has to go back to the client.

---

## 1. Create the project

A Firebase project *is* a GCP project, so creating one here gets you Cloud Run, Cloud
SQL, and Secret Manager on the same bill.

1. <https://console.firebase.google.com> → **Add project**.
2. Name it `buildco-prod`. Note the **Project ID** — it may get a numeric suffix
   (`buildco-prod-4a91`), and the ID, not the display name, is what the code needs.
3. Google Analytics: not needed. Decline.
4. Repeat for `buildco-staging`.

> Do both now. Retrofitting a staging environment after production is live means
> testing auth changes against real users' accounts.

---

## 2. Enable sign-in providers

**Authentication → Get started → Sign-in method**

### Email/Password
Enable. Leave "Email link (passwordless)" off — the app uses passwords, and the
migrated users arrive with password hashes.

### Google
Enable, then set:
- **Project public-facing name**: `BuildCo`
- **Project support email**: a real address you monitor; it appears on the consent
  screen.

Sign-in asks for no Calendar access. Meet links ask for it separately, when a meeting is
created — see §4.

### Authorized domains
**Authentication → Settings → Authorized domains.** Add every origin that will host the
frontend:
- `localhost` (present by default)
- your production domain, e.g. `supplements.lahandyconstruction.com`
- the Firebase Hosting domains (`buildco-prod.web.app`, `buildco-prod.firebaseapp.com`)

A domain missing here fails sign-in with an unhelpful error, so add them all now.

---

## 3. Service account for the backend

The Admin SDK verifies tokens, disables users, and sets custom claims.

**Project settings (gear) → Service accounts → Generate new private key** → downloads a
JSON file.

**Handle it carefully.** That file can mint credentials for any user in the project.

- Do **not** commit it. `*-credentials.json` and `service-account*.json` are already in
  `.gitignore`, but do not rely on that alone.
- Local development: save it outside the repo, or at `apps/api/secrets/firebase-admin.json`
  (gitignored), and point `FIREBASE_CREDENTIALS_FILE` at it.
- Cloud Run: do **not** ship the file. Grant the Cloud Run service account the
  **Firebase Authentication Admin** role and let Application Default Credentials
  resolve it. The code already prefers ADC when `FIREBASE_CREDENTIALS_FILE` is unset.

Generate a separate key per environment. Never share one between staging and
production.

---

## 4. Calendar API access (for meeting Meet links)

Only needed for the meetings feature; auth works without it.

1. **Google Cloud Console → APIs & Services → Library → Google Calendar API → Enable.**
   If it is off, Google's permission popup still succeeds and the meeting is created
   with no link.
2. **OAuth consent screen**: Internal if you have Google Workspace (no verification
   needed); External otherwise, with the staff who should be able to add Meet links
   added as test users.
3. Add the scope `https://www.googleapis.com/auth/calendar.events`.
4. **Credentials → "Web client (auto created by Google Service)"**: add every origin
   that serves the frontend (`http://localhost:5173` and the hosting domains) under
   **Authorised JavaScript origins**, and put its **Client ID** in the frontend's
   `VITE_GOOGLE_CLIENT_ID` (`apps/staff-web/.env.local` and `.env.production`). Without
   that variable the option is not shown.

Sign-in does **not** request this scope. The frontend asks for it only when someone
ticks **Add a Google Meet link** on a new meeting, through Google Identity Services,
and passes the resulting access token to `POST /api/v1/meetings` as
`google_access_token`. The backend uses it once and never stores it. The link is created
in that person's own Google account and goes out in the invite email and the .ics.
Without a token, meetings are created without a Meet link — which is a supported
outcome, not an error.

---

## 5. Enable the supporting APIs

**Google Cloud Console → APIs & Services → Library**, on both projects:

- Identity Toolkit API (Firebase Auth) — usually auto-enabled
- Cloud Run Admin API
- Cloud SQL Admin API
- Secret Manager API
- Artifact Registry API
- Cloud Build API
- Cloud Storage API
- Google Calendar API (§4)

---

## 6. Password hash parameters — **do this before importing users**

To migrate existing Supabase users **without forcing password resets**, the Firebase
project must be configured with the hashing parameters matching the exported hashes.

**Authentication → Users → ⋮ (three dots) → Password hash parameters**

Record what is shown. If Supabase exports bcrypt hashes (it normally does), the import
uses `hash_algo=BCRYPT` and this screen is not needed — but capture it anyway before
touching anything, because it is not recoverable later.

See [`USER_MIGRATION.md`](USER_MIGRATION.md) for the full procedure. Read it **before**
creating any users by hand: a manually created account with an email that also exists
in the export will collide with the import.

---

## 7. What to hand back

| Item | Where it comes from | Goes to |
|---|---|---|
| **Project ID** (staging and prod) | §1 | `FIREBASE_PROJECT_ID` |
| **Service account JSON** (one per environment) | §3 | `FIREBASE_CREDENTIALS_FILE` locally; Secret Manager `firebase-admin-credentials` in Cloud Run |
| **Web app config** (apiKey, authDomain, …) | Project settings → Your apps → Web app → Add app | The frontend, in Phase 2. Not secret, but needed. |
| **Confirmation** that Email/Password and Google are enabled and domains authorised | §2 | — |

Then locally:

```bash
# apps/api/.env
AUTH_DISABLED=false
FIREBASE_PROJECT_ID=buildco-prod-xxxx   # buildco-production-505918 for the current interim project — see §0
FIREBASE_CREDENTIALS_FILE=./secrets/firebase-admin.json
```

Restart the API. On startup you should **no longer** see the `auth_provider_is_fake`
warning — that line means tokens are not being verified.

---

## 8. How to verify it works, with no frontend

Create a test user in **Authentication → Users → Add user**, then exchange
email/password for an ID token using the public REST endpoint (`WEB_API_KEY` is from the
web app config; it is not a secret):

```bash
curl -X POST \
  "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=WEB_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@example.com","password":"...","returnSecureToken":true}'
```

Take `idToken` from the response and call the API:

```bash
TOKEN="<idToken>"

# Provisions the profile. The first user ever becomes the owner.
curl -X POST http://localhost:8000/api/v1/auth/session -H "Authorization: Bearer $TOKEN"

curl http://localhost:8000/api/v1/users/me -H "Authorization: Bearer $TOKEN"
```

Expected results:

| Check | Expected |
|---|---|
| `POST /auth/session` with a valid token | 200, `{"user": {...}, "created": true}` on first call |
| Same call again | 200, `created: false` — profiles are not duplicated |
| Any request with no token | 401 `unauthorized` |
| Any request with a garbage token | 401 `unauthorized` |
| A token from the *other* Firebase project | 401 — projects are isolated |
| `POST /users/{id}/ban`, then a request with that user's existing token | 401 — status is rechecked per request, so revocation is immediate rather than waiting an hour for expiry |

The last row is the one worth confirming deliberately. It is the reason the ban path
writes both `profiles.status` and the Firebase `disabled` flag.

---

## 9. Roles

`profiles.role` in Postgres is **authoritative**. The backend mirrors it to a Firebase
custom claim (`role`) purely so the frontend can render the right navigation before its
first API call.

Never authorise from the claim. Claims are stale until the client refreshes its token —
up to an hour — which would leave a demoted admin with admin powers for that window.
The backend reads the database on every request instead.

The first person to call `POST /auth/session` on an empty database becomes the owner.
This replaces the Supabase `handle_new_user()` trigger, which fired on `auth.users` and
does not survive the move.

---

## 10. Cost

Firebase Auth is free below 50,000 monthly active users, and this is an internal tool
with a handful of staff. Assume zero.
