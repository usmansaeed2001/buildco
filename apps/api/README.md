# BuildCo API

FastAPI backend for the BuildCo construction-operations platform — supplement
estimates, projects and payment milestones, meetings, and the external estimate
approval flow.

Replaces the eight Netlify Functions of the legacy stack. Python 3.12, SQLAlchemy 2.0
async, Postgres, Firebase Auth, deployed to Cloud Run.

> **New here?** Read [`DEVELOPMENT_GUIDELINES.md`](DEVELOPMENT_GUIDELINES.md) before
> writing code. It is the contract this codebase is held to.

---

## Quick start

```bash
cd apps/api
uv sync --group dev          # Python 3.12 toolchain and dependencies
cp .env.example .env         # defaults work as-is for local development
docker compose up -d db      # Postgres 16 on port 5432
uv run alembic upgrade head  # create the schema
uv run uvicorn app.main:app --reload
```

Postgres runs in Docker; **nothing is installed on the host**, so every contributor
gets an identical setup with Docker as the only prerequisite. Data lives in a named
volume and survives `docker compose down` — see [`docs/DATABASE.md`](docs/DATABASE.md)
for persistence guarantees, the reset procedure, and the pending schema-alignment work.

Open <http://localhost:8000/docs> for interactive API documentation.

`.env.example` ships with `AUTH_DISABLED=true`, so every request runs as a synthetic
owner and no Firebase project is needed to explore the API. Settings validation refuses
to start with that flag in staging or production.

```bash
uv run pytest                # 191 tests, no Docker or network required
uv run ruff check . && uv run ruff format .
uv run mypy app              # strict
```

---

## Architecture

```
Request
  │
  ├─ routers/      transport. Validate input, declare who may call, serialise output.
  │                  No database access. No business rules. No inline role checks.
  │
  ├─ deps.py       authentication and authorisation, as dependencies.
  │
  ├─ services/     orchestration. Load data, call a rule, apply the answer, persist.
  │                  Never imports FastAPI. Never commits.
  │
  ├─ services/rules/        pure decisions. No I/O at all. Exhaustively unit-tested.
  ├─ services/integrations/ the only modules permitted to open a network connection.
  │
  ├─ models/       SQLAlchemy tables.
  └─ schemas/      Pydantic request and response contracts.
```

The direction of dependency is one-way: routers → services → rules. Nothing lower
imports anything higher.

### Layout

```
app/
  main.py            app factory, middleware, router registration
  config.py          settings (env / Secret Manager)
  db.py              async engine, session factory, get_db
  deps.py            get_current_user, require_role, require_project_access
  errors.py          AppError hierarchy + the single error envelope
  logging.py         structlog JSON output
  models/            12 tables
  schemas/           request/response models
  routers/           health, users, estimates, attachments, projects, meetings,
                     reviews, ai, settings
  services/
    rules/           project_rules, estimate_rules, user_rules, estimate_totals
    integrations/    email, slack, storage, calendar, groq, firebase
    templates/email/ Jinja2 templates, one base + per-notification
alembic/             versioned migrations
tests/
  unit/              rules only — no DB, no network
  api/               full request/response through httpx
```

---

## Endpoints

Everything under `/api/v1`. Send `Authorization: Bearer <firebase-id-token>` unless
marked **public**.

### Health

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz` | Liveness. Touches nothing external, so a database blip cannot trigger a restart loop. |
| GET | `/readyz` | Readiness. Checks the database; 503 when it is unreachable. |

### Auth and users

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/auth/session` | token | Exchange a Firebase token for a profile. Provisions new users, links migrated ones, makes the first user ever the owner. Call once after sign-in. |
| GET | `/auth/status?email=` | **public** | Pre-sign-in check: `active` / `banned` / `not_found`. Files one access request for a removed user. |
| GET | `/users/me` | any | |
| PATCH | `/users/me` | any | `full_name`, `phone` |
| POST | `/users/me/avatar-upload-url` | any | Signed PUT for a direct upload |
| PUT | `/users/me/avatar` | any | Record the URL after upload |
| GET | `/users` | any | Team roster |
| PATCH | `/users/{id}/role` | owner/admin | |
| POST | `/users/{id}/ban` | owner/admin | Also disables the Firebase user |
| GET | `/approval-requests` | owner/admin | `?status=pending` |
| POST | `/approval-requests/{id}/approve` | owner/admin | Restores access |
| POST | `/approval-requests/{id}/deny` | owner/admin | |

