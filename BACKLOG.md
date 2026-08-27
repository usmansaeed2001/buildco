# Backlog

Known gaps, deferred deliberately rather than forgotten. Ordered by what would hurt
most in a beta. Each entry says what breaks, where the code is, and what "done" means.

Deployment state as of 2026-08-27: API on Cloud Run (`buildco-api`, `us-central1`),
Postgres on Cloud SQL (`buildco-db`), frontend on Firebase Hosting at
<https://buildco-production-505918.web.app>. All under the interim personal-account
project `buildco-production-505918` — see `apps/api/docs/FIREBASE_SETUP.md` §0.

---

## 1. No automatic deployment — releases are manual

**Blocked, not deferred.** The GitHub repository lives under the client's account, so it
cannot be connected to Cloud Build in the interim project `buildco-production-505918`.
Cloud Build triggers require that connection; there is no way around it from this side.

**Consequence: a merge to `production` deploys nothing.** Someone has to run the release
by hand. `production` being green is no longer the same as production *running* that
code — the branch is the intent, a release is the act. The procedure is
[`RELEASE.md`](RELEASE.md).

Everything except the connection is done and exercised:

- `apps/api/cloudbuild.yaml` and `apps/staff-web/cloudbuild.yaml` are written and were
  each run end to end through Cloud Build
- The build service account holds every role both pipelines need
- `firebase deploy` authenticating via ADC (no `FIREBASE_TOKEN`) is proven working

So the manual procedure is not a parallel, drift-prone script — it runs those same
configs with `gcloud builds submit --config=…`. Connecting the repository later changes
who pushes the button and nothing else.

Two unblocking paths:

- **Move to the client's GCP org** (§10) and connect the repo there. The real fix, and it
  resolves several other items at once.
- **Fork or mirror the repo** under an account that can be connected. Faster, but leaves
  two remotes to keep in sync, which is its own failure mode.

- [ ] Repository connected to Cloud Build
- [ ] Two triggers created on `^production$` with the included-files filters in
      `RELEASE.md`
- [ ] A no-op commit to `production` confirms the right trigger fires and the other
      does not
- [ ] `RELEASE.md` updated to describe the automatic path

## 2. Signed GCS URLs fail on Cloud Run — attachments are unusable

**Severity: high.** Confirmed broken in production, not theoretical.

`POST /api/v1/estimates/{id}/attachments/upload-url` returns 500:

```
AttributeError: you need a private key to sign credentials. the credentials you are
currently using <class 'google.auth.compute_engine.credentials.Credentials'> just
contains a token.
```

`app/services/integrations/storage.py:117` calls `blob.generate_signed_url(...)` with no
signing identity. That works locally, where `FIREBASE_CREDENTIALS_FILE` points at a
service-account JSON containing a private key. On Cloud Run the credentials come from the
metadata server and carry only a bearer token, so the library has nothing to sign with.

`roles/iam.serviceAccountTokenCreator` **is** bound on the service account (correctly, on
the SA resource itself) — but the role alone is not enough. `DEPLOY_CLOUD_RUN.md` §3
implies it is, and that is wrong: the code has to explicitly route signing through the
IAM `signBlob` API by passing both `service_account_email` and `access_token` to
`generate_signed_url`.

Fix in `_sign()` (and the matching one in `create_download_url`): resolve ADC, refresh it,
and pass the identity through — falling back to the current path when the credentials do
carry a private key, so local development keeps working.

Note the two failure modes differ, which is why this hid: uploads raise a 500, but
`create_download_url` catches, logs `storage_sign_failed`, and returns `null` — so
existing attachments would render with no URL and no error anywhere.

- [ ] `_sign()` handles both credential shapes
- [ ] Verified on Cloud Run: upload URL returned, PUT succeeds, download URL resolves
- [ ] Still works locally against the service-account JSON
- [ ] Correct the claim in `DEPLOY_CLOUD_RUN.md` §3

## 3. `/review/{token}` is not routed — reviewer emails go nowhere

The backend builds approval links as `{SITE_URL}/review/{token}` and
`apps/staff-web/src/api/client.ts` already handles the 410 spent-link case, but
`src/router.tsx` registers no such route. Every emailed link lands on the in-app
NotFound page.

