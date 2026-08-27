"""The rate catalogue and the team settings row."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import NotFound
from app.logging import get_logger
from app.models.profile import Profile
from app.models.settings import SETTINGS_ROW_ID, CatalogueItem, TeamSettings
from app.schemas.settings import NOTIFICATION_KEYS

log = get_logger(__name__)


# ── Team settings ─────────────────────────────────────────────────────────────


async def get_settings_row(session: AsyncSession) -> TeamSettings:
    """The single settings row, created on first use.

    A settings screen that 404s until someone saves once is a worse first experience
    than one that opens on defaults, so the row is materialised rather than treated as
    optional.

    The savepoint matters: two first-ever requests race, both see no row, and both
    insert the same fixed primary key. Without ``begin_nested`` the loser's
    ``IntegrityError`` would poison the surrounding transaction and fail a request that
    should simply have read the winner's row. ``estimate_service.create_estimate`` does
    the same for identifier collisions.
    """
    row = await session.get(TeamSettings, SETTINGS_ROW_ID)
    if row is not None:
        return row

    try:
        async with session.begin_nested():
            row = TeamSettings(id=SETTINGS_ROW_ID)
            session.add(row)
            await session.flush()
        return row
    except IntegrityError:
        existing = await session.get(TeamSettings, SETTINGS_ROW_ID)
        if existing is None:  # pragma: no cover - only if the row vanished mid-flight
            raise
        return existing


def resolved_prefs(row: TeamSettings) -> dict[str, bool]:
    """Every known key, with anything unset defaulting to enabled.

    Absent means enabled deliberately: a preference nobody has expressed is not a
    preference to suppress mail. It also means adding a new notification does not
    silently start out switched off for every existing team.
    """
    stored = row.notification_prefs or {}
    return {key: bool(stored.get(key, True)) for key in sorted(NOTIFICATION_KEYS)}


async def update_settings(
    session: AsyncSession, actor: Profile, changes: dict[str, Any]
) -> TeamSettings:
    row = await get_settings_row(session)

    for field, value in changes.items():
        if field == "notification_prefs":
            # Merged, not replaced: the client sends the switch that moved, and
            # replacing the whole map would reset every other toggle to its default.
            merged = dict(row.notification_prefs or {})
            merged.update(value)
            row.notification_prefs = merged
        else:
            setattr(row, field, value)

    row.updated_by = actor.id
    await session.flush()
    log.info("team_settings_updated", by=str(actor.id), fields=sorted(changes))
    return row


async def notifications_enabled(session: AsyncSession, key: str) -> bool:
    """Whether a given admin notification should be sent.

    Fails **open**. If the settings row cannot be read for any reason, the email goes
    out: a notification nobody wanted is a minor annoyance, and a notification that
    silently stopped because of a database hiccup is the kind of thing discovered weeks
    later when someone asks why nobody was told.
    """
    try:
        row = await session.get(TeamSettings, SETTINGS_ROW_ID)
    except Exception as exc:  # pragma: no cover - defensive
        log.warning("notification_prefs_unreadable", key=key, error=str(exc))
        return True

    if row is None:
        return True
    return bool((row.notification_prefs or {}).get(key, True))


# ── Catalogue ─────────────────────────────────────────────────────────────────


async def list_catalogue(session: AsyncSession) -> list[CatalogueItem]:
    rows = await session.scalars(
        select(CatalogueItem).order_by(CatalogueItem.category, CatalogueItem.name)
    )
    return list(rows)


async def create_catalogue_item(
    session: AsyncSession, actor: Profile, data: dict[str, Any]
) -> CatalogueItem:
    item = CatalogueItem(created_by=actor.id, **data)
    session.add(item)
    await session.flush()
    return item


async def get_catalogue_item(session: AsyncSession, item_id: uuid.UUID) -> CatalogueItem:
    item = await session.get(CatalogueItem, item_id)
    if item is None:
        raise NotFound("Catalogue item not found.")
    return item


async def update_catalogue_item(
    session: AsyncSession, item_id: uuid.UUID, changes: dict[str, Any]
) -> CatalogueItem:
    item = await get_catalogue_item(session, item_id)
    for field, value in changes.items():
        setattr(item, field, value)
    await session.flush()
    return item


async def delete_catalogue_item(session: AsyncSession, item_id: uuid.UUID) -> None:
    """Remove a rate.

    Line items already priced from it are untouched: an estimate records the values it
    was built with, not a live reference. Deleting a rate changes what can be added
    next, never what has already been quoted.
    """
    item = await get_catalogue_item(session, item_id)
    await session.delete(item)
    await session.flush()
