# Firebase Auth — Setup Prerequisites

**What you need to do on the Firebase/GCP side before the backend can verify real
tokens.** The code is already written; this is the configuration it needs.

Work through §1–§6 and hand back the four items listed in §7. Nothing here requires a
frontend — the backend can be fully exercised once these exist.

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

Google matters beyond convenience: it is also where the Calendar OAuth token for
meeting Meet links comes from.

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
2. **OAuth consent screen**: Internal if you have Google Workspace (no verification
   needed); External otherwise, with your staff added as test users.
3. Add the scope `https://www.googleapis.com/auth/calendar.events`.

The frontend requests that scope alongside Google sign-in and passes the resulting
access token to `POST /api/v1/meetings` as `google_access_token`. The backend uses it
once and never stores it. Without it, meetings are created without a Meet link — which
is a supported outcome, not an error.

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
FIREBASE_PROJECT_ID=buildco-prod-xxxx
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
