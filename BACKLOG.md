# Backlog

Known gaps, deferred deliberately rather than forgotten. Ordered by what would hurt
most in a beta. Each entry says what breaks, where the code is, and what "done" means.

**This file is about the system.** For what *you* have to do — before a deploy, in a
console, or with your own eyes — see [`DEPLOY_CHECKLIST.md`](DEPLOY_CHECKLIST.md).

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

## 2. ~~Signed GCS URLs fail on Cloud Run~~ — fixed in code, needs a release

`generate_signed_url` was called with no signing identity, so on Cloud Run — where ADC
carries only a bearer token and no private key — uploads raised
`AttributeError: you need a private key to sign credentials` as a 500, and downloads
caught it, logged `storage_sign_failed`, and returned `null`. That asymmetry is why it
hid: attachments rendered with no URL and no error anywhere.

`storage._signing_kwargs()` now resolves ADC once, and when the credentials cannot sign
locally it passes `service_account_email` and `access_token` so the library routes
signing through the IAM `signBlob` API. Credentials that *do* carry a key keep the
offline path, so local development gains no IAM round trip per signature.

Worth recording, because the runbook said otherwise: holding
`roles/iam.serviceAccountTokenCreator` is **necessary but not sufficient**. Without
those two arguments the library never calls `signBlob` at all.
`docs/DEPLOY_CLOUD_RUN.md` §3 has been corrected.

- [x] `_signing_kwargs()` handles both credential shapes, with unit tests per shape
- [x] The claim in `DEPLOY_CLOUD_RUN.md` §3 corrected
- [ ] **Verified on Cloud Run after a release**: upload URL returned, `PUT` succeeds,
      download URL resolves — see `DEPLOY_CHECKLIST.md` §1.2

## 3. ~~`/review/{token}` is not routed~~ — done

`src/router.tsx` now registers `/review/:token` outside every guard, and
`features/review/ReviewPage.tsx` renders it. The submit side lives in
`features/estimates/SubmitForReviewModal.tsx`. Approve, reject and request-changes all
POST; 404 and 410 are told apart on the page, because "this link is wrong" and "you
already answered this" send a reviewer to two different places.

One thing to preserve if this page is ever reworked: the emailed links carry
`?action=approve|reject|changes`, and that only **opens** the matching confirmation. It
must never perform the decision. Auto-acting on the query parameter would reintroduce
exactly the hole that moving these endpoints from GET to POST closed — a prefetching
email client or security scanner approving a construction estimate by following a link.
There is a test named for it.

## 4. Resend domain — verified locally, still to do in production

A domain is now verified and `notifications@lahandyconstruction.com` is the sender.
`apps/api/.env` carries the key and `NOTIFY_FROM_EMAIL` for local development.

**Production is not updated.** Cloud Run reads `RESEND_API_KEY` from the Secret Manager
secret `resend-key` and `NOTIFY_FROM_EMAIL` from its own environment, neither of which
changes when a local `.env` does. Until both are set, production still sends as
`onboarding@resend.dev`, which **delivers only to the address that owns the Resend
account** — and the adapter never raises, it logs `email_skipped` and returns False, so
nothing looks broken while every reviewer email silently fails to arrive.

- [ ] `gcloud secrets versions add resend-key --data-file=-` with the new key
- [ ] `gcloud run services update buildco-api --update-env-vars=NOTIFY_FROM_EMAIL=notifications@lahandyconstruction.com`
- [ ] Send a real estimate for review to an address outside the Resend account and
      confirm it arrives

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

## 6. ~~`/healthz` is unreachable on Cloud Run~~ — done

Cloud Run's front end reserves that exact path; the request never reaches the container,
and the 404 carries no `x-request-id` and no `server: Google Frontend` unlike every
other response.

`/livez` is now an alias for the same probe under a path that is not intercepted, and
`DEPLOY_CLOUD_RUN.md` §9 points at it. Aim uptime checks at `/livez`; one aimed at
`/healthz` reports a healthy service as down.

