"""add the denormalised estimate total and the sort indexes

Backs sorting the estimates list. ``rooms`` is JSONB and the total has only ever existed
in Python, so there was no column to order by — and sorting a paginated list in the
browser sorts the page you are looking at rather than the list.

``total_amount`` is added ``NOT NULL`` with a server default rather than nullable-then-
constrained. That reads as a departure from expand/contract, so the reasoning matters: the
hazard that rule guards against is old code violating a new constraint mid-rollout, and it
cannot happen here — a process that predates this column never mentions it, so Postgres
supplies the default. A nullable column would be actively *worse* for a sort key, because
NULLs order unpredictably and any row inserted by an older process would land in the wrong
place in the list.

Also changes ``project_name``'s server default from the literal ``'New Estimate'`` to
``''``. That default is why an estimate created without a name was not *unnamed* — it was
named the same thing as every other one, so a list of them was a wall of identical rows.
Existing rows are left exactly as they are: renaming somebody's data is not a migration's
business, and the UI reads the old literal as "unnamed" instead.

Also adds three composite indexes. Every ordering in ``estimate_service`` ends with ``id``
as a tiebreaker — timestamps tie, and an unstable sort under LIMIT/OFFSET can show a row
twice and skip another — so the index has to cover both columns to satisfy the ORDER BY
without a separate sort step. ``ix_estimates_created_at_id`` also makes true a claim the
service docstring has been making since the date filter landed: there was no index on
``created_at`` at all.

Revision ID: b7c4e1f2a930
Revises: a1b2c3d4e5f6
Created: 2026-09-05
"""

from __future__ import annotations

from collections.abc import Sequence
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

import sqlalchemy as sa
from alembic import op

revision: str = "b7c4e1f2a930"
down_revision: str | None = "a1b2c3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: Rows per backfill batch. Large enough to be few round trips, small enough that the
#: whole table never has to fit in memory at once.
BATCH = 500


def _money(value: object) -> Decimal:
    if value is None:
        return Decimal("0")
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError, TypeError):
        return Decimal("0")


def _total(rooms: Any) -> Decimal:
    """The grand total of a ``rooms`` document.

    **Deliberately duplicated from ``app.services.rules.estimate_totals.compute``, not
    imported.** A migration has to keep producing the same numbers forever; importing
    application code means a later change to that function silently rewrites what this
    already-applied revision does on replay. The duplication is the point.

    ``tests/unit/test_total_backfill.py`` pins the two together, so if ``compute`` ever
    changes, that test fails and someone decides consciously rather than finding out from
    a list that is sorted wrong.

    Tolerant in the same way the original is: a malformed room or a missing price
    contributes zero rather than raising, because this has to run over whatever is already
    in the database.
    """
    grand = Decimal("0")
    for room in rooms or []:
        if not isinstance(room, dict):
            continue
        items = room.get("items") or []
        if not isinstance(items, list):
            items = []

        room_sum = Decimal("0")
        for item in items:
            if not isinstance(item, dict):
                continue
            quantity = _money(item.get("quantity"))
            unit_cost = _money(item.get("unitCost", item.get("unit_cost")))
            room_sum += quantity * unit_cost

        # Rounded per room, then summed — matching the original, which quantises each
        # room before adding it to the grand total. Summing raw and rounding once at the
        # end can differ by a cent, and the list would then disagree with the report.
        grand += room_sum.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    return grand.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _backfill() -> None:
    """Fill in totals for rows that predate the column.

    Row by row in Python rather than as a JSONB expression in SQL: the arithmetic walks a
    nested document with Decimal-as-string values, which is unpleasant in SQL and would
    tie the revision to Postgres for no gain.
    """
    bind = op.get_bind()
    estimates = sa.table(
        "estimates",
        sa.column("id", sa.Uuid()),
        sa.column("rooms", sa.JSON()),
        sa.column("total_amount", sa.Numeric(12, 2)),
    )

    offset = 0
    while True:
        rows = bind.execute(
            sa.select(estimates.c.id, estimates.c.rooms)
            .order_by(estimates.c.id)
            .limit(BATCH)
            .offset(offset)
        ).all()
        if not rows:
            return

        for row in rows:
            total = _total(row.rooms)
            if total:
                bind.execute(
                    sa.update(estimates).where(estimates.c.id == row.id).values(total_amount=total)
                )
        offset += BATCH


def upgrade() -> None:
    op.add_column(
        "estimates",
        sa.Column(
            "total_amount",
            sa.Numeric(precision=12, scale=2),
            server_default=sa.text("0"),
            nullable=False,
        ),
    )
    _backfill()

    op.create_index(
        "ix_estimates_created_at_id", "estimates", [sa.text("created_at DESC"), sa.text("id DESC")]
    )
    op.create_index(
        "ix_estimates_updated_at_id", "estimates", [sa.text("updated_at DESC"), sa.text("id DESC")]
    )
    op.create_index(
        "ix_estimates_total_amount_id",
        "estimates",
        [sa.text("total_amount DESC"), sa.text("id DESC")],
    )

    op.alter_column("estimates", "project_name", server_default=sa.text("''"))


def downgrade() -> None:
    op.alter_column("estimates", "project_name", server_default=sa.text("'New Estimate'"))
    op.drop_index("ix_estimates_total_amount_id", table_name="estimates")
    op.drop_index("ix_estimates_updated_at_id", table_name="estimates")
    op.drop_index("ix_estimates_created_at_id", table_name="estimates")
    # No data to preserve: the column is derived from `rooms`, which is untouched.
    op.drop_column("estimates", "total_amount")
