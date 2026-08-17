# User Migration — Supabase Auth → Firebase Auth

Moving existing users off Supabase Auth without losing their identity, their passwords,
or the foreign keys that point at them.

**Prerequisite:** [`FIREBASE_SETUP.md`](FIREBASE_SETUP.md) complete through §6.

---

## 1. What actually has to move

Only the *credentials* move. The business data does not.

```
Supabase                              Firebase + Cloud SQL
────────────────────────              ─────────────────────────────
auth.users                    ──────► Firebase Auth users
  id (uuid)                             uid (string)
  email                                 email
  encrypted_password (bcrypt)           passwordHash

public.profiles               ──────► profiles  (unchanged, plus one column)
  id (uuid)  ◄── every FK               id (uuid)  ◄── every FK, SAME VALUE
  email                                 email
  role, status, avatar_url, …           role, status, avatar_url, …
                                        firebase_uid  ← NEW, links to Firebase
```

**The load-bearing decision: `profiles.id` does not change.** It is referenced by
`estimates.created_by`, `estimates.submitted_by`, `estimates.deleted_by`,
`projects.assigned_to`, `projects.created_by`, `projects.closing_form_submitted_by`,
`payment_milestones.paid_by`, `project_supplements.linked_by`,
`project_activity.user_id`, `meeting_attendees.user_id`, `attachments.uploaded_by`,
`approval_requests.user_id` / `reviewed_by`, and `profiles.removed_by`.

Re-keying users onto Firebase UIDs would mean rewriting all fifteen of those columns
across every historical row. Instead, `profiles.firebase_uid` is added as a *link*, and
the internal id stays exactly as it is.

**Email is the join key** between the two systems. Everything below depends on emails
being unique and stable, which §2 verifies before anything is touched.

---

## 2. Pre-flight checks

Run these against the live Supabase database **before** starting. Each one catches a
failure mode that is painful to discover mid-migration.

```sql
-- 1. Duplicate emails differing only in case. Firebase treats these as one account;
--    Postgres does not. Resolve any hits by hand before proceeding.
select lower(email), count(*)
from public.profiles
group by lower(email) having count(*) > 1;

-- 2. Profiles with no email. They cannot be migrated — email is the join key.
select id, full_name from public.profiles where email is null or email = '';

-- 3. Auth users with no profile, and profiles with no auth user.
select u.id, u.email from auth.users u
  left join public.profiles p on p.id = u.id where p.id is null;
select p.id, p.email from public.profiles p
  left join auth.users u on u.id = p.id where u.id is null;

-- 4. The headcount you are migrating, and the role distribution to verify afterwards.
select role, status, count(*) from public.profiles group by 1, 2 order by 1, 2;

-- 5. Which accounts have passwords at all. OAuth-only users have none and must be
--    invited to sign in with Google rather than imported with a hash.
select
  count(*) filter (where encrypted_password is not null and encrypted_password <> '')
    as with_password,
  count(*) filter (where encrypted_password is null or encrypted_password = '')
    as oauth_only
from auth.users;
```

Record the counts. They are the acceptance criteria in §7.

---

## 3. Export from Supabase

```bash
mkdir -p migration && cd migration

psql "$SUPABASE_CONNECTION_STRING" -At -F',' -o supabase_users.csv <<'SQL'
select
  u.id,
  lower(u.email),
  coalesce(u.encrypted_password, ''),
  coalesce(p.full_name, ''),
  coalesce(p.role, 'member'),
  coalesce(p.status, 'active'),
  (u.email_confirmed_at is not null) as email_verified
from auth.users u
join public.profiles p on p.id = u.id
order by u.created_at;
SQL

wc -l supabase_users.csv          # must match the §2 headcount
```

> `supabase_users.csv` contains password hashes. Keep it off shared drives, out of the
> repo, and delete it once §7 passes. Treat it exactly as you would the service-account
> key.

**Choosing between two paths:**

| | Import hashes | Password reset |
|---|---|---|
| User experience | Signs in with their existing password. Nothing to explain. | Everyone gets a reset email on cutover day. |
| Risk | Hash format must be right, or nobody can sign in | None — passwords are re-established from scratch |
| Effort | One import script | One bulk email, plus support for whoever misses it |

