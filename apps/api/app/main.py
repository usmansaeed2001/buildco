"""FastAPI application factory."""

from __future__ import annotations

import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.config import get_settings
from app.db import dispose_engine
from app.errors import register_exception_handlers
from app.logging import configure_logging, get_logger
from app.routers import ai, attachments, estimates, health, meetings, projects, reviews, users

log = get_logger(__name__)

DESCRIPTION = """
Backend for the BuildCo construction-operations platform: supplement estimates,
projects and payment milestones, meetings, and the external estimate-approval flow.

**Authentication.** Send a Firebase ID token as `Authorization: Bearer <token>`. Call
`POST /api/v1/auth/session` once after sign-in to provision or link your profile.

**Roles.** `owner` > `admin` > `member`. Members see only the estimates they created
and the projects assigned to them; each endpoint's required role is noted on it.

**Errors.** Every non-2xx response is `{"error": {"code", "message", "details?"}}`.

**Public endpoints.** `/healthz`, `/readyz`, `/api/v1/auth/status`, and everything
under `/api/v1/public/` need no authentication. The review endpoints are authenticated
by the approval token in the URL.
""".strip()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    log.info(
        "api_starting",
        version=__version__,
        environment=settings.environment,
        auth_disabled=settings.auth_disabled,
    )
    if settings.auth_disabled:
        log.warning(
            "AUTH_DISABLED_ACTIVE",
            hint="All requests run as a synthetic owner. Local development only.",
        )
    yield
    await dispose_engine()
    log.info("api_stopped")


def create_app() -> FastAPI:
    configure_logging()
    settings = get_settings()

    app = FastAPI(
        title="BuildCo API",
        description=DESCRIPTION,
        version=__version__,
        lifespan=lifespan,
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url="/openapi.json",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
        max_age=3600,
    )

    @app.middleware("http")
    async def request_context(request: Request, call_next):  # type: ignore[no-untyped-def]
        """Bind a request id to the logging context and time the request.

        Cloud Run supplies ``X-Cloud-Trace-Context``; honouring an inbound id where one
        exists is what lets a log line be traced back to the request that produced it.
        """
        request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:16]
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(
            request_id=request_id, path=request.url.path, method=request.method
        )

        started = time.perf_counter()
        response: Response = await call_next(request)
        duration_ms = round((time.perf_counter() - started) * 1000, 2)

        response.headers["X-Request-ID"] = request_id
        log.info("request_completed", status=response.status_code, duration_ms=duration_ms)
        return response

    register_exception_handlers(app)

    # Health probes sit at the root: Cloud Run and uptime checks expect them there,
    # and they must not move when the API version prefix does.
    app.include_router(health.router)

    prefix = settings.api_v1_prefix
    app.include_router(users.router, prefix=prefix)
    app.include_router(estimates.router, prefix=prefix)
    app.include_router(attachments.router, prefix=prefix)
    app.include_router(attachments.standalone_router, prefix=prefix)
    app.include_router(projects.router, prefix=prefix)
    app.include_router(meetings.router, prefix=prefix)
    app.include_router(reviews.router, prefix=prefix)
    app.include_router(ai.router, prefix=prefix)

    return app


app = create_app()