### Estimates

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/estimates` | any | `?trash=&status=&q=&limit=&offset=`. Members see only their own. |
| POST | `/estimates` | any | Server assigns the `CLM-######` identifier |
| GET | `/estimates/{id}` | any + access | |
| PATCH | `/estimates/{id}` | see rules | Locked ⇒ owner only; member ⇒ own only |
| DELETE | `/estimates/{id}` | author or elevated | Soft delete to trash |
| POST | `/estimates/{id}/restore` | owner/admin | |
| DELETE | `/estimates/{id}/permanent` | owner/admin | Also purges storage objects |
| POST | `/estimates/{id}/transitions` | per action | `{action}` — see the state machine below |
| POST | `/estimates/{id}/submit` | see rules | Mints an approval token, emails the reviewer |

Every estimate response carries a computed `totals` object, so no client re-derives
money.

### Attachments

| Method | Path | Notes |
|---|---|---|
| GET | `/estimates/{id}/attachments` | Each row carries a freshly signed download URL |
| POST | `/estimates/{id}/attachments/upload-url` | Step 1: signed PUT straight to Cloud Storage |
| POST | `/estimates/{id}/attachments` | Step 2: record the file after the PUT succeeds |
| DELETE | `/attachments/{id}` | Row first, object in the background |

### Projects

| Method | Path | Role |
|---|---|---|
| GET | `/projects` | any (members see only assigned) |
| POST | `/projects` | owner/admin |
| GET | `/projects/{id}` | any + access — `?include=milestones,supplements,activity` |
| PATCH | `/projects/{id}` | owner/admin |
| PATCH | `/projects/{id}/work-status` | any + access |
| PATCH | `/projects/{id}/status` | owner/admin — only `active` / `cancelled` |
| DELETE | `/projects/{id}` | owner/admin |
| GET | `/projects/{id}/activity` | any + access |
| GET, POST | `/projects/{id}/milestones` | any + access |
| PATCH | `/projects/{id}/milestones/{mid}` | any + access |
| DELETE | `/projects/{id}/milestones/{mid}` | owner/admin |
| GET, POST | `/projects/{id}/supplements` | any + access |
| DELETE | `/projects/{id}/supplements/{estimate_id}` | any + access |
| PUT | `/projects/{id}/closing-forms/{1\|2}` | any + access |

### Meetings

| Method | Path | Role |
|---|---|---|
| GET | `/meetings` | any — `?from=&to=&project_id=` |
| POST | `/meetings` | owner/admin — Meet link, ICS, invites |
| GET | `/meetings/{id}` | any |
| PATCH | `/meetings/{id}` | owner/admin — re-invites only on a material change |
| DELETE | `/meetings/{id}` | owner/admin — sends a cancellation ICS |

### Public review

Authenticated by the approval token in the URL. No session required.

| Method | Path |
|---|---|
| GET | `/public/reviews/{token}` |
| POST | `/public/reviews/{token}/approve` |
| POST | `/public/reviews/{token}/reject` |
| POST | `/public/reviews/{token}/request-changes` |

### Settings and the rate catalogue

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/settings` | any | Team-wide preferences. The row is created on first read, so this never 404s. |
| PATCH | `/settings` | owner/admin | `notification_prefs` is **merged**; the two lists replace wholesale. |
| GET | `/catalogue-items` | any | The universal rate list. Members need it to price a line. |
| POST | `/catalogue-items` | owner/admin | |
| PATCH | `/catalogue-items/{id}` | owner/admin | Estimates already priced from it are untouched. |
| DELETE | `/catalogue-items/{id}` | owner/admin | |

The three switchable notifications are `estimate_locked`, `member_joined` and
`member_removed`. An unknown key is a 422 rather than a stored no-op. Access attempts by
removed users are deliberately not switchable — a security signal, not a routine update.

### AI

| Method | Path | Notes |
|---|---|---|
| POST | `/ai/parse-estimate` | Free-form notes → validated draft estimate. Nothing is persisted. |

---

## Domain model

Twelve tables. `profiles.id` remains the internal user id (every FK points at it);
`firebase_uid` links a profile to its Firebase identity.

```
profiles ──┬─< estimates ──< attachments
           │        └──< project_supplements >── projects
           ├─< projects ──┬─< payment_milestones
           │              ├─< project_activity
           │              └─< meetings
           ├─< meeting_attendees >── meetings
           └─< approval_requests