Import hashes if the team is more than a handful of people. For a small internal team
where everyone is reachable, the reset path is simpler and carries no format risk —
and if the import turns out to be wrong, §8 falls back to it anyway.

---

## 4. Import into Firebase

`firebase-admin` is already a dependency of the API, so this runs in the same
environment.

Save as `migration/import_users.py`:

```python
"""Import Supabase users into Firebase Auth.

Idempotent: users that already exist are reported and skipped, so a partial run can be
repeated safely. Writes firebase_user_map.csv for the SQL backfill in §5.
"""

import csv
import sys

import firebase_admin
from firebase_admin import auth, credentials

BATCH = 500  # Firebase's import_users limit per call

cred = credentials.Certificate(sys.argv[1])  # path to the service-account JSON
firebase_admin.initialize_app(cred)

rows = list(csv.reader(open("supabase_users.csv", encoding="utf-8")))
print(f"read {len(rows)} rows")

to_import, oauth_only = [], []
for uid, email, password_hash, full_name, role, status, verified in rows:
    user = auth.ImportUserRecord(
        # Reuse the Supabase uuid as the Firebase uid. Not required — the link is by
        # email — but it makes the two systems trivially cross-referenceable when
        # debugging, and guarantees the import is idempotent.
        uid=uid,
        email=email,
        email_verified=verified == "t",
        display_name=full_name or None,
        # Users removed from the team stay removed. Migrating them as enabled would
        # silently restore access to people who were deliberately cut off.
        disabled=status == "banned",
        # Convenience for the frontend only. The backend always reads the database.
        custom_claims={"role": role},
        password_hash=password_hash.encode() if password_hash else None,
    )
    (to_import if password_hash else oauth_only).append(user)

print(f"{len(to_import)} with passwords, {len(oauth_only)} OAuth-only")

# Supabase stores bcrypt. Confirm with: select encrypted_password from auth.users limit 1;
# A bcrypt hash starts with $2a$, $2b$, or $2y$.
hash_config = auth.UserImportHash.bcrypt()

failed = 0
for start in range(0, len(to_import), BATCH):
    batch = to_import[start : start + BATCH]
    result = auth.import_users(batch, hash_alg=hash_config)
    print(f"batch {start // BATCH + 1}: {result.success_count} ok, {result.failure_count} failed")
    for error in result.errors:
        failed += 1
        print(f"  row {error.index}: {error.reason}")

# OAuth-only users are created without a password; they sign in with Google.
for start in range(0, len(oauth_only), BATCH):
    result = auth.import_users(oauth_only[start : start + BATCH])
    print(f"oauth batch: {result.success_count} ok, {result.failure_count} failed")

with open("firebase_user_map.csv", "w", newline="", encoding="utf-8") as handle:
    writer = csv.writer(handle)
    for user in auth.list_users().iterate_all():
        writer.writerow([user.uid, (user.email or "").lower()])

print(f"done: {failed} failures")
```

```bash
cd migration
uv run --project ../apps/api python import_users.py /path/to/firebase-admin.json
```

**Run it against `buildco-staging` first.** Sign in as a test user and confirm the
password works before touching production.

If bcrypt is not the algorithm in use, `auth.UserImportHash` also offers
`scrypt`, `standard_scrypt`, `hmac_sha256`, `pbkdf2_sha256`, and others — the
parameters come from **Authentication → Users → ⋮ → Password hash parameters**.

---

## 5. Backfill `profiles.firebase_uid`

After the business data is loaded into Cloud SQL (a separate step — see
`01-database-migration.md`), link the two systems:

```sql
create temporary table firebase_user_map (firebase_uid text, email text);
\copy firebase_user_map from 'firebase_user_map.csv' with (format csv)

begin;

update profiles p
set firebase_uid = m.firebase_uid
from firebase_user_map m
where lower(p.email) = lower(m.email)
  and p.firebase_uid is null;

-- Must return zero rows. Any hit means one Firebase account would be reachable from
-- two profiles, and whichever the lookup found first would win non-deterministically.
select firebase_uid, count(*) from profiles
where firebase_uid is not null
group by 1 having count(*) > 1;

-- Expected to be empty. Anything here is a user who cannot sign in until the
-- fallback in §6 links them.
select id, email from profiles where firebase_uid is null;

commit;
```

