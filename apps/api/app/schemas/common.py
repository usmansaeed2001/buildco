"""Shared schema building blocks."""

from __future__ import annotations

import uuid
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field


class Schema(BaseModel):
    """Base for request bodies. Rejects unknown keys.

    Being strict here is what makes a typo in a client payload a 422 instead of a
    silently ignored field — the legacy handlers destructured whatever arrived and
    dropped anything they did not recognise.
    """

    model_config = ConfigDict(extra="forbid")


class ORMSchema(BaseModel):
    """Base for responses built from ORM objects."""

    model_config = ConfigDict(from_attributes=True)


class ActorRef(ORMSchema):
    """A person, reduced to what a list row or an activity line needs to show."""

    id: uuid.UUID
    email: str
    full_name: str = ""
    avatar_url: str | None = None
    role: str | None = None


class Page[T](BaseModel):
    """A slice of a collection, with enough context to render a pager."""

    items: list[T]
    total: int = Field(description="Total rows matching the filter, ignoring paging.")
    limit: int
    offset: int

    @property
    def has_more(self) -> bool:
        return self.offset + len(self.items) < self.total


class Ack(BaseModel):
    """Response for operations with nothing meaningful to return."""

    success: bool = True


class ErrorBody(BaseModel):
    code: str
    message: str
    details: dict[str, object] | None = None


class ErrorResponse(BaseModel):
    """The shape every non-2xx response takes. Declared so it appears in OpenAPI."""

    error: ErrorBody


#: Standard paging parameters, reused across list endpoints.
Limit = Annotated[int, Field(ge=1, le=200)]
Offset = Annotated[int, Field(ge=0)]
