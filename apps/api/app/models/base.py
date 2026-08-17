"""Declarative base and shared column mixins."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any, ClassVar

from sqlalchemy import DateTime, MetaData, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine.interfaces import Dialect
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import JSON, TypeDecorator, TypeEngine, Uuid

#: Explicit naming so Alembic autogenerate produces stable, reviewable constraint
#: names instead of relying on Postgres defaults.
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class JSONBType(TypeDecorator[object]):
    """``JSONB`` on Postgres, plain ``JSON`` elsewhere.

    The test suite runs against SQLite, which has no JSONB. Production is always
    Postgres, so this only ever widens where the code can run.
    """

    impl = JSON
    cache_ok = True

    def load_dialect_impl(self, dialect: Dialect) -> TypeEngine[Any]:
        if dialect.name == "postgresql":
            return dialect.type_descriptor(JSONB())
        return dialect.type_descriptor(JSON())


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)

    # SQLAlchemy reads this as a class attribute; it is never mutated.
    type_annotation_map: ClassVar[dict[type, object]] = {
        dict: JSONBType,
        list: JSONBType,
    }


def utcnow() -> datetime:
    return datetime.now(UTC)


class UUIDPrimaryKey:
    """A client-independent uuid primary key, generated in Python.

    Generating ids application-side (rather than with ``gen_random_uuid()``) means the
    id is known before the INSERT, which lets a service write a parent row and its
    child rows in one flush.
    """

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)


class TimestampMixin:
    """``created_at`` / ``updated_at``, maintained by the ORM.

    The legacy schema kept ``updated_at`` current with a Postgres trigger
    (``handle_updated_at``). That trigger is not carried over — ``onupdate`` here does
    the same job and keeps the behaviour visible in the model rather than hidden in
    the database.
    """

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        default=utcnow,
        onupdate=utcnow,
        nullable=False,
    )
