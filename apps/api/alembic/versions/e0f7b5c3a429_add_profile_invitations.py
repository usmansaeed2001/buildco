"""add invitation columns to profiles

An owner or admin can now add someone to the team before that person has an account.
The invitation is a ``profiles`` row created up front with the chosen role and no
``firebase_uid``; ``resolve_profile`` already links such a row to a Firebase user by
email on first sign-in, which is how migrated users arrive.

Three columns record it:

* ``invited_at`` / ``invited_by`` — when, and by whom. ``ON DELETE SET NULL`` on the
  inviter, matching ``removed_by``: losing the admin must not lose the member.
* ``invite_token_hash`` — SHA-256 of the token in the invitation email. Linking by email
  alone is not safe for a row that grants a role, because Firebase will create a
  password account for an address its owner has never seen; the token is the proof that
  whoever is signing up can read that mailbox. Only the hash is stored.

All three are nullable with no default, so this applies cleanly ahead of the code that
reads them — existing rows are simply "not invited", which is true.

Revision ID: e0f7b5c3a429
Revises: d9e6a4b2f318
Created: 2026-10-10
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e0f7b5c3a429"
down_revision: str | None = "d9e6a4b2f318"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("profiles", sa.Column("invited_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("profiles", sa.Column("invited_by", sa.Uuid(), nullable=True))
    op.add_column("profiles", sa.Column("invite_token_hash", sa.String(length=64), nullable=True))
    op.create_foreign_key(
        "fk_profiles_invited_by_profiles",
        "profiles",
        "profiles",
        ["invited_by"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    # Pending invitations cannot survive this: without the token column the link in the
    # email no longer proves anything, and the row would fall back to linking by email
    # alone. The rows are left in place rather than deleted — re-inviting after a
    # re-upgrade is one click, whereas a deleted row may already be assigned to a project.
    op.drop_constraint("fk_profiles_invited_by_profiles", "profiles", type_="foreignkey")
    op.drop_column("profiles", "invite_token_hash")
    op.drop_column("profiles", "invited_by")
    op.drop_column("profiles", "invited_at")
