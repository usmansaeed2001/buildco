"""Alembic environment.

The connection string comes from application settings rather than ``alembic.ini`` so
there is one source of truth and no credential in a tracked file. Importing
``app.models`` is what populates ``Base.metadata`` — a model that is not re-exported
from that package is invisible to autogenerate.
"""

from __future__ import annotations

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from app.config import get_settings
from app.models import Base

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

config.set_main_option(
    "sqlalchemy.url",
    # Escaped: a password containing '%' would otherwise be read as interpolation.
    get_settings().database_url.replace("%", "%%"),
)


def _configure(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        # Detect column type changes, which autogenerate ignores by default.
        compare_type=True,
        compare_server_default=True,
        # Emit constraint names from the metadata naming convention, so a later
        # migration can drop a constraint by a name it can predict.
        render_as_batch=False,
        include_schemas=False,
        # Custom types (JSONBType) render with this prefix so the generated revision
        # imports them from one predictable place.
        user_module_prefix="app.models.base.",
    )


def run_migrations_offline() -> None:
    """Emit SQL to stdout without connecting — for reviewing a migration before it runs."""
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def _run(connection: Connection) -> None:
    _configure(connection)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    """Run migrations against a live database.

    ``poolclass=NullPool``: a migration run is a short-lived process, and holding a
    pool open would waste connections that ``db-f1-micro`` cannot spare.
    """
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    async with connectable.connect() as connection:
        await connection.run_sync(_run)

    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
