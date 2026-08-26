# Database — Local Setup, Schema Alignment, and Migration

Three separate concerns, in the order they matter:

1. **[Local development](#1-local-development)** — done. Docker Compose, works today.
2. **[Schema alignment](#2-schema-alignment)** — pending. Reconciling migration `0001`
   with the real Supabase schema before it ever meets production data.
3. **[Cloud SQL migration](#3-cloud-sql-migration)** — pending. Provisioning and the
   one-time data move.

---

## 1. Local development

**Postgres runs in Docker. Nothing is installed on the host.**

That is a deliberate choice: one setup path that is identical on every machine, and a
new contributor needs Docker and nothing else. It also removes a failure mode that is
genuinely nasty to diagnose — a host Postgres already listening on the port, so the
connection succeeds against the *wrong server* and fails with
`password authentication failed` rather than anything that points at the real cause.

### Start it

```bash
cd apps/api
docker compose up -d db      # first run pulls postgres:16-alpine
uv run alembic upgrade head  # create the schema
```

That is the whole setup. `docker compose down` stops it; `docker compose up -d db`
brings it back with all data intact.

### Connection

```
postgresql+asyncpg://buildco:buildco@localhost:5432/buildco
```

Already the default in `.env.example`.

Port 5432, the standard one, because no contributor is expected to have Postgres
installed on the host.

**If `docker compose up` fails to bind port 5432**, something else is already
listening — almost always a host Postgres installed by an installer or Homebrew. Stop
and disable it rather than changing the port here, so everyone keeps the same
connection string:

```powershell
# Windows: find the service, then stop and disable it
Get-Service -Name "postgres*"
Stop-Service -Name "postgresql-x64-NN"
Set-Service  -Name "postgresql-x64-NN" -StartupType Disabled
```

```bash
# macOS (Homebrew)
brew services stop postgresql

# Linux
sudo systemctl stop postgresql && sudo systemctl disable postgresql
```

This matters more than it looks. A host Postgres on 5432 does not produce a clean
"port in use" error in every case — if Docker's bind fails but the client still
resolves `localhost:5432`, you connect to the **wrong server** and get
`password authentication failed`, which points nowhere near the actual cause.

### Data persistence

Data lives in a Docker **named volume**, `buildco-pgdata`, not inside the
container. It survives:

| Action | Data survives? |
|---|---|
| `docker compose stop` / `start` | Yes |
| `docker compose down` (no `-v`) — container destroyed | **Yes** |
| Docker Desktop restart, machine reboot | Yes |
| `docker compose down -v` | **No — this is the delete switch** |
| `docker volume rm buildco-pgdata` | **No** |

Verified by inserting a row, running `docker compose down`, bringing it back up, and
confirming the row was still there.

A named volume is used rather than a bind mount to a project folder deliberately.
Postgres needs specific ownership and permissions on its data directory, and bind
mounts on Windows and macOS do not reproduce those faithfully — the usual result is a
container that refuses to start with a permissions error. Named volumes are managed by
Docker and behave identically on all three platforms.

Inspect it with:

```bash
docker volume inspect buildco-pgdata
```

### Resetting

```bash
docker compose down -v          # destroys the volume and everything in it
docker compose up -d db
uv run alembic upgrade head
```

### Test database

The test suite runs on SQLite by default, so it needs none of this. To run it against
Postgres the way CI should:

```bash
docker exec buildco-db createdb -U buildco buildco_test
TEST_DATABASE_URL=postgresql+asyncpg://buildco:buildco@localhost:5432/buildco_test uv run pytest
```

**Use a separate database.** The suite calls `create_all` and `drop_all`, so pointing
it at `buildco` wipes your development data.

### Useful commands

```bash
docker compose logs -f db                            # server log
docker exec -it buildco-db psql -U buildco -d buildco  # interactive shell
docker exec buildco-db psql -U buildco -d buildco -c "\dt"   # list tables
docker exec buildco-db pg_dump -U buildco buildco > backup.sql
```

### Version

`postgres:16-alpine`, matching the Cloud SQL target (`POSTGRES_16`). Keep them aligned:
a local version ahead of production can accept syntax that fails on deploy.

---

## 2. Schema alignment

**Status: types and defaults aligned; nullability unverified.** `0001` has been
regenerated against the live column inventory. Two checks still need to run against
production — see [Outstanding](#outstanding-two-queries-against-production) below.

### The problem

`alembic/versions/0001_initial_schema.py` was generated from the SQLAlchemy models,
which were written from the legacy JavaScript and the committed `supabase-schema.sql`.
It applies and reverses cleanly against Postgres 16 — but it has never been compared
against the **actual live Supabase database**, and the checked-in schema file is known
to be incomplete.

Columns the legacy code reads and writes that do **not** appear in
`supabase-schema.sql`:

- `estimates.deleted_at`, `estimates.deleted_by` (soft delete / trash)
- `estimates.approval_token`, `submitted_to`, `submitted_at`, `submitted_by`,
  `reviewed_at`, `review_note`
- `profiles.status`, `profiles.avatar_url`, `profiles.phone`, `removed_by`,
  `removed_at`
- Every column of `projects`, `payment_milestones`, `project_supplements`,
  `project_activity`, `meetings`, `meeting_attendees`, `attachments`, and
  `approval_requests` — those tables are absent from the file entirely.

So the live database is the source of truth, and the committed file is a stale
fragment. Anything inferred from code alone can be wrong about nullability, defaults,
column order, and types in ways that only surface when real data fails to load.

### The procedure

**Step 1 — capture the real schema.**

```bash
pg_dump "$SUPABASE_CONNECTION_STRING" \
  --schema-only --no-owner --no-privileges --schema=public \
  -f supabase_actual_schema.sql
```

Commit this to `docs/reference/` as evidence. It is what every later disagreement gets
settled against.

**Step 2 — capture what our models produce.**

```bash
docker compose down -v && docker compose up -d db
uv run alembic upgrade head
docker exec buildco-db pg_dump -U buildco --schema-only --no-owner buildco \
  > buildco_generated_schema.sql
```

**Step 3 — diff them, table by table.** For each table, compare column names, types,
nullability, defaults, and constraints. Expect differences, and sort each into one of
three buckets:

| Bucket | Meaning | Action |
|---|---|---|
| **Model is wrong** | Live has a column or constraint we missed, or a different type | Fix the model, regenerate `0001` |
| **Deliberate change** | We changed it on purpose (dropped RLS, added `firebase_uid`) | Record it in the table below |
| **Legacy cruft** | Unused column, orphaned index, dead default | Decide explicitly: carry it over or drop it. Do not decide by accident. |

A useful mechanical starting point:

```sql
-- Run against both databases and diff the output.
select table_name, column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
order by table_name, column_name;
```

**Step 4 — regenerate `0001` and re-verify.** Because nothing has been deployed yet,
`0001` can still be rewritten rather than patched. Once it has run anywhere real, that
stops being true and every change becomes a new revision.

```bash
rm alembic/versions/0001_initial_schema.py
docker compose down -v && docker compose up -d db
uv run alembic revision --autogenerate -m "initial schema"
# read it line by line, then:
uv run alembic upgrade head && uv run alembic downgrade base && uv run alembic upgrade head
uv run pytest
```

**Step 5 — rehearse the load.** Restore a real Supabase dump into a scratch database
built by `0001`. Data that refuses to load is the alignment problem announcing itself,
and it is much cheaper to find here than during the cutover window.

### Changes made on purpose

These are intentional and must **not** be "corrected" back during alignment:

| Change | Reason |
|---|---|
| RLS policies dropped | Dead code. Every function used the service key, which bypasses RLS entirely, so the policies enforced nothing. Authorisation is in the API layer. |
| `handle_new_user()` trigger dropped | Fired on Supabase's `auth.users`, which does not exist after the move. Replaced by the provisioning path in `POST /auth/session`. |
| `handle_updated_at()` trigger dropped | Replaced by SQLAlchemy `onupdate`, which keeps the behaviour visible in the model. |
| `profiles.firebase_uid` added | Links a profile to its Firebase identity. See [`USER_MIGRATION.md`](USER_MIGRATION.md). |
| `profiles.id` **unchanged** | Fifteen FK columns reference it. Re-keying would mean rewriting every historical row. |
| `project_supplements` unique constraint added | The old code could link the same estimate to a project twice. |
| Money columns are `NUMERIC(12,2)` | Totals were previously computed in floating point. |
| Enum columns are `text` + `CHECK` | Matches what transfers from Supabase, and avoids the awkwardness of altering a Postgres `ENUM` inside a transaction. |
| `created_at` / `updated_at` on every table | `TimestampMixin`. Live has `updated_at` only on `estimates`. Both are `NOT NULL DEFAULT now()`, so existing rows acquire a value on load rather than failing. |
| `project_supplements.linked_at`, not `created_at` | The live column is named `linked_at`. `TimestampMixin` was silently renaming it — a column that would have been dropped on load. This table is exempt from the mixin; a link row is created and deleted, never updated, so it has no `updated_at`. |
| `meeting_attendees.user_id` nullable | Live has it `NOT NULL`. Ours is looser, so every live row still loads. Keeps the door open for non-staff attendees. |
| `id` has no `gen_random_uuid()` default | Ids are generated in Python so a parent and its children can be written in one flush. See `models/base.py`. Anything inserting by raw SQL must supply an id. |
| Text columns are `varchar(N)`, not `text` | Bounded at the API boundary too. **This is a tightening** — see the length check below. |

### Outstanding: two queries against production

Everything above is settled. What is *not* settled is whether live **data** fits the
constraints, and that cannot be inferred from the column inventory alone.

Our schema is stricter than live in two ways. Both are safe for new writes and both
can reject an existing row at load time:

1. **31 columns are `NOT NULL` where live allows `NULL`.** Live pairs a default with a
   nullable column, so the default only applies when the column is omitted — a row that
   wrote an explicit `NULL` still holds one.
2. **33 columns are `varchar(N)` where live is unbounded `text`.**

Run these against production and expect all-zeros. Anything non-zero is a row to
backfill or a cap to raise, decided before the cutover, not during it:

```bash
psql "$SUPABASE_CONNECTION_STRING" -f docs/reference/verify_nulls.sql
psql "$SUPABASE_CONNECTION_STRING" -f docs/reference/verify_lengths.sql
```

**Also still missing: a real `pg_dump`.** `docs/reference/supabase_actual_schema.sql`
currently contains a connection error, not a schema — the direct Supabase host resolves
to IPv6 only and was unreachable. Use the **Session pooler** connection string from the
Supabase dashboard (Project Settings → Database), which is IPv4, and re-run Step 1.

Until that dump exists, the alignment rests on a column inventory that is missing
**indexes, foreign keys, unique constraints, and check constraints entirely** — and the
CSV it came from was truncated by the SQL editor's 100-row cap, cutting off partway
through `projects`. `projects` columns from `amount_collected` onward are therefore
unconfirmed against live.

---

## 3. Cloud SQL migration

**Status: not started.** Full procedure in `migration-docs/01-database-migration.md`;
this section covers what is specific to this codebase.

### Provisioning

```bash
gcloud sql instances create buildco-db \
  --database-version=POSTGRES_16 \
  --edition=ENTERPRISE \
  --tier=db-f1-micro \
  --region=us-central1 \
  --storage-type=SSD --storage-size=10GB --storage-auto-increase \
  --backup-start-time=09:00 \
  --enable-point-in-time-recovery \
  --database-flags=max_connections=50

gcloud sql databases create buildco --instance=buildco-db
gcloud sql users create buildco_app --instance=buildco-db --password=<from-secret-manager>
```

**`--edition=ENTERPRISE` is not optional.** Cloud SQL now defaults new instances to
`ENTERPRISE_PLUS`, which has no shared-core tiers, so omitting the flag fails with:

```
Invalid Tier (db-f1-micro) for (ENTERPRISE_PLUS) Edition.
Use a predefined Tier like db-perf-optimized-N-* instead.
```

The error names the tier, so the natural reading is that `db-f1-micro` is wrong. It is
not — the *edition* is. The smallest ENTERPRISE_PLUS tier costs several times more and
buys nothing this workload needs.

Generate the password with **alphanumeric characters only**. `app/db.py` passes
`DATABASE_URL` to asyncpg verbatim and percent-encodes nothing, so a `@`, `/`, `%` or
`:` in it silently corrupts the URL into a connection error that points nowhere near
the password. Store it in Secret Manager as `db-app-password` at the same time, with
`printf` rather than `echo` — see `DEPLOY_CLOUD_RUN.md` §4.

Do the same for staging. Validating a migration against staging before production is
the entire point of having one.

### Connecting from Cloud Run

The Cloud SQL connector exposes a Unix socket. Build `DATABASE_URL` against it:

```
postgresql+asyncpg://buildco_app:PASSWORD@/buildco?host=/cloudsql/PROJECT:REGION:INSTANCE
```

Deploy with `--add-cloudsql-instances=PROJECT:REGION:INSTANCE`, and inject the URL from
Secret Manager rather than setting it inline.

### The connection budget

`db-f1-micro` has roughly 0.6 GB RAM and a low connection ceiling. Cloud Run runs many
instances, each holding its own pool. Preserve:

```
max_instances × (DB_POOL_SIZE + DB_MAX_OVERFLOW) < max_connections
```

Defaults are 2 + 3 = 5 per instance, so 10 instances fit inside `max_connections=50`.
Raising `--max-instances` means revisiting this or introducing PgBouncer. Exceeding it
does not degrade gracefully — it fails requests with connection errors under exactly
the load that caused the scale-up.

### Running migrations against Cloud SQL

Run `alembic upgrade head` as a **Cloud Run Job**, not from a CI runner. The job has
the same Cloud SQL connectivity and the same service account as the app, so it cannot
succeed in an environment the app then fails in.

Staging first, always. Promote to production on explicit approval.

### Data load order

Foreign keys dictate the sequence:

```
profiles
  → estimates, projects, meetings
    → payment_milestones, project_supplements, project_activity,
      meeting_attendees, attachments
      → approval_requests
```

### Migration discipline

Deploy and migrate are two separate acts, so a migration must be **backward-compatible
with the code currently running** (expand/contract):

1. Release A: add the nullable column. Old code ignores it.
2. Release B: ship code that writes it.
3. Backfill existing rows.
4. Release C: add the `NOT NULL` constraint.

Collapsing these into one release means a window where deployed code and live schema
disagree. Also: never edit an applied revision, always write a working `downgrade()`,
and never run anything destructive without a fresh verified backup.

---

## Checklist before production data touches this schema

- [ ] `pg_dump --schema-only` of live Supabase captured and committed — **blocked on
      IPv6; use the Session pooler string.** Needed for indexes, FKs, and constraints,
      none of which the column CSV carries
- [x] Diffed against the generated schema, table by table — columns only
- [x] Every column difference triaged as model bug / deliberate / cruft
- [x] `0001` regenerated and reviewed line by line
- [x] Applies and reverses cleanly (`upgrade` → `downgrade base` → `upgrade`)
- [x] `alembic check` reports no drift; suite green on SQLite and Postgres
- [ ] `verify_nulls.sql` returns all zeros against production
- [ ] `verify_lengths.sql` returns all zeros against production
- [ ] `projects` columns past `reimbursements` confirmed against live (CSV was truncated)
- [ ] A real Supabase data dump loads into it without error
- [ ] Row counts match the source after load
- [ ] FK integrity verified (see [`USER_MIGRATION.md`](USER_MIGRATION.md) §7)
- [ ] Cloud SQL provisioned with backups and PITR enabled
- [ ] Connection budget checked against `--max-instances`
- [ ] Rehearsed end to end against staging at least once
