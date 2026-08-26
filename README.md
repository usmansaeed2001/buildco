# BuildCo Ops Platform

Monorepo for the BuildCo construction-operations platform: supplement estimates,
projects and payment milestones, meetings, and the customer-facing features that follow.

Target of the migration described in `migration-docs/` — moving from static HTML +
Netlify Functions + Supabase to **FastAPI on Cloud Run + Cloud SQL Postgres + Firebase
Auth + React**.

Repository: <https://github.com/buildco51/buildco>

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

Read [`apps/api/README.md`](apps/api/README.md) for the endpoint reference and
[`apps/api/DEVELOPMENT_GUIDELINES.md`](apps/api/DEVELOPMENT_GUIDELINES.md) before
contributing.

---

## Branching and environments

Two long-lived branches, one per environment.

```
  feature/short-description ──┐
  fix/short-description ──────┼──► development ──(release PR)──► production
                              │     │                              │
                              │     └─ local only, no deployment   └─ live, customer-facing
                              │        (a staging deploy may be
                              │         added later)
                              └─ branch from development, merge back into it
```

| Branch | Environment | Deploys to | Protection |
|---|---|---|---|
| `production` | Production | Cloud Run + Firebase Hosting | Protected. Only ever updated by a release PR from `development`. Never commit to it directly. |
| `development` | Local | Nothing yet | Default branch. Integration target for all work. |

### Day-to-day

```bash
git switch development
git pull
git switch -c feature/project-documents

# work, commit

git push -u origin feature/project-documents
# open a PR into development
```

Feature branches always start from `development` and merge back into it. They never
touch `production` directly.

### Releasing

A release is a pull request from `development` into `production`.

1. Confirm `development` is green: `cd apps/api && make check`.
2. Open a PR `development → production`. Its description is the changelog — the reader
   is whoever is on call when something breaks at 2am.
3. Review the **full diff since the last release**, not just the newest commits.
4. Merge. Tag the result:
   ```bash
   git switch production && git pull
   git tag -a v0.2.0 -m "Add project documents; fix milestone reversal"
   git push origin v0.2.0
   ```
5. Deployment follows from the merge (once CI exists — see
   `migration-docs/05-cicd-infrastructure.md`).

Tag every release. A tag is what makes "roll back to what we had on Tuesday" a
one-command operation rather than an archaeology exercise.

### Database migrations across branches

Schema changes deserve particular care with this model, because a merge to
`production` deploys code and applies migrations as two separate acts, not one atomic
one.

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
git switch production && git pull
git switch -c hotfix/approval-token-check
# fix, PR into production, merge, tag
git switch development && git merge production   # keep development current
```

The last step is not optional. Skipping it means the next release silently reverts the
hotfix.

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
| Backend API and domain logic | Implemented. 191 tests, `mypy --strict` clean, verified against Postgres 16. |
| Local database | Docker Compose, persistent named volume. Verified across container destruction. |
| Database schema (Alembic) | Implemented and reversible. **Schema alignment against the live Supabase database is still pending** — see [`apps/api/docs/DATABASE.md`](apps/api/docs/DATABASE.md). |
| Firebase Auth | Interface implemented and swappable. Awaiting a project and credentials — see [`apps/api/docs/FIREBASE_SETUP.md`](apps/api/docs/FIREBASE_SETUP.md). |
| User migration | Planned and documented — see [`apps/api/docs/USER_MIGRATION.md`](apps/api/docs/USER_MIGRATION.md). |
| Cloud Storage, Resend, Slack, Groq, Calendar | Adapters implemented; degrade to logged no-ops without credentials. |
| Cloud Run deploy + CI | Dockerfile ready, deploy runbook written (`apps/api/docs/DEPLOY_CLOUD_RUN.md`). No service, no pipeline. |
| `staff-web` foundation | Vite + React + TS + Tailwind. Typed API client generated from OpenAPI, Firebase Auth wired to `POST /auth/session`, routing and guards, design system. Money and permission rules ported from the backend with their tests. |
| `staff-web` screens | Auth, launcher, and the estimates list are built. Estimate editor, projects, meetings, team, settings, and the public review page are not. |
| Firebase Hosting | `firebase.json` written — SPA fallback plus an `/api/**` rewrite to Cloud Run, so the frontend calls same-origin `/api/v1` in every environment. Not deployed. |
