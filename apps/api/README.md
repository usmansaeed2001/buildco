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
    actions.py       the writes with more than one caller: checks, lock, follow-up work
  agent/             BuildCo Assistant's live voice conversation (see "BuildCo Assistant")
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
| POST | `/auth/session` | token | Exchange a Firebase token for a profile. Provisions new users, links migrated ones, makes the first user ever the owner. Call once after sign-in. Optional body `{invite_token}` accepts an invitation. |
| GET | `/auth/status?email=` | **public** | Pre-sign-in check: `active` / `banned` / `not_found`. Files one access request for a removed user. |
| GET | `/users/me` | any | |
| PATCH | `/users/me` | any | `full_name`, `phone` |
| POST | `/users/me/avatar-upload-url` | any | Signed PUT for a direct upload |
| PUT | `/users/me/avatar` | any | Record the URL after upload |
| GET | `/users` | any | Team roster |
| PATCH | `/users/{id}/role` | owner/admin | |
| POST | `/users/{id}/ban` | owner/admin | Also disables the Firebase user |
| POST | `/users/invite` | owner/admin | `{email, role, full_name?}`. Creates the profile and emails a join link. Only an owner may invite an owner. 409 if the address is already on the team, already invited, or was removed. |
| POST | `/users/{id}/invite/resend` | owner/admin | Fresh link; the previous one stops working |
| DELETE | `/users/{id}/invite` | owner/admin | Withdraws a pending invitation (deletes the profile). 409 once they have signed in — use the ban |
| GET | `/approval-requests` | owner/admin | `?status=pending` |
| POST | `/approval-requests/{id}/approve` | owner/admin | Restores access |
| POST | `/approval-requests/{id}/deny` | owner/admin | |

**Invitations.** An invited person is a `profiles` row created up front — `active`, with
the chosen role and no `firebase_uid` — so they are in the roster and assignable before
they have signed in (`invite_pending: true` on `UserOut`). They make their own account,
by password or Google, and `resolve_profile` links it on first sign-in.

Linking on a matching address alone would not be safe here: Firebase creates a password
account for any address without confirming it, so an invitation could be claimed by
whoever signed up with the invited address first, role included. A pending invitation
therefore links only with proof of the mailbox — either the identity provider vouches
for it (`email_verified`, which a Google sign-in always is) or the caller presents the
token from the invitation email. The token is single-use, valid for 7 days, and stored
only as a SHA-256 hash. Users migrated from Supabase have no invitation and link exactly
as before.

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
| GET | `/meetings` | any — `?from=&to=&project_id=&scope=`. Non-elevated callers see only what they created or were invited to |
| POST | `/meetings` | any — Meet link, ICS, invites |
| GET | `/meetings/{id}` | any + visibility (404 otherwise) |
| PATCH | `/meetings/{id}` | creator or owner/admin — re-invites only on a material change |
| DELETE | `/meetings/{id}` | creator or owner/admin — sends a cancellation ICS |

Attendees come in two kinds. `attendee_ids` invites team members; `attendee_emails`
(up to 50) invites anyone else by address — a guest is an attendee row with no
`user_id`, gets the same email and .ics, and has no view of the meeting in the app. An
address that belongs to a team member is recorded as that member, not as a guest. On
`PATCH` the two lists are independent: sending one leaves the other untouched.

Someone who has been removed from the team cannot be added to a meeting: that is a
**422**, by id or by address. If they are already on a meeting when they are removed,
they stay on it until its attendee list is next written, and that write takes them off
without being asked to.

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