## 7. ~~`staff-web` is mostly placeholders~~ — done

Every route is built. The `<Pending>` component is gone from `src/router.tsx`, along
with the last three placeholders (`/team`, `/profile`, `/settings`).

What remains is the parity sweep — walking the prototype's feature inventory end to end
and closing whatever it turns up.

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

- ~~`GROQ_MODEL` will rot again~~ — **moved to OpenAI, because it did.** Groq retires
  hosted models without aliasing the old id forward, and a retired id fails every call
  with a 400 that only says the model does not exist. `llama-3.3-70b-versatile` was
  already dead when the environment was first provisioned, and was *still* the value in
  `apps/api/.env` when note parsing was reported broken. `integrations/ai_provider.py`
  now prefers OpenAI, which keeps dated aliases working, and logs the model id on a
  provider 400 so the next occurrence is one log line rather than a guess. Groq stays as
  a fallback for **one release** so that deploying the code and setting
  `OPEN_AI_API_KEY` need not coincide — delete the branch, and both Groq settings, once
  every environment has the key.
- `verify_id_token(check_revoked=True)` makes a Firebase network round-trip on every
  authenticated request. Deliberate — it is what makes a ban take effect immediately
  rather than at token expiry — but it is the latency floor for every endpoint.
- No staging environment. `DEPLOY_CLOUD_RUN.md` §5 warns that at `ENVIRONMENT=staging` a
  broken ADC logs `firebase_unavailable_using_fake` and serves with authentication off in
  all but name. If a staging service is ever stood up, check its logs for that event
  before pointing anything real at it.

## 14. Attachments are addressed by position, not by identity

`attachments.room_index` and `attachments.item_index` are plain integers, carried over
from the legacy scheme so objects copied from Supabase stay addressable by the
`storage_path` values already in the database.

The consequence: **deleting or reordering a room or a line item does not move its
attachments.** A photo attached to room 0 item 2 will appear under whatever ends up at
that position. Nothing in the editor re-indexes them, deliberately — quietly rewriting
the indices on the client would make the mismatch harder to notice, not less likely.

Doing it properly means a real foreign key from `attachments` to a stable line-item id,
which means giving line items ids in the `rooms` JSONB document, a migration, and a
backfill. Worth doing before anyone relies on photo evidence for a claim.

---

## 15. BuildCo Assistant: what Release 1 leaves open

Release 1 is built and ships switched off. `AGENT_SPEC.md` is the design; `DEPLOY_CHECKLIST.md`
§3.10 is what has to happen before anyone uses it. What is left:

- **Release 2: editing rooms and line items by voice.** Blocked on §14 above, which the
  spec calls preparatory change C: rooms and lines need stable ids, and photos need to
  follow their line, before the assistant may add or remove one. Until then it says that
  rooms and lines are added in the editor.
- **Two open questions in the spec.** Q1: an 8-second first connect, or a paid warm
  instance. Q2: during a rollout the old and new revisions can each reach their own
  instance cap, which overruns the connection budget on paper.
- **Never run against the real thing:** iPad Safari (Windows and macOS Chrome were), the
  real cost per minute, the Postgres step in Cloud Build (it has run locally), a
  ten-minute approval pause, and sending for review by voice end to end (no reviewer is
  configured in local development).
- **The first response can be slow** when the model looks several things up before it
  speaks. Not measured carefully; worth a look in the pilot.
- **A conversation's time counts toward the day it started in.** One that runs across
  00:00 UTC is charged entirely to the day before.
- **The model's memory of early turns is not dependable** in a long conversation. The
  server re-sends what matters (what was committed, what is open) each time a model
  session starts, but small talk from the first minute can be forgotten by the last.
- **Nobody but the user can see in the app what the assistant did on their behalf.** By
  decision. An owner investigating a disputed change reads `agent_actions` directly.
