"""add the default reviewer setting and an index on meetings.created_by

Two unrelated but equally additive changes, kept in one revision because they ship
together and neither touches existing data.

``team_settings.default_reviewer_id`` names the single user every estimate sent for
review now goes to. It is a real column with a real foreign key rather than another key
inside ``notification_prefs`` JSONB: it points at a row in another table, and an id
inside JSONB could dangle silently — the first anyone would learn of it is a submission
that emailed nobody. ``ON DELETE SET NULL`` because losing the reviewer must not delete
the team's settings; submission then fails loudly and an admin picks someone new.

``ix_meetings_created_by`` supports the new per-user calendar visibility filter, which
queries meetings by their creator on every calendar page load. ``meeting_attendees``
already indexes ``user_id``, so the other half of that filter needed nothing.

Nullable column plus an index: safe to apply before the code that reads either is
deployed, which is what expand/contract asks for.

Revision ID: a1b2c3d4e5f6
Revises: 61c12227394f
Created: 2026-09-04
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a1b2c3d4e5f6"
down_revision: str | None = "61c12227394f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("team_settings", sa.Column("default_reviewer_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_team_settings_default_reviewer_id_profiles",
        "team_settings",
        "profiles",
        ["default_reviewer_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_meetings_created_by", "meetings", ["created_by"])


def downgrade() -> None:
    op.drop_index("ix_meetings_created_by", table_name="meetings")
    op.drop_constraint(
        "fk_team_settings_default_reviewer_id_profiles", "team_settings", type_="foreignkey"
    )
    op.drop_column("team_settings", "default_reviewer_id")