Blocks the whole submit-for-review flow end to end. Keep it out of the beta script until
this and item 3 are done.

## 4. Resend has no verified domain

`GET /domains` returns empty, so the only sender is `onboarding@resend.dev`, which
**delivers only to the address that owns the Resend account**. Every other recipient is
rejected. Reviewer emails and new-user admin notifications will silently not arrive for
testers.

The adapter never raises — it logs `email_skipped` and returns False — so nothing appears
broken. Verify a domain in Resend and point `NOTIFY_FROM_EMAIL` at it.

## 5. OAuth consent screen is unbranded, and testers must be allowlisted

Deferred from the deployment plan's Phase 4. Neither blocks email/password sign-in.

**Branding** — Google Cloud Console → OAuth consent screen → Branding: app name
`BuildCo`, a monitored support email, the app logo, home page
`https://buildco-production-505918.web.app`, privacy policy and terms URLs. Without this
the consent screen shows the raw project ID.

**Test users** — the app stays in Testing mode, so every beta tester's Google account
must be added under Test users (100 max). They will still see "Google hasn't verified
this app" and must click **Advanced → Go to BuildCo**, because
`apps/staff-web/src/auth/firebase.ts` requests the sensitive `calendar.events` scope.

Two consequences worth remembering: in Testing mode Google OAuth refresh tokens expire
after **7 days**, so Calendar access needs periodic re-consent; and none of this affects
email/password sign-in, which is the smoother path for a beta.

Real fix is either dropping the Calendar scope from sign-in and requesting it
incrementally when meetings are built, or submitting for OAuth verification (privacy
policy, verified domain, demo video, multi-week review).

## 6. `/healthz` is unreachable on Cloud Run

Cloud Run's front end reserves that exact path. The request never reaches the container:
the 404 carries no `x-request-id` and no `server: Google Frontend`, unlike every other
response. `/healthz2` reaches the app fine, so it is that specific path.

Nothing is broken — Cloud Run uses a TCP startup probe, and `/readyz` works and is
stronger anyway since it actually touches the database. But `DEPLOY_CLOUD_RUN.md` §9's
first verification step will always fail, and any uptime check pointed at `/healthz`
will report the service down while it is healthy.

Suggested: add a `/livez` alias in `app/routers/health.py` and correct §9.

## 7. `staff-web` is mostly placeholders

Built: auth (login / signup / setup), the launcher, the estimates list. Rendering
`<Pending>`: the estimate editor, `/projects`, `/calendar`, `/team`, `/settings`.

This is the honest scope of the current beta — a tester can sign in and exercise
estimates. Worth stating plainly to whoever tests it.

## 8. OpenAPI docs are public on the Cloud Run origin

`/docs`, `/redoc` and `/openapi.json` are unauthenticated on
`https://buildco-api-*.run.app`. They are **not** reachable through the Hosting origin —
those paths sit outside `/api/**`, so the SPA catch-all swallows them — which limits the
exposure to anyone who knows the `run.app` URL. Fine for a closed beta; gate before
anything real.

## 9. Schema alignment against live Supabase is unfinished

From `apps/api/docs/DATABASE.md`. Irrelevant while the beta runs on a fresh database,
**blocking** for the data migration:

- [ ] A real `pg_dump --schema-only` of live Supabase — the committed
      `docs/reference/supabase_actual_schema.sql` contains a connection error, not a
      schema. Use the Session pooler string (the direct host is IPv6-only)
