# BuildCo Ops Platform

Monorepo for the BuildCo construction-operations platform: supplement estimates,
projects and payment milestones, meetings, and the customer-facing features that follow.

Target of the migration described in `migration-docs/` — moving from static HTML +
Netlify Functions + Supabase to **FastAPI on Cloud Run + Cloud SQL Postgres + Firebase
Auth + React**.

Repository: <https://github.com/usmansaeed2001/buildco>

---

## Layout

```
buildco/
  firebase.json    Hosting config: SPA fallback + /api/** rewrite to Cloud Run
  apps/
    api/           FastAPI backend (Python 3.12)   ← implemented
    staff-web/     React internal ops app          ← in progress
    customer-web/  React customer site             ← Phase 3
```

`packages/shared`, `packages/ui`, and `packages/api-client` were planned in
`migration-docs/03-frontend-migration.md` but are **deliberately not built yet**. They
exist to share code between `staff-web` and `customer-web`, and until the second app
exists there is nothing to share — three packages, a root `package.json`, and a
`turbo.json` would be indirection serving one consumer. `staff-web` keeps its API
client and types internally; extracting them later is a mechanical move.

Domain types are generated from the API's OpenAPI schema rather than hand-written, so
the two cannot drift. See `apps/staff-web/README.md`.

---

## Getting started

Everything currently lives in the backend:

```bash
cd apps/api
uv sync --group dev
cp .env.example .env
docker compose up -d db
uv run alembic upgrade head
uv run uvicorn app.main:app --reload
```

Then open <http://localhost:8000/docs>.

**Postgres runs in Docker and is not installed on the host**, so the steps above are
identical on every machine and Docker is the only prerequisite. Data persists in a
named volume across `docker compose down` — see
[`apps/api/docs/DATABASE.md`](apps/api/docs/DATABASE.md).

Deploying? Read [`DEPLOY_CHECKLIST.md`](DEPLOY_CHECKLIST.md) first — it is the list of
everything that needs a person: blockers that make a feature fail silently in
production, the config that must be set by hand, and the walkthrough that stands in for
an automated end-to-end suite. Then [`RELEASE.md`](RELEASE.md) for the procedure itself;
a merge to `main` ships nothing until someone runs the Release workflow. Known gaps in
the system live in [`BACKLOG.md`](BACKLOG.md).

Read [`apps/api/README.md`](apps/api/README.md) for the endpoint reference and
[`apps/api/DEVELOPMENT_GUIDELINES.md`](apps/api/DEVELOPMENT_GUIDELINES.md) before
contributing.

---

## Branching and environments

One long-lived branch, `main`, and one environment, production. A branch name no longer
stands for an environment: there used to be a `development` and a `production`, but
`development` deployed nowhere, so the second branch was a merge to remember and nothing
else.

```
  feature/short-description ──┐
  fix/short-description ──────┼──(pull request, CI)──► main ──(Release workflow)──► production
  hotfix/short-description ───┘                          │                              │
                                                         └─ checked, not deployed       └─ live, tagged vX.Y.Z
```

**Merging and releasing are separate acts.** A merge to `main` runs the checks and ships
nothing. Running the Release workflow is what deploys, and it can carry one merged pull
request or several.

### Day-to-day

```bash
git switch main
git pull
git switch -c feature/project-documents

# work, commit

git push -u origin feature/project-documents
# open a PR into main
```

Every pull request runs [`ci.yml`](.github/workflows/ci.yml): for the API, `ruff`,
`mypy` and the suite on SQLite and again on Postgres; for the web app, `eslint`, the
tests and the build. A pull request is checked only for the app it touches. Its title
ends up in the release notes, so write it for whoever reads those.

### Releasing

GitHub → Actions → **Release** → Run workflow. Choose the bump, optionally say what
shipped in a few words, and run it. It:

1. refuses unless it is on `main` and CI passed on that commit;
2. works out the next version from the last tag;
3. deploys the API if `apps/api` changed since that tag, then the web app if it did —
   through the same `apps/*/cloudbuild.yaml` configs as ever;
4. checks that both services and the site are serving the new version;
5. tags the commit `vX.Y.Z` and publishes the release notes.

The full procedure, what to do when a step fails, and how to release by hand if GitHub
is unavailable are in [`RELEASE.md`](RELEASE.md).

### Versions

One version for the whole repository, `vX.Y.Z`. The API and the web app share it even
when a release deploys only one of them; the notes say which.