```

### Estimate state machine

```
                 ┌──── archive ────► archived ──── unarchive ────┐
                 │                                               │
   active ◄──────┼──── lock ───────► locked ───── unlock ────────┤
     │           │                                               │
     │ submit    └───────────────────────────────────────────────┘
     ▼
 submitted ──┬── reviewer approves ──► approved
             ├── reviewer rejects  ──► rejected ──── submit ──► submitted
             ├── reviewer asks for changes ──► changes_requested ── resubmit_ready ──► active
             └── staff recall ──────► active
```

`lock`/`unlock` are owner-only. `archive`/`unarchive`/`admin_approve` are owner or
admin. `recall`/`resubmit_ready` are open to any role, and both invalidate the
reviewer's outstanding link.

### Project auto-transitions

Two independent axes: `work_status` (where the physical work stands) and `status`
(where the engagement stands). `status` is **derived**, never asserted:

1. Both closing forms submitted ⇒ `work_status = completed`.
2. Work completed **and** every milestone paid (or none exist) ⇒ `status = closed`.
3. Work completed **and** any milestone unpaid ⇒ `status = pending_payment`.
4. Work not completed ⇒ `status = active`.
5. `cancelled` is final and no rule overrides it.

The whole decision lives in one pure function, `services/rules/project_rules.evaluate`,
which every mutation that could change the answer runs through
(`project_service._reconcile`). It is idempotent, so calling it more often than
strictly necessary is free and is the recommended default.

---

## Configuration

Local development reads `.env`. Cloud Run receives the same names as environment
variables injected from Secret Manager.

| Variable | Secret Manager name | Effect when unset |
|---|---|---|
| `DATABASE_URL` | `database-url` | Falls back to localhost; the API cannot serve data |
| `SITE_URL` | `site-url` | Defaults to localhost; reviewer links point at the wrong host |
| `FIREBASE_CREDENTIALS_FILE` / `FIREBASE_PROJECT_ID` | `firebase-admin-credentials` | Falls back to ADC, then to the fake provider outside production |
| `GCS_ATTACHMENTS_BUCKET` / `GCS_AVATARS_BUCKET` | — | Download URLs come back `null`; upload requests return 503 |
| `RESEND_API_KEY` | `resend-key` | Email is logged and skipped |
| `NOTIFY_FROM_EMAIL` | `notify-from-email` | Defaults to the Resend sandbox sender |
| `SLACK_WEBHOOK_URL` | `slack-webhook` | Slack posts are skipped |
| `GROQ_API_KEY` | `groq-key` | `/ai/parse-estimate` returns 503 |
| `CORS_ORIGINS` | — | Only localhost may call from a browser |

Every integration credential is optional by design: the service boots and serves with
nothing provisioned, which is what makes local development and CI possible without a
GCP project.

### Connection budget

Cloud SQL `db-f1-micro` has a low connection ceiling and Cloud Run runs many instances,
each holding its own pool. Preserve this invariant:

```
cloud_run_max_instances × (DB_POOL_SIZE + DB_MAX_OVERFLOW) < postgres max_connections
```

Defaults are 2 + 3 = 5 per instance, so 10 instances fit inside `max_connections=50`.
Raising `--max-instances` means revisiting this, or introducing PgBouncer.

---

## Errors

Every non-2xx response, ours and FastAPI's alike, uses one envelope:

```json
{"error": {"code": "forbidden", "message": "This estimate is locked. Only the owner can edit it."}}
```

Codes: `unauthorized`, `forbidden`, `not_found`, `conflict`, `gone`,
`validation_failed`, `integration_unavailable`, `internal_error`. Internal errors never
leak exception text.

---

## Deliberate changes from the legacy Node backend

The API contract is **not** byte-compatible with the Netlify Functions. The old HTML
frontend is being replaced rather than preserved, so the contract was redesigned as
clean REST instead of frozen. Beyond the shape, these behaviours changed on purpose:

1. **Estimate visibility is enforced.** `GET /estimates` returned *every* estimate in
   the business to any authenticated user (`estimates.js:12`), while the equivalent
   projects endpoint already filtered by role. Members now see only their own.

2. **Project transitions are reversible.** The legacy rules only moved projects
   forward: a mistaken "paid" click closed a project permanently, and there was no path
   back to `active` at all. Un-paying a milestone now reopens the project, and
   reverting work status returns it to active.

3. **Derived status cannot be asserted.** `closed` and `pending_payment` are
   conclusions drawn from milestones and closing forms. `PATCH /projects/{id}/status`
   accepts only `active` and `cancelled`, so the stored status can never contradict the
   facts that determine it.

4. **The review flow returns JSON, and mutates only on POST.** The old handlers served
   hand-assembled HTML from serverless functions, and approve/reject were **GET links**
   — any email client or security scanner that prefetched the URL approved the estimate
   on the reviewer's behalf. The reviewer page is now a frontend route calling POST
   endpoints.

5. **Approval tokens are cryptographically random.** The legacy token was two
   `Math.random().toString(36)` slices plus a timestamp — roughly 40 bits of guessable
   entropy guarding the ability to approve a construction estimate. Now 256 bits from
   the system CSPRNG, compared in constant time.

6. **Re-submission is blocked while a decision is outstanding.** The old code would
   mint a second approval token, silently orphaning the first reviewer's link.

7. **Authorisation is declarative and central.** Each legacy handler re-derived its own
   answer inline, and they disagreed. Every route now declares its required role as a
   dependency, and no handler re-checks.

8. **Outbound work is off the request path.** Email, Slack, and calendar calls ran
   inline as `await Promise.all(...)`, so a slow provider added latency to every write
   and an outage failed requests that had already committed. All of it now runs in
   background tasks.

9. **Attachment paths are validated.** A caller could previously claim any object key
   in the bucket. Paths must now sit under the estimate's own prefix.

10. **Meeting invites are sent only on material changes.** The old code re-sent on any
    update touching attendees, which trained recipients to ignore invites. Recolouring
    a meeting no longer emails the team.

11. **One canonical `SITE_URL`.** The functions defaulted it to three different
    hardcoded hosts across four files.

12. **Money is `Decimal` end to end.** Totals were computed in floating point in both
    the browser and the review email, independently.

---

## Migration notes

The Alembic revision `0001_initial_schema` was generated from the models and verified
against Postgres 16 (applies and reverses cleanly). It reflects the post-cleanup schema
described in `01-database-migration.md`: RLS policies and the `handle_new_user` trigger
dropped, `profiles.id` preserved, `firebase_uid` added.

> **Before running it against migrated production data**, reconcile it with a real
> `pg_dump --schema-only` of the live Supabase database. Several columns that exist in
> production (`estimates.deleted_at`, `profiles.status`) are absent from the committed
> `supabase-schema.sql`, so the live database — not that file — is the source of truth.

---

## Not yet done

| Area | State |
|---|---|
| Firebase Auth | Interface complete, provider swappable. Needs a project, credentials, and the user import — see `docs/FIREBASE_SETUP.md` and `docs/USER_MIGRATION.md`. |
| Schema alignment | **Pending.** Migration `0001` has never been diffed against the live Supabase schema, and the committed `supabase-schema.sql` is an incomplete fragment. Procedure in `docs/DATABASE.md` §2. |
| Cloud SQL | Schema ready. Instance not provisioned; data not migrated — `docs/DATABASE.md` §3. |
| Cloud Storage | Adapter complete. Buckets not created, CORS not configured, objects not copied. |
| Resend / Slack / Groq / Calendar | Adapters complete. Keys not supplied. |
| Cloud Run deploy | `Dockerfile` ready. No service, no CI pipeline. |
| Frontend | Not started (Phase 2). |
