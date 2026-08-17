"""Structured logging.

JSON to stdout in deployed environments so Cloud Logging parses each line into a
structured entry; human-readable colour in local development.
"""

from __future__ import annotations

import logging
import sys
from typing import Any

import structlog

from app.config import get_settings


def configure_logging() -> None:
    settings = get_settings()
    level = logging.DEBUG if settings.debug else logging.INFO

    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=level)

    # Uvicorn installs its own handlers; route them through the same formatting.
    for noisy in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logging.getLogger(noisy).handlers.clear()
        logging.getLogger(noisy).propagate = True

    shared: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]

    renderer: Any = (
        structlog.dev.ConsoleRenderer()
        if settings.environment == "local"
        else structlog.processors.JSONRenderer()
    )

    structlog.configure(
        processors=[*shared, renderer],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    """Module-level logger. Call with ``__name__``."""
    logger: structlog.stdlib.BoundLogger = structlog.get_logger(name)
    return logger
