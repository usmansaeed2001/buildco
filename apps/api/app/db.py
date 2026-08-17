"""Database engine, session factory, and the ``get_db`` request dependency.

Connection budget
-----------------
Cloud SQL ``db-f1-micro`` has a low connection ceiling, and Cloud Run runs many
instances that each hold their own pool. The invariant to preserve is:

    cloud_run_max_instances * (db_pool_size + db_max_overflow) < postgres max_connections

Defaults are ``pool_size=2, max_overflow=3`` (5 per instance), so 10 Cloud Run
instances fit inside ``max_connections=50``. Raise ``--max-instances`` and this must be
revisited, or PgBouncer introduced.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import get_settings

_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def _build_engine() -> AsyncEngine:
    settings = get_settings()
    kwargs: dict[str, Any] = {
        "echo": settings.db_echo,
        "pool_pre_ping": True,
    }
    # SQLite (used by the test suite) has no connection pool to size.
    if not settings.database_url.startswith("sqlite"):
        kwargs["pool_size"] = settings.db_pool_size
        kwargs["max_overflow"] = settings.db_max_overflow
        kwargs["pool_recycle"] = 1800
    return create_async_engine(settings.database_url, **kwargs)


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        _engine = _build_engine()
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    global _session_factory
    if _session_factory is None:
        _session_factory = async_sessionmaker(
            bind=get_engine(),
            class_=AsyncSession,
            expire_on_commit=False,
            autoflush=False,
        )
    return _session_factory


async def get_db() -> AsyncIterator[AsyncSession]:
    """Yield a session for the lifetime of one request.

    The session commits once, at the end of a successful request, and rolls back on
    any exception. Services therefore never call ``commit()`` themselves — they
    ``flush()`` when they need a generated id, and let the request boundary decide
    whether the unit of work is durable. That keeps a multi-step operation (update a
    project, write an activity row, evaluate the rules engine, write the follow-up
    activity rows) atomic without any explicit transaction plumbing in the services.
    """
    async with get_session_factory()() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
        else:
            await session.commit()


async def dispose_engine() -> None:
    """Close pooled connections on shutdown."""
    global _engine, _session_factory
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _session_factory = None
