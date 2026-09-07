"""Recompute ``estimates.total_amount`` from ``rooms`` for every row.

**Run this after loading Supabase data into a fresh database.**

``total_amount`` is a denormalised column that does not exist in Supabase — it was
introduced by revision ``b7c4e1f2a930``, whose backfill ran against a database that was
still empty. Rows arriving later by ``COPY`` therefore carry the column default, and a
straight load leaves every estimate reading **$0.00** while its ``rooms`` document holds
the real line items. Nothing errors; the list is simply wrong, and the sort-by-total
index sorts a column of zeroes.

Uses ``estimate_totals.compute`` — the same function ``_sync_total`` calls on every
write — rather than reimplementing the arithmetic, so a backfilled row and a row the app
wrote agree to the cent. (The migration deliberately carries its own copy: a migration
must keep working when app code moves under it. A one-off script has the opposite
requirement.)

Idempotent: recomputing a correct total writes the same value. Safe to re-run.

    uv run python scripts/backfill_estimate_totals.py            # apply
    uv run python scripts/backfill_estimate_totals.py --dry-run  # report only
"""

from __future__ import annotations

import argparse
import asyncio

from sqlalchemy import select

from app.db import get_session_factory
from app.models.estimate import Estimate
from app.services.rules import estimate_totals

BATCH = 500


async def backfill(*, dry_run: bool) -> int:
    changed = 0
    scanned = 0

    async with get_session_factory()() as session:
        offset = 0
        while True:
            rows = list(
                await session.scalars(
                    select(Estimate).order_by(Estimate.id).limit(BATCH).offset(offset)
                )
            )
            if not rows:
                break

            for estimate in rows:
                scanned += 1
                total = estimate_totals.compute(estimate.rooms).total
                if estimate.total_amount != total:
                    changed += 1
                    label = estimate.identifier or estimate.id
                    print(f"  {label}: {estimate.total_amount} -> {total}")
                    if not dry_run:
                        estimate.total_amount = total

            if not dry_run:
                await session.flush()
            offset += BATCH

        if dry_run:
            await session.rollback()
        else:
            await session.commit()

    print(f"\nscanned {scanned}, {'would change' if dry_run else 'changed'} {changed}")
    return changed


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="report without writing")
    args = parser.parse_args()
    asyncio.run(backfill(dry_run=args.dry_run))


if __name__ == "__main__":
    main()
