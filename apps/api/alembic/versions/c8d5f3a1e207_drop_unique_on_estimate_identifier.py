"""drop the uniqueness guarantee on estimates.identifier

The claim identifier was modelled as globally unique. Checked against the live
Supabase database ahead of the migration, that turns out to be wrong about the
domain: 44 of 154 estimates collide across 10 values.

    14  ''                                  blank — no claim number was entered
    18  'Self Pay' / 'SELF PAY' / 'self pay'  not a claim number at all
    12  six real claim numbers, each twice

Two different facts are hiding in that. The first 32 rows are people saying "there
is no insurance claim here", which a uniqueness constraint has no business
rejecting. The remaining six pairs are an original estimate and a supplement filed
against one claim — a case ``project_supplements`` already exists to model, and
which is *supposed* to share a claim reference.

The live database never enforced this: its only unique constraints are the two
composite ones on ``meeting_attendees`` and ``project_supplements``. The constraint
was introduced by this rewrite, and the data has been telling us for 154 estimates
that it does not hold.

The index stays — ``list_estimates`` searches on ``identifier`` — it simply stops
being unique. The generator in ``estimate_service.generate_identifier`` also stays:
a blank claim ID still gets a readable ``CLM-482913`` rather than an empty string.

``approval_token`` remains unique. That one is a capability — it is the entire
credential in ``/review/{token}`` — and two estimates sharing one would let a
reviewer open the wrong estimate.

Revision ID: c8d5f3a1e207
Revises: b7c4e1f2a930
Created: 2026-09-06
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "c8d5f3a1e207"
down_revision: str | None = "b7c4e1f2a930"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_index("ix_estimates_identifier", table_name="estimates")
    op.create_index("ix_estimates_identifier", "estimates", ["identifier"], unique=False)


def downgrade() -> None:
    # Reversible only while no duplicate identifiers exist. After the Supabase load
    # they do, and recreating the unique index will fail — correctly. Deduplicate
    # first if this ever genuinely has to be reversed.
    op.drop_index("ix_estimates_identifier", table_name="estimates")
    op.create_index("ix_estimates_identifier", "estimates", ["identifier"], unique=True)
