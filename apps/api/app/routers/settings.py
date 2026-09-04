"""Team settings and the shared rate catalogue.

Reads are open to any authenticated user: the estimate editor needs the catalogue and
the custom units to render, and a member who cannot read them cannot price a line.
Writes are elevated — these are team-wide values, and one person changing a rate
changes what everyone quotes.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Path, status

from app.deps import CurrentUser, DbSession, Elevated
from app.schemas.common import Ack, ActorRef
from app.schemas.settings import (
    CatalogueItemCreate,
    CatalogueItemOut,
    CatalogueItemUpdate,
    TeamSettingsOut,
    TeamSettingsUpdate,
)
from app.services import settings_service

router = APIRouter(tags=["settings"])


def _to_out(row: object) -> TeamSettingsOut:
    from app.models.settings import TeamSettings

    assert isinstance(row, TeamSettings)
    return TeamSettingsOut(
        custom_units=list(row.custom_units or []),
        custom_categories=list(row.custom_categories or []),
        # Resolved rather than raw, so the client renders a complete set of switches
        # without having to know the key list itself.
        notification_prefs=settings_service.resolved_prefs(row),
        default_reviewer=(
            ActorRef.model_validate(row.default_reviewer) if row.default_reviewer else None
        ),
        updated_at=row.updated_at,
        updated_by=row.updated_by,
    )


@router.get("/settings", response_model=TeamSettingsOut)
async def get_team_settings(db: DbSession, user: CurrentUser) -> TeamSettingsOut:
    """The team's shared settings. Created on first read."""
    return _to_out(await settings_service.get_settings_row(db))


@router.patch("/settings", response_model=TeamSettingsOut)
async def update_team_settings(
    body: TeamSettingsUpdate, db: DbSession, actor: Elevated
) -> TeamSettingsOut:
    """Update the shared settings.

    ``notification_prefs`` is merged, not replaced — the client sends the switch that
    moved. The other two lists replace their stored value wholesale.
    """
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    return _to_out(await settings_service.update_settings(db, actor, changes))


@router.get("/catalogue-items", response_model=list[CatalogueItemOut])
async def list_catalogue_items(db: DbSession, user: CurrentUser) -> list[CatalogueItemOut]:
    """The universal rate list, ordered by category then name."""
    rows = await settings_service.list_catalogue(db)
    return [CatalogueItemOut.model_validate(row) for row in rows]


@router.post(
    "/catalogue-items", response_model=CatalogueItemOut, status_code=status.HTTP_201_CREATED
)
async def create_catalogue_item(
    body: CatalogueItemCreate, db: DbSession, actor: Elevated
) -> CatalogueItemOut:
    """Add a rate."""
    item = await settings_service.create_catalogue_item(db, actor, body.model_dump())
    return CatalogueItemOut.model_validate(item)


@router.patch("/catalogue-items/{item_id}", response_model=CatalogueItemOut)
async def update_catalogue_item(
    body: CatalogueItemUpdate,
    db: DbSession,
    actor: Elevated,
    item_id: Annotated[uuid.UUID, Path()],
) -> CatalogueItemOut:
    """Change a rate. Estimates already priced from it are untouched."""
    changes = body.model_dump(exclude_unset=True, exclude_none=True)
    item = await settings_service.update_catalogue_item(db, item_id, changes)
    return CatalogueItemOut.model_validate(item)


@router.delete("/catalogue-items/{item_id}", response_model=Ack)
async def delete_catalogue_item(
    db: DbSession, actor: Elevated, item_id: Annotated[uuid.UUID, Path()]
) -> Ack:
    """Remove a rate. Lines already quoted from it keep their prices."""
    await settings_service.delete_catalogue_item(db, item_id)
    return Ack()
