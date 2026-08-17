"""Application error hierarchy and the handlers that render it.

Every error the API returns — ours, FastAPI's validation failures, and unhandled
exceptions alike — comes back in one envelope:

    {"error": {"code": "not_found", "message": "Estimate not found", "details": {...}}}

Raise these from services. Routers should not construct ``HTTPException`` directly;
that would spread status-code decisions across the transport layer.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.logging import get_logger

log = get_logger(__name__)

#: Starlette renamed this constant; read it by value so the module works on both the
#: old and the new name without emitting a deprecation warning on import.
HTTP_422 = 422


class AppError(Exception):
    """Base class for every error the application raises deliberately."""

    status_code: int = status.HTTP_500_INTERNAL_SERVER_ERROR
    code: str = "internal_error"
    default_message: str = "Something went wrong."

    def __init__(
        self,
        message: str | None = None,
        *,
        details: dict[str, Any] | None = None,
    ) -> None:
        self.message = message or self.default_message
        self.details = details or {}
        super().__init__(self.message)

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.details:
            payload["details"] = self.details
        return {"error": payload}


class Unauthorized(AppError):
    status_code = status.HTTP_401_UNAUTHORIZED
    code = "unauthorized"
    default_message = "Authentication required."


class Forbidden(AppError):
    status_code = status.HTTP_403_FORBIDDEN
    code = "forbidden"
    default_message = "You do not have permission to perform this action."


class NotFound(AppError):
    status_code = status.HTTP_404_NOT_FOUND
    code = "not_found"
    default_message = "Resource not found."


class Conflict(AppError):
    status_code = status.HTTP_409_CONFLICT
    code = "conflict"
    default_message = "The request conflicts with the current state of the resource."


class Gone(AppError):
    """Used for approval tokens that have already been spent."""

    status_code = status.HTTP_410_GONE
    code = "gone"
    default_message = "This resource is no longer available."


class ValidationFailed(AppError):
    status_code = HTTP_422
    code = "validation_failed"
    default_message = "The request payload is invalid."


class IntegrationUnavailable(AppError):
    """A third-party dependency is unreachable or not configured for this operation.

    Note that most integrations degrade silently to a no-op when unconfigured. This is
    for the cases where the caller genuinely cannot be served without them — the AI
    parser with no Groq key, or a signed upload URL with no bucket.
    """

    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    code = "integration_unavailable"
    default_message = "A required external service is unavailable."


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content=exc.to_payload())

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        # Reshape FastAPI's own 422 into the same envelope as everything else.
        return JSONResponse(
            status_code=HTTP_422,
            content={
                "error": {
                    "code": "validation_failed",
                    "message": "The request payload is invalid.",
                    "details": {"errors": _serialisable_errors(exc)},
                }
            },
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        # Covers 404 on unknown routes, 405 on wrong method, etc.
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "error": {
                    "code": _CODE_BY_STATUS.get(exc.status_code, "http_error"),
                    "message": str(exc.detail),
                }
            },
        )

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.exception(
            "unhandled_exception",
            path=request.url.path,
            method=request.method,
            error=str(exc),
        )
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={
                "error": {
                    "code": "internal_error",
                    # Never leak the exception text to the client.
                    "message": "Something went wrong.",
                }
            },
        )


_CODE_BY_STATUS: dict[int, str] = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    410: "gone",
    422: "validation_failed",
    429: "rate_limited",
}


def _serialisable_errors(exc: RequestValidationError) -> list[dict[str, Any]]:
    """Strip the non-JSON-serialisable ``ctx`` values pydantic sometimes attaches."""
    cleaned: list[dict[str, Any]] = []
    for err in exc.errors():
        cleaned.append(
            {
                "location": list(err.get("loc", ())),
                "message": err.get("msg", ""),
                "type": err.get("type", ""),
            }
        )
    return cleaned