### BuildCo Assistant

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/agent/status` | any | `{enabled, max_session_seconds}`. `enabled` is false when the assistant is off, and for anyone outside the pilot list |
| POST | `/agent/sessions` | any | Starts a conversation; returns a single-use `ticket` and the `ws_url` to open. 503 when off, 403 outside the pilot list. Ends any other conversation the caller has |
| GET | `/agent/conversations/{id}` | owner of it | Transcript and actions. 404 for anyone else's, owners and admins included |
| WS | `/agent/live?ticket=` | ticket | The voice stream. Mounted only when `AGENT_SERVE_LIVE` is set |

See "BuildCo Assistant" below for how the pieces fit.

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

Each action is available only from certain statuses. Taking one from any other status
is a **409**; a role that may never take it is a 403, checked first.

| Action | Available from |
|---|---|
| `archive` | active, rejected, approved |
| `unarchive` | archived |
| `lock` | active |
| `unlock` | locked |
| `recall` | submitted |
| `resubmit_ready` | changes_requested |
| `admin_approve` | active, submitted, changes_requested, rejected |

The table lives in `estimate_rules.TRANSITIONS` and is mirrored by
`availableTransitions` in `staff-web/src/domain/estimateRules.ts`, which decides which
buttons are drawn. Change one and you must change the other; each side has a test that
pins the matrix.

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

**The tests do not use your `.env` for anything that leaves the machine.**
`tests/conftest.py` sets every integration below to empty before the settings load,
refuses to start if one is still configured, and makes any real HTTP request raise.
It was not always so: the suite once posted every test submission to the real Slack
channel, because a production webhook was in a local `.env` and removing a variable
from the environment does not stop pydantic-settings reading the file. Even so, keep
production secrets out of a local `.env`: the dev server uses whatever is there. A new
integration setting goes in `OUTBOUND_SETTINGS` in that file, and
`tests/unit/test_isolation.py` fails until it does.

| Variable | Secret Manager name | Effect when unset |
|---|---|---|
| `DATABASE_URL` | `database-url` | Falls back to localhost; the API cannot serve data |
| `SITE_URL` | `site-url` | Defaults to localhost; reviewer links point at the wrong host |
| `FIREBASE_CREDENTIALS_FILE` / `FIREBASE_PROJECT_ID` | `firebase-admin-credentials` | Falls back to ADC, then to the fake provider outside production |
| `GCS_ATTACHMENTS_BUCKET` / `GCS_AVATARS_BUCKET` | — | Download URLs come back `null`; upload requests return 503 |
| `RESEND_API_KEY` | `resend-key` | Email is logged and skipped |
| `NOTIFY_FROM_EMAIL` | `notify-from-email` | Defaults to the Resend sandbox sender |
| `SLACK_WEBHOOK_URL` | `slack-webhook` | Slack posts are skipped |
| `OPEN_AI_API_KEY` | `openai-key` | Falls back to Groq; `/ai/parse-estimate` returns 503 if that is unset too. Note the spelling — **not** `OPENAI_API_KEY` |
| `GROQ_API_KEY` | `groq-key` | Fallback only, for one release. Remove once OpenAI is configured everywhere |
| `CORS_ORIGINS` | — | Only localhost may call from a browser. Also the origins a voice WebSocket is accepted from |
| `AGENT_ENABLED` | — | The assistant reports itself disabled; nothing else changes |
| `AGENT_AUDIENCE` / `AGENT_PILOT_EMAILS` | — | Audience is `pilot` and the list is empty, so **nobody** gets the assistant |
| `AGENT_SERVE_LIVE` | — | This process does not mount the voice WebSocket or load ADK |
| `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` | — | Project comes from the credentials if they name one; location is `us-central1` |
| `AGENT_MODEL` / `AGENT_VOICE` | — | `gemini-3.8-live`, `Kore` |
| `AGENT_WS_BASE_URL` | — | `ws://localhost:8000`. In production, the `buildco-agent` service's `wss://` origin |

Every integration credential is optional by design: the service boots and serves with
nothing provisioned, which is what makes local development and CI possible without a
GCP project.

A process started with `AGENT_SERVE_LIVE=true` is the exception to "optional by design".
In staging and production it **refuses to start** without `RESEND_API_KEY`, a `SITE_URL`
that is not localhost, and a `NOTIFY_FROM_EMAIL` that is not the Resend sandbox sender.
It is the process that sends the invites and reviewer emails for what the assistant
commits, and a missing key there would otherwise mean a user is told a meeting was
created that nobody was invited to.

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

## BuildCo Assistant

A voice assistant in the staff app. A signed-in user talks or types to it, and it
stages a change on the real screen for them to approve. **It writes nothing until the
user approves the exact values**, and that is enforced by this API, not left to the
model. The full design is `AGENT_SPEC.md` at the repository root. What is built so far
is the first slice: scheduling a new meeting.

