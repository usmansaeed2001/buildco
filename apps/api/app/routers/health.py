"""Liveness and readiness probes.

Replaces the legacy ``ping`` function, which existed to keep a serverless function
warm. Cloud Run's own min-instances setting handles that concern, so these are purely
health signals now.
"""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Response, status
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app import __version__
from app.config import get_settings
from app.db import get_db
from app.logging import get_logger

log = get_logger(__name__)

router = APIRouter(tags=["health"])


class HealthOut(BaseModel):
    status: Literal["ok"]
    version: str
    environment: str


class ReadinessOut(BaseModel):
    status: Literal["ready", "degraded"]
    database: Literal["up", "down"]


@router.get("/healthz", response_model=HealthOut)
async def liveness() -> HealthOut:
    """Is the process alive?

    Deliberately touches nothing external. A liveness probe that depends on the
    database will restart a perfectly healthy container during a database blip, which
    turns a brief outage into a crash loop.
    """
    settings = get_settings()
    return HealthOut(status="ok", version=__version__, environment=settings.environment)


@router.get("/readyz", response_model=ReadinessOut)
async def readiness(
    response: Response,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> ReadinessOut:
    """Can the process serve traffic?

    Checks the database, and returns 503 when it cannot be reached so the load
    balancer stops sending requests to this instance.
    """
    try:
        await db.execute(text("SELECT 1"))
    except Exception as exc:
        log.warning("readiness_check_failed", error=str(exc))
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return ReadinessOut(status="degraded", database="down")

    return ReadinessOut(status="ready", database="up")
