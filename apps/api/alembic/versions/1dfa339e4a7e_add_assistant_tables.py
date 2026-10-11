"""add the assistant's tables

BuildCo Assistant keeps four things, and each gets a table:

* ``agent_conversations`` - one row per conversation, carrying the hashed session ticket
  and the heartbeat that keeps a user to one live conversation across instances.
* ``agent_messages`` - final transcripts, text only. Deleted after 90 days.
* ``agent_actions`` - every proposal, with the exact payload it would write and what
  became of it. The proposal store and the audit log in one; kept indefinitely.
* ``agent_memories`` - what the assistant remembers about one person.

``team_settings`` gains ``agent_daily_minutes``: each person's daily allowance of live
conversation. Null means the environment default; zero switches the assistant off.

Everything here is additive, so it applies ahead of the code that reads it and the
currently deployed revision is unaffected by it. Nothing is backfilled: there are no
conversations to carry over.

``uq_agent_conversations_one_active_per_user`` is a **partial** unique index. Alembic
does not always detect a change to a partial index's predicate, so if the condition is
ever edited, write that migration by hand.

Autogenerate also proposed dropping four indexes on ``estimates`` and ``meetings``. They
are created by earlier migrations and not declared on the models, which is why it
thought they were stray. Those drops were removed from this file; do not put them back.

Revision ID: 1dfa339e4a7e
Revises: e0f7b5c3a429
Created: 2026-10-11
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# Referenced by the JSONB columns below. Autogenerate emits the fully-qualified name
# but not the import, so without this the migration fails with NameError at run time.
import app.models.base

revision: str = "1dfa339e4a7e"
down_revision: str | None = "e0f7b5c3a429"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "agent_conversations",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column(
            "status", sa.String(length=20), server_default=sa.text("'pending'"), nullable=False
        ),
        sa.Column("title", sa.String(length=200), server_default=sa.text("''"), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("end_reason", sa.String(length=20), nullable=True),
        sa.Column("last_heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "connection_generation", sa.Integer(), server_default=sa.text("0"), nullable=False
        ),
        sa.Column("disconnected_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ticket_hash", sa.String(length=64), nullable=True),
        sa.Column("ticket_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ticket_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("transcript_purged_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("live_seconds", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("model", sa.String(length=100), server_default=sa.text("''"), nullable=False),
        sa.Column("audio_seconds_in", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("audio_seconds_out", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "client_timezone", sa.String(length=64), server_default=sa.text("'UTC'"), nullable=False
        ),
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
        sa.CheckConstraint(
            "end_reason is null or end_reason in ('user_closed','idle_timeout','time_limit','disconnected','superseded','error')",
            name=op.f("ck_agent_conversations_end_reason_valid"),
        ),
        sa.CheckConstraint(
            "status in ('pending','active','ended')",
            name=op.f("ck_agent_conversations_status_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["profiles.id"],
            name=op.f("fk_agent_conversations_user_id_profiles"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_agent_conversations")),
    )
    op.create_index(
        op.f("ix_agent_conversations_ticket_hash"),
        "agent_conversations",
        ["ticket_hash"],
        unique=False,
    )
    op.create_index(
        op.f("ix_agent_conversations_user_id"), "agent_conversations", ["user_id"], unique=False
    )
    op.create_index(
        "uq_agent_conversations_one_active_per_user",
        "agent_conversations",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
        sqlite_where=sa.text("status = 'active'"),
    )
    op.create_table(
        "agent_actions",
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=60), nullable=False),
        sa.Column(
            "status", sa.String(length=20), server_default=sa.text("'proposed'"), nullable=False
        ),
        sa.Column("payload", app.models.base.JSONBType(), nullable=False),
        sa.Column(
            "labels", app.models.base.JSONBType(), server_default=sa.text("'{}'"), nullable=False
        ),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("approval_policy", sa.String(length=20), nullable=False),
        sa.Column("target_type", sa.String(length=40), nullable=True),
        sa.Column("target_id", sa.Uuid(), nullable=True),
        sa.Column("target_fingerprint", sa.String(length=64), nullable=True),
        sa.Column(
            "required_terms",
            app.models.base.JSONBType(),
            server_default=sa.text("'[]'"),
            nullable=False,
        ),
        sa.Column(
            "readback_verified", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column("readback_played_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("approved_via", sa.String(length=20), nullable=True),
        sa.Column("approval_utterance", sa.Text(), nullable=True),
        sa.Column("result", app.models.base.JSONBType(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.CheckConstraint(
            "approval_policy in ('voice_or_click','click')",
            name=op.f("ck_agent_actions_approval_policy_valid"),
        ),
        sa.CheckConstraint(
            "approved_via is null or approved_via in ('voice','click')",
            name=op.f("ck_agent_actions_approved_via_valid"),
        ),
        sa.CheckConstraint(
            "status in ('proposed','committed','cancelled','superseded','expired','handed_over','failed')",
            name=op.f("ck_agent_actions_status_valid"),
        ),
        sa.ForeignKeyConstraint(
            ["conversation_id"],
            ["agent_conversations.id"],
            name=op.f("fk_agent_actions_conversation_id_agent_conversations"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["profiles.id"],
            name=op.f("fk_agent_actions_user_id_profiles"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_agent_actions")),
    )
    op.create_index(
        op.f("ix_agent_actions_conversation_id"), "agent_actions", ["conversation_id"], unique=False
    )
    op.create_index(op.f("ix_agent_actions_user_id"), "agent_actions", ["user_id"], unique=False)
    op.create_table(
        "agent_memories",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("category", sa.String(length=20), nullable=False),
        sa.Column("content", sa.String(length=500), nullable=False),
        sa.Column("source", sa.String(length=20), nullable=False),
        sa.Column("evidence", sa.Text(), nullable=False),
        sa.Column("source_conversation_id", sa.Uuid(), nullable=True),
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
        sa.CheckConstraint(
            "category in ('identity','preference','work_habit')",
            name=op.f("ck_agent_memories_category_valid"),
        ),
        sa.CheckConstraint(
            "source in ('explicit','inferred')", name=op.f("ck_agent_memories_source_valid")
        ),
        sa.ForeignKeyConstraint(
            ["source_conversation_id"],
            ["agent_conversations.id"],
            name=op.f("fk_agent_memories_source_conversation_id_agent_conversations"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["profiles.id"],
            name=op.f("fk_agent_memories_user_id_profiles"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_agent_memories")),
    )
    op.create_index(op.f("ix_agent_memories_user_id"), "agent_memories", ["user_id"], unique=False)
    op.create_table(
        "agent_messages",
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("role", sa.String(length=20), nullable=False),
        sa.Column("source", sa.String(length=20), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.CheckConstraint(
            "role in ('user','assistant')", name=op.f("ck_agent_messages_role_valid")
        ),
        sa.CheckConstraint(
            "source in ('voice','text')", name=op.f("ck_agent_messages_source_valid")
        ),
        sa.ForeignKeyConstraint(
            ["conversation_id"],
            ["agent_conversations.id"],
            name=op.f("fk_agent_messages_conversation_id_agent_conversations"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_agent_messages")),
        sa.UniqueConstraint("conversation_id", "seq", name="uq_agent_messages_conversation_seq"),
    )
    op.create_index(
        op.f("ix_agent_messages_conversation_id"),
        "agent_messages",
        ["conversation_id"],
        unique=False,
    )
    op.add_column("team_settings", sa.Column("agent_daily_minutes", sa.Integer(), nullable=True))


def downgrade() -> None:
    # Destroys every conversation, transcript, memory and the action log. The log is the
    # only record of what the assistant did on someone's behalf, so take a backup first
    # if any of it has been used.
    op.drop_column("team_settings", "agent_daily_minutes")
    op.drop_index(op.f("ix_agent_messages_conversation_id"), table_name="agent_messages")
    op.drop_table("agent_messages")
    op.drop_index(op.f("ix_agent_memories_user_id"), table_name="agent_memories")
    op.drop_table("agent_memories")
    op.drop_index(op.f("ix_agent_actions_user_id"), table_name="agent_actions")
    op.drop_index(op.f("ix_agent_actions_conversation_id"), table_name="agent_actions")
    op.drop_table("agent_actions")
    op.drop_index(
        "uq_agent_conversations_one_active_per_user",
        table_name="agent_conversations",
        postgresql_where=sa.text("status = 'active'"),
        sqlite_where=sa.text("status = 'active'"),
    )
    op.drop_index(op.f("ix_agent_conversations_user_id"), table_name="agent_conversations")
    op.drop_index(op.f("ix_agent_conversations_ticket_hash"), table_name="agent_conversations")
    op.drop_table("agent_conversations")