**Two services, one image.** Firebase Hosting does not proxy WebSockets, so the voice
stream connects straight to Cloud Run. The same image is deployed twice: `buildco-api`
serves everything in this document including the REST endpoints above, and
`buildco-agent` (`AGENT_SERVE_LIVE=true`) serves only the WebSocket and is the only one
that loads ADK. Locally one process does both.

**Starting a conversation.** A browser cannot put an `Authorization` header on a
WebSocket, so `POST /agent/sessions` issues a ticket: single-use, valid for a minute,
stored only as a hash. The socket is admitted on that ticket and its `Origin`.

**Propose, then commit** (`app/agent/proposals.py`). A proposal is a row in
`agent_actions` holding the payload that would be written. A commit names a proposal and
carries no values of its own, so what is saved is what was on screen. The commit claims
the row with a guarded `UPDATE`, which is what makes a click and a spoken "yes" arriving
together produce one meeting, and then goes through `services/actions.py`, the same
function the HTTP route uses.

**Whether a spoken "yes" counts** (`agent_rules.refuse_voice_commit`). Only if the
read-back finished playing on the user's device, and the approving utterance began after
that. Both are positions in the microphone stream, so no clocks are compared. Anything
that sends email cannot be approved by voice at all. In testing the model committed on a
"yes" that interrupted the read-back every time it was tried, against its instructions;
this rule is why that does nothing.

**What the model is told again.** A model session is replaced about every ten minutes,
a replacement can fail, and early turns can fall out of its memory. So each time a
model session starts, its instructions carry what the server holds: what has been
committed, what is open, and the recent transcript (`app/agent/instruction.py`).

**Nothing said goes into logs.** The SDK loggers are pinned to WARNING in
`app/logging.py` because at DEBUG they log every event, transcripts included.

**Testing it.** `tests/agent_fakes.py` has a scripted model and a fake browser.
`tests/api/test_agent_conversation.py` runs whole conversations against them, including
the things the real model was seen doing wrong.

Not built yet: the other kinds of change, memory, history in the app, the daily
allowance, the pause while waiting for approval, verification of what was actually said
in a read-back, and recovery from a dropped browser connection.

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

13. **Line-item `category` and `unit` are bounded strings, not enums.** They were enums
    at first, and that made two things impossible. A team can define its own units and
    categories in Settings, and a value you can define but cannot use is not a setting —
    picking "Roll" on a line was a 422 for the whole estimate. And documents written by
    the legacy app contain `electrical` and `plumbing`, so the only way to keep such an
    estimate saveable was to rewrite those rows to `other` on every save, silently
    destroying a classification someone had chosen. Nothing computes on either field:
    totals use `quantity * unitCost`, and the category only picks a swatch colour. The
    enums remain what the UI *offers*.

## Deliberate changes to this API since the port

Changes to behaviour this API itself used to have. Each has a test named for it, so
nobody "fixes" it back.

1. **A transition is refused from a status it is not offered from (409).**
   `POST /estimates/{id}/transitions` used to check the caller's role and nothing else,
   so any action could be applied in any status; only the browser, by not drawing the
   button, stood in the way. That left real holes: an admin could `archive` and then
   `unarchive` a locked estimate and so undo the owner-only lock, and a member could
   `recall` an approved estimate back to active. See the table under "Estimate state
   machine".

2. **Removed people cannot be invited to meetings (422), and are dropped from meetings
   they were already on.** The API used to accept any profile id as an attendee and
   email them. Adding one is now refused. One who is already on a meeting comes off it
   the next time its attendee list is written — dropped, not refused, because the
   meeting form sends back everyone on the meeting, including a removed person it does
   not display, and a refusal would make that meeting uneditable.

3. **The services enforce what only the routes used to.** `meeting_service.update_meeting`
   now checks that the actor may change the meeting, and the project read functions
   (`list_milestones`, `list_supplements`, `list_activity`) take the actor and apply the
   project access rule. Nothing changes for HTTP callers, who were already checked at
   the route. What changes is that a caller which is not a route gets the same answer.

4. **Writes to a meeting or an estimate take a row lock.** Including the ones that do
   not write the row itself: a change to a meeting's attendees, and a photo recorded
   against an estimate. Two writers to the same record now run one after the other.
   Nothing is visible to a single user; it removes a class of lost update.

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
| Frontend | Complete — every route in `apps/staff-web` is built. |
