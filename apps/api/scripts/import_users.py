"""Import Supabase Auth users into Firebase Auth.

Companion to ``docs/USER_MIGRATION.md`` §4, which this script replaces as the thing that
actually runs. It used to live only as a fenced code block in that document; the version
that runs on cutover day should be the version that was reviewed and can be diffed.

Reads the CSV produced by ``docs/USER_MIGRATION.md`` §3:

    id, email, encrypted_password, full_name, role, status, email_verified

**Idempotent.** The Supabase uuid is reused as the Firebase uid, so re-running reports
existing users as failures and changes nothing. A partial run can simply be repeated.
That also makes the two systems trivially cross-referenceable when debugging, though
nothing depends on it — ``profiles.firebase_uid`` is linked by *email*, not by uid.

Two cohorts, handled differently:

* **With a password hash** — imported with ``UserImportHash.bcrypt()`` so people sign in
  with the password they already have and never learn a migration happened. Supabase
  stores bcrypt (``$2a$``/``$2b$``/``$2y$``); confirm before trusting it with
  ``select left(encrypted_password, 4) from auth.users limit 1``.
* **Without one** — OAuth-only accounts. Created with no password; they sign in with
  Google. Handing them a password here would be inventing a credential nobody asked for.

Users whose profile ``status`` is ``banned`` are imported **disabled**. Migrating them
enabled would silently restore access to people who were deliberately cut off, which is
the kind of thing nobody notices until it matters.

    uv run python scripts/import_users.py <service-account.json> [--csv supabase_users.csv]
    uv run python scripts/import_users.py <service-account.json> --dry-run

The input carries password hashes. Treat it exactly as you would the service-account key:
off shared drives, out of the repo, deleted once the migration is verified.
"""

from __future__ import annotations

import argparse
import csv
import pathlib
import sys

import firebase_admin
from firebase_admin import auth, credentials

#: Firebase's hard limit for a single ``import_users`` call.
BATCH = 500


def read_rows(path: pathlib.Path) -> list[dict[str, str]]:
    fields = ["id", "email", "password_hash", "full_name", "role", "status", "verified"]
    with path.open(encoding="utf-8", newline="") as handle:
        rows = [dict(zip(fields, row, strict=True)) for row in csv.reader(handle) if row]
    return rows


def build(row: dict[str, str]) -> auth.ImportUserRecord:
    return auth.ImportUserRecord(
        uid=row["id"],
        email=row["email"],
        email_verified=row["verified"] in ("t", "true", "True"),
        display_name=row["full_name"] or None,
        disabled=row["status"] == "banned",
        # A convenience for the frontend's initial render only. The backend always reads
        # profiles.role from Postgres — a claim is stale until the client refreshes its
        # token, so authorising from one would honour a revoked role for up to an hour.
        custom_claims={"role": row["role"]},
        password_hash=row["password_hash"].encode() if row["password_hash"] else None,
    )


def import_batch(users: list[auth.ImportUserRecord], *, hashed: bool) -> int:
    """Import one cohort, returning the failure count."""
    failures = 0
    kwargs = {"hash_alg": auth.UserImportHash.bcrypt()} if hashed else {}

    for start in range(0, len(users), BATCH):
        batch = users[start : start + BATCH]
        result = auth.import_users(batch, **kwargs)  # type: ignore[arg-type]
        label = "hashed" if hashed else "oauth"
        print(
            f"  {label} batch {start // BATCH + 1}: "
            f"{result.success_count} ok, {result.failure_count} failed"
        )
        for error in result.errors:
            failures += 1
            print(f"    row {error.index} ({batch[error.index].email}): {error.reason}")

    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description="Import Supabase users into Firebase Auth.")
    parser.add_argument("service_account", help="path to the Firebase admin JSON key")
    parser.add_argument("--csv", default="supabase_users.csv", help="input CSV")
    parser.add_argument("--map", default="firebase_user_map.csv", help="uid/email map to write")
    parser.add_argument("--dry-run", action="store_true", help="report the split, import nothing")
    args = parser.parse_args()

    rows = read_rows(pathlib.Path(args.csv))
    print(f"read {len(rows)} rows")

    hashed = [build(r) for r in rows if r["password_hash"]]
    oauth = [build(r) for r in rows if not r["password_hash"]]
    banned = sum(1 for r in rows if r["status"] == "banned")
    print(f"{len(hashed)} with passwords, {len(oauth)} OAuth-only, {banned} to be disabled")

    if args.dry_run:
        print("\ndry run — nothing imported")
        return 0

    firebase_admin.initialize_app(credentials.Certificate(args.service_account))

    failures = 0
    if hashed:
        failures += import_batch(hashed, hashed=True)
    if oauth:
        failures += import_batch(oauth, hashed=False)

    # The map the SQL backfill in USER_MIGRATION.md §5 joins on. Written from Firebase
    # rather than from the CSV so it reflects what is actually there after the import,
    # including any account created by hand beforehand.
    with pathlib.Path(args.map).open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        count = 0
        for user in auth.list_users().iterate_all():
            writer.writerow([user.uid, (user.email or "").lower()])
            count += 1

    print(f"\nwrote {count} rows to {args.map}")
    print(f"done: {failures} failures")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