---

## 6. The self-healing fallback

Stragglers do not need manual repair. `user_service.resolve_profile` handles them on
first sign-in:

1. Look up the profile by `firebase_uid` — the steady state after migration.
2. Not found? Look up by **email, case-insensitively**, and write `firebase_uid` onto
   that profile. The user is now linked and step 1 applies from then on.
3. Still nothing? Create a profile. The first profile in an empty database becomes the
   owner.

This is why the backfill in §5 does not have to be perfect, and why a user added in
Firebase after the migration works without any database step.

It is also why **duplicate emails are dangerous** and why §2 checks for them first: two
profiles sharing an email means step 2 can link the wrong one.

---

## 7. Verification

Run all of these before declaring the migration done.

```sql
-- 1. Every profile is linked.
select count(*) as unlinked from profiles where firebase_uid is null;   -- expect 0

-- 2. Roles survived. Compare against the §2 baseline.
select role, status, count(*) from profiles group by 1, 2 order by 1, 2;

-- 3. Exactly one owner (or however many you had).
select count(*) from profiles where role = 'owner';

-- 4. No foreign key was orphaned by the migration.
select 'estimates.created_by' as ref, count(*) from estimates e
  left join profiles p on p.id = e.created_by
  where e.created_by is not null and p.id is null
union all
select 'projects.assigned_to', count(*) from projects pr
  left join profiles p on p.id = pr.assigned_to
  where pr.assigned_to is not null and p.id is null
union all
select 'meeting_attendees.user_id', count(*) from meeting_attendees ma
  left join profiles p on p.id = ma.user_id
  where ma.user_id is not null and p.id is null;
-- every count must be 0
```

Then, against the API:

| Check | Expected |
|---|---|
| A migrated user signs in with their **old password** | Succeeds |
| `POST /auth/session` for them | `created: false`, `linked: false` — they were already backfilled |
| Their estimates and projects are visible | Same as before the migration |
| A user who was **removed** before migration signs in | Blocked; `GET /auth/status` reports `banned` and files one access request |
| The **owner** still has owner permissions | Can lock estimates and assign roles |
| A **member** sees only their own estimates | The visibility fix is in effect |
| Firebase user count | Matches the §2 headcount |

---

## 8. Rollback

Until DNS is cut over, rollback is simply *do not proceed* — Supabase is still live and
authoritative, and nothing described here modifies it. Every step reads from Supabase
and writes elsewhere.

| Problem | Response |
|---|---|
| Import fails partway | Re-run `import_users.py`. Reusing the Supabase uuid as the Firebase uid makes it idempotent — existing users are reported and skipped. |
| Hashes imported but passwords rejected | The hash algorithm is wrong. Delete the imported users, confirm the parameters, and re-import. Or fall back to reset emails (below) — no data is at risk either way. |
| Backfill linked the wrong profiles | `update profiles set firebase_uid = null;` and redo §5 after fixing the duplicate emails. |
| Need to abandon after cutover | Point DNS back at Netlify. Supabase data is unchanged, minus anything written since cutover — which is why the cutover window is short and off-hours. |

**Password-reset fallback**, at any point:

```python
for user in auth.list_users().iterate_all():
    if user.email:
        print(auth.generate_password_reset_link(user.email))
```

Send those links, and passwords are re-established with no dependence on the hash
import at all.

---

## 9. Order of operations on cutover day

1. Announce a short maintenance window. Off-hours; this is an internal tool.
2. Freeze writes to the legacy app.
3. Export users (§3) and business data (`01-database-migration.md` §4.1).
4. Apply the schema to Cloud SQL: `alembic upgrade head`.
5. Load business data.
6. Import users into Firebase (§4).
7. Backfill `firebase_uid` (§5).
8. Copy storage objects to GCS, preserving paths.
9. Run every verification in §7.
10. Deploy the API with `AUTH_DISABLED=false` and real credentials.
11. Smoke-test sign-in as owner, admin, and member.
12. Cut DNS over.
13. Delete `supabase_users.csv` and `firebase_user_map.csv`.
14. Monitor for one business cycle before decommissioning Supabase and Netlify.

Steps 3–9 are rehearsable against staging in full, and should be rehearsed at least
once before the real run.