**The git tag is the only place the version is written.** Nothing in the repository is
bumped by hand. The release passes the number into both builds, so `/livez` reports it
and the Settings page shows it. The `version` fields in `pyproject.toml` and
`package.json` are package metadata and are not the release version.

Which bump, while the version starts with `0.`:

| Bump | When |
|---|---|
| patch | Fixes, internal changes, anything staff would not notice |
| minor | Something new staff can see, or any database migration |
| major | Reserved for `1.0.0` |

### Database migrations

Schema changes deserve particular care, because a release applies the migration and
rolls the code as two separate steps, not one atomic one.

- Every migration must be **backward-compatible with the currently deployed code**
  (expand/contract). Add a nullable column and ship code that writes it; backfill;
  add the constraint — across separate releases, not one.
- Never edit a revision that has been applied anywhere. Write a new one.
- Every migration needs a working `downgrade()`, tested locally in both directions.

Full rules in
[`apps/api/DEVELOPMENT_GUIDELINES.md`](apps/api/DEVELOPMENT_GUIDELINES.md) §8.

### Hotfixes

For something broken in production that cannot wait for the normal cycle:

```bash
git switch main && git pull
git switch -c hotfix/approval-token-check
# fix, PR into main, merge, then run the Release workflow with `patch`
```

There is no second branch to carry the fix back to. The release takes everything on
`main`, so if something unfinished has merged since the last release, revert it first or
the hotfix ships it too.

### Conventions

- Branch names: `feature/…`, `fix/…`, `hotfix/…`, `chore/…` — short and kebab-cased.
- Commit subjects in the imperative mood: "Add project documents", not "Added" or
  "Adding".
- Explain **why** in the commit body when the reason is not obvious from the diff.
- Never commit a `.env`, a service-account JSON, or anything from a `migration/`
  working directory. `.gitignore` covers the usual shapes, but it is a safety net, not
  a substitute for looking at what you are staging.

---

## Status

| Area | State |
|---|---|
| Backend API and domain logic | Implemented. 207 tests, `mypy --strict` clean, verified against Postgres 16 and running on Cloud SQL. |
| Local database | Docker Compose, persistent named volume. Verified across container destruction. |
| Database schema (Alembic) | Implemented and reversible. **Schema alignment against the live Supabase database is still pending** — see [`apps/api/docs/DATABASE.md`](apps/api/docs/DATABASE.md). |
| Firebase Auth | **Live.** Tokens verified in production via ADC on the Cloud Run service account — no key file in the image. Email/password and Google are enabled and the Hosting domain is authorised. See [`apps/api/docs/FIREBASE_SETUP.md`](apps/api/docs/FIREBASE_SETUP.md). |
| User migration | Planned and documented — see [`apps/api/docs/USER_MIGRATION.md`](apps/api/docs/USER_MIGRATION.md). |
| Cloud Storage, Resend, Slack, Groq, Calendar | Adapters implemented; degrade to logged no-ops without credentials. Resend and Groq are configured in production; Slack is deliberately not. **Cloud Storage signing is broken on Cloud Run** — [`BACKLOG.md`](BACKLOG.md) §2. |
| Cloud Run deploy | **Live.** `buildco-api` in `us-central1`, backed by Cloud SQL `buildco-db` (Postgres 16), secrets in Secret Manager, migrations run as a Cloud Run Job. Provisioning runbook: `apps/api/docs/DEPLOY_CLOUD_RUN.md`. |
| CI/CD | Checks on every pull request (`.github/workflows/ci.yml`). Releases are one button: the Release workflow runs the Cloud Build pipelines (`apps/*/cloudbuild.yaml`) in order and tags the result — [`RELEASE.md`](RELEASE.md). |
| `staff-web` foundation | Vite + React + TS + Tailwind. Typed API client generated from OpenAPI, Firebase Auth wired to `POST /auth/session`, routing and guards, design system. Money and permission rules ported from the backend with their tests. |
| `staff-web` screens | **Complete.** Auth, launcher, estimates list and editor, attachments, AI note parsing with dictation, the PDF report, the public review page, projects, closing forms, the calendar, team, profile and settings. 535 frontend tests. |
| Firebase Hosting | **Live** at <https://buildco-production-505918.web.app> — SPA fallback plus an `/api/**` rewrite to Cloud Run, so the frontend calls same-origin `/api/v1` in every environment and there is no CORS in production. |