- [ ] `verify_nulls.sql` returns all zeros against production
- [ ] `verify_lengths.sql` returns all zeros against production
- [ ] `projects` columns past `reimbursements` confirmed (the source CSV was truncated
      at the SQL editor's 100-row cap)
- [ ] Row counts and FK integrity verified after a trial load

Indexes, foreign keys, unique and check constraints have never been compared at all,
because the column inventory the alignment rests on does not carry them.

## 10. Move to the client's GCP organisation

Everything runs under a personal account on personal billing. `FIREBASE_SETUP.md` §0 has
the full transition checklist — it is not a credential swap: Firebase Auth users, Cloud
SQL data, secrets, authorized domains and the OAuth consent screen are all per-project
and none of them carry over.

Blocked on someone at `buildcogrp.com` holding the `Organization Administrator` role.

## 11. The Cloud Build service account holds roles/editor

Builds run as `685076437457-compute@developer.gserviceaccount.com`, the Compute Engine
default service account, which carries `roles/editor` project-wide. That is the project
default rather than something the deployment granted, but it means anything that can
trigger a build can do almost anything in the project.

The pipeline's actual needs are narrow and are already granted explicitly:
`run.admin`, `artifactregistry.writer`, `firebasehosting.admin`,
`serviceusage.serviceUsageConsumer`, `logging.logWriter`, and `iam.serviceAccountUser`
on the `buildco-api` service account.

Done looks like: a dedicated `buildco-ci` service account holding only those roles, set
as the trigger's service account, and `roles/editor` removed from the compute default.
Worth doing before anyone outside the team can open a PR.

## 12. No end-to-end test coverage

Every test in the repository stops short of a real browser. The backend suite drives
FastAPI through httpx with a fake auth provider; the frontend suite drives components
through jsdom with MSW answering every request. Both are fast and neither has ever
proved that the pieces fit together.

So these four things are verified **only by a human clicking through the app**, and a
fully green `make check` plus `npm run test` says nothing about any of them:

- the Vite dev proxy and the Firebase Hosting `/api/**` rewrite actually reaching Cloud
  Run — the failure mode is `index.html` parsed as JSON, surfacing as
  `Unexpected token '<'` nowhere near its cause
- a real Firebase ID token surviving `verify_id_token(check_revoked=True)`
- Postgres-specific behaviour the SQLite test database does not reproduce (CHECK
  constraints, JSONB); `make test-pg` covers the API's half of this, nothing covers the
  round trip
- SPA deep links (`/estimates/abc-123`) surviving a refresh

Playwright was added as a devDependency, wired into `vite.config.ts`'s Vitest `exclude`
and into `eslint.config.js`, and a config plus a smoke spec were written — then removed
again, because `npx playwright install chromium` could not fetch the browser on this
network. It produced no output at all over 25 minutes and left only a lock directory;
that is a blocked or black-holed download, not a slow one. The dependency was dropped
rather than left installed-but-unusable, so nobody inherits a `test:e2e` script that
cannot run.

Picking it back up:

- [ ] Resolve the download — `HTTPS_PROXY`, or `PLAYWRIGHT_DOWNLOAD_HOST` pointed at a
      reachable mirror, or `channel: "chrome"` in the config to drive an already
      installed Chrome and download nothing
- [ ] Restore `@playwright/test`, `playwright.config.ts`, `tsconfig.e2e.json` and its
      reference from `tsconfig.json`, and the `test:e2e` / `test:e2e:ui` scripts.
      `eslint.config.js` still ignores `playwright-report/` and `test-results/` and
      still treats `e2e/**/*.ts` as Node, so that part needs nothing
- [ ] A smoke spec first, covering the harness rather than a feature: anonymous
      redirect to `/login`, `/api/v1/auth/status` returning JSON rather than the SPA
      fallback, and an unknown route rendering the in-app 404
- [ ] Then the two flows worth the cost: sign in → create estimate → add rooms and
      items → submit → approve through the emailed review link; and create project →
      add milestone → mark paid → status becomes `closed`
- [ ] Add `.gitignore` entries for `playwright-report/`, `test-results/` and
      `blob-report/` — traces and failure screenshots capture a signed-in session

## 13. Smaller things

- `GROQ_MODEL` will rot again. Groq retires hosted models without aliasing the old id
  forward, and a retired id fails every call with a 400 that only says the model does not
  exist. `llama-3.3-70b-versatile` was already dead when the environment was first
  provisioned. Currently `openai/gpt-oss-120b`.
- `verify_id_token(check_revoked=True)` makes a Firebase network round-trip on every
  authenticated request. Deliberate — it is what makes a ban take effect immediately
  rather than at token expiry — but it is the latency floor for every endpoint.
- No staging environment. `DEPLOY_CLOUD_RUN.md` §5 warns that at `ENVIRONMENT=staging` a
  broken ADC logs `firebase_unavailable_using_fake` and serves with authentication off in
  all but name. If a staging service is ever stood up, check its logs for that event
  before pointing anything real at it.
