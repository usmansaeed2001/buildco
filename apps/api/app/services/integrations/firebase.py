"""Firebase Auth — token verification and user administration.

Replaces Supabase Auth. Two implementations sit behind one protocol:

* ``FirebaseAuthProvider`` — the real Admin SDK.
* ``FakeAuthProvider`` — used when no credentials are configured, or when
  ``AUTH_DISABLED`` is set for local development. It accepts any token and returns a
  synthetic identity, so every endpoint is exercisable before Firebase exists.

The provider is chosen once, at import of ``get_auth_provider``. Tests override it by
replacing the module-level cache.

Note on roles: ``profiles.role`` in Postgres stays the authoritative source. Custom
claims are mirrored to Firebase as a convenience for the frontend (so it can render the
right navigation before its first API call), never trusted for authorisation.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Protocol

from app.config import get_settings
from app.errors import Unauthorized
from app.logging import get_logger

log = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class VerifiedIdentity:
    """The subset of a decoded Firebase ID token the application cares about."""

    uid: str
    email: str | None
    email_verified: bool = False
    name: str | None = None
    picture: str | None = None


class AuthProvider(Protocol):
    async def verify_id_token(self, token: str) -> VerifiedIdentity: ...

    async def set_disabled(self, uid: str, disabled: bool) -> bool: ...

    async def set_role_claim(self, uid: str, role: str) -> bool: ...


# ── Real implementation ───────────────────────────────────────────────────────


class FirebaseAuthProvider:
    def __init__(self) -> None:
        import firebase_admin
        from firebase_admin import credentials

        settings = get_settings()
        if not firebase_admin._apps:
            if settings.firebase_credentials_file:
                cred = credentials.Certificate(settings.firebase_credentials_file)
            else:
                # Application Default Credentials — how it resolves on Cloud Run.
                cred = credentials.ApplicationDefault()
            options = (
                {"projectId": settings.firebase_project_id}
                if settings.firebase_project_id
                else None
            )
            firebase_admin.initialize_app(cred, options)

    async def verify_id_token(self, token: str) -> VerifiedIdentity:
        from firebase_admin import auth as fb_auth

        def _verify() -> dict[str, Any]:
            decoded: dict[str, Any] = fb_auth.verify_id_token(token, check_revoked=True)
            return decoded

        try:
            decoded = await asyncio.to_thread(_verify)
        except Exception as exc:
            log.info("token_verification_failed", error=type(exc).__name__)
            raise Unauthorized("Invalid or expired authentication token.") from exc

        return VerifiedIdentity(
            uid=str(decoded["uid"]),
            email=decoded.get("email"),
            email_verified=bool(decoded.get("email_verified", False)),
            name=decoded.get("name"),
            picture=decoded.get("picture"),
        )

    async def set_disabled(self, uid: str, disabled: bool) -> bool:
        """Ban or unban at the identity provider.

        Disabling in Firebase is what actually stops the user obtaining new tokens;
        the ``profiles.status`` flag is what stops an already-issued token from
        working. Both are set, deliberately — see ``user_service.ban_user``.
        """
        from firebase_admin import auth as fb_auth

        def _update() -> None:
            fb_auth.update_user(uid, disabled=disabled)

        try:
            await asyncio.to_thread(_update)
        except Exception as exc:
            log.error("firebase_set_disabled_failed", uid=uid, error=str(exc))
            return False
        return True

    async def set_role_claim(self, uid: str, role: str) -> bool:
        from firebase_admin import auth as fb_auth

        def _set() -> None:
            fb_auth.set_custom_user_claims(uid, {"role": role})

        try:
            await asyncio.to_thread(_set)
        except Exception as exc:
            log.error("firebase_set_claim_failed", uid=uid, error=str(exc))
            return False
        return True


# ── Fake implementation ───────────────────────────────────────────────────────


class FakeAuthProvider:
    """Accepts anything and returns a fixed development identity.

    Selected when Firebase is unconfigured or ``AUTH_DISABLED`` is set. Settings
    validation refuses to let ``AUTH_DISABLED`` be true in staging or production, and
    this provider logs loudly on construction so it can never be mistaken for the real
    thing in a deployed log stream.
    """

    def __init__(self) -> None:
        settings = get_settings()
        self._email = settings.auth_dev_email
        self._name = settings.auth_dev_name
        log.warning(
            "auth_provider_is_fake",
            environment=settings.environment,
            hint="Tokens are NOT verified. Configure Firebase before deploying.",
        )

    async def verify_id_token(self, token: str) -> VerifiedIdentity:
        return VerifiedIdentity(
            uid=f"dev-{self._email}",
            email=self._email,
            email_verified=True,
            name=self._name,
        )

    async def set_disabled(self, uid: str, disabled: bool) -> bool:
        log.info("fake_auth_set_disabled", uid=uid, disabled=disabled)
        return True

    async def set_role_claim(self, uid: str, role: str) -> bool:
        log.info("fake_auth_set_role", uid=uid, role=role)
        return True


# ── Selection ─────────────────────────────────────────────────────────────────


@lru_cache(maxsize=1)
def get_auth_provider() -> AuthProvider:
    settings = get_settings()

    if settings.auth_disabled:
        return FakeAuthProvider()

    try:
        return FirebaseAuthProvider()
    except Exception as exc:
        if settings.is_production:
            # Never silently fall back to "accept every token" in production.
            raise
        log.warning(
            "firebase_unavailable_using_fake",
            error=str(exc),
            environment=settings.environment,
        )
        return FakeAuthProvider()


def reset_auth_provider() -> None:
    """Clear the cached provider. For tests and for settings changes at runtime."""
    get_auth_provider.cache_clear()
