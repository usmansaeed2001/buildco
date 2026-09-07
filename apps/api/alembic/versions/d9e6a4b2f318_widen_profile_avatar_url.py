"""widen profiles.avatar_url to unbounded text

Google account photo URLs are not bounded by anything we control. The ordinary
``lh3.googleusercontent.com/a/...`` form is well under 200 characters, but a
signed ``a-/ALV-...`` URL carries an opaque token that runs far longer — the one
that surfaced this was 1214 characters, and there is no documented ceiling.

``varchar(1000)`` therefore rejected a legitimate sign-in: ``resolve_profile``
copies ``identity.picture`` straight onto a new profile, so the first login of an
affected Google account failed the INSERT with ``StringDataRightTruncationError``
and the user could not be provisioned at all.

The column holds a URL supplied by the identity provider or by our own avatar
upload flow. There is no length at which a value becomes wrong, so the type
carries no length. On Postgres this is a catalogue-only change: ``text`` and
``varchar`` share a storage representation, so no table rewrite happens.

Revision ID: d9e6a4b2f318
Revises: c8d5f3a1e207
Created: 2026-09-07
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d9e6a4b2f318"
down_revision: str | None = "c8d5f3a1e207"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column(
        "profiles",
        "avatar_url",
        existing_type=sa.String(length=1000),
        type_=sa.Text(),
        existing_nullable=True,
    )


def downgrade() -> None:
    # Any URL that only fits because of this migration cannot survive the reversal.
    # Truncating it would leave a string that still looks like a URL but resolves to
    # nothing, so drop it instead: a null avatar_url is already the "no picture"
    # case the application handles, and the next sign-in re-supplies it.
    op.execute("UPDATE profiles SET avatar_url = NULL WHERE length(avatar_url) > 1000")
    op.alter_column(
        "profiles",
        "avatar_url",
        existing_type=sa.Text(),
        type_=sa.String(length=1000),
        existing_nullable=True,
    )
