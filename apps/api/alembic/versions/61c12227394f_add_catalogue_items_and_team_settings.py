"""add catalogue items and team settings

Backs the Settings screen, which the legacy app kept in ``localStorage`` — so the
universal rate list was per-browser and per-device, two estimators on the same job saw
different prices, and the notification toggles gated nothing at all because the emails
were sent server-side and the browser was never consulted.

Purely additive: two new tables, no changes to existing ones. Safe to apply before the
code that reads them is deployed, which is what expand/contract asks for.

``team_settings`` holds a single row at a fixed primary key
(``models.settings.SETTINGS_ROW_ID``). The row is not inserted here — the service
materialises it on first read — so this migration stays reversible without having to
decide whether a downgrade should delete someone's settings.

Revision ID: 61c12227394f
Revises: 0001
Created: 2026-08-27 20:16:04.932715
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Referenced by the JSONB columns below. Autogenerate emits the fully-qualified name
# but not the import, so without this the migration fails with NameError at run time.
import app.models.base

revision: str = "61c12227394f"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "catalogue_items",
        sa.Column("name", sa.String(length=300), nullable=False),
        sa.Column("category", sa.String(length=100), server_default=sa.text("''"), nullable=False),
        sa.Column("unit", sa.String(length=50), server_default=sa.text("''"), nullable=False),
        sa.Column(
            "unit_cost",
            sa.Numeric(precision=12, scale=2),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column("notes", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["profiles.id"],
            name=op.f("fk_catalogue_items_created_by_profiles"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_catalogue_items")),
    )
    op.create_table(
        "team_settings",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "custom_units",
            app.models.base.JSONBType(),
            server_default=sa.text("'[]'"),
            nullable=False,
        ),
        sa.Column(
            "custom_categories",
            app.models.base.JSONBType(),
            server_default=sa.text("'[]'"),
            nullable=False,
        ),
        sa.Column(
            "notification_prefs",
            app.models.base.JSONBType(),
            server_default=sa.text("'{}'"),
            nullable=False,
        ),
        sa.Column("updated_by", sa.Uuid(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["updated_by"],
            ["profiles.id"],
            name=op.f("fk_team_settings_updated_by_profiles"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_team_settings")),
    )


def downgrade() -> None:
    """Drop both tables.

    Destructive, and knowingly so: there is nowhere else the rate list or the
    notification preferences live. Reversing this loses them.
    """
    op.drop_table("team_settings")
    op.drop_table("catalogue_items")
