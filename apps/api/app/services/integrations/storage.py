"""Object storage on Google Cloud Storage.

Replaces Supabase Storage. The browser uploads directly to GCS using a V4 signed PUT
URL the API mints, and downloads through a V4 signed GET URL — so file bytes never
pass through Cloud Run.

The object-key scheme is carried over from the legacy implementation unchanged
(``{estimate_id}/{room}_{item}_{epoch_ms}.{ext}`` for attachments, ``{user_id}/avatar.{ext}``
for avatars) so that objects copied across from Supabase remain addressable by the
``storage_path`` values already recorded in the database.

The ``google-cloud-storage`` client is synchronous, so the blocking calls are pushed to
a worker thread rather than stalling the event loop.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from datetime import timedelta
from functools import lru_cache
from pathlib import PurePosixPath
from typing import Any, Literal

from app.config import get_settings
from app.errors import IntegrationUnavailable
from app.logging import get_logger

log = get_logger(__name__)

BucketKind = Literal["attachments", "avatars"]


@dataclass(frozen=True, slots=True)
class SignedUpload:
    upload_url: str
    storage_path: str
    #: Header the browser MUST send on the PUT, or the signature will not match.
    required_headers: dict[str, str]
    expires_in: int


def _bucket_name(kind: BucketKind) -> str:
    settings = get_settings()
    name = settings.gcs_attachments_bucket if kind == "attachments" else settings.gcs_avatars_bucket
    if not name:
        raise IntegrationUnavailable(
            f"Cloud Storage is not configured: set GCS_{kind.upper()}_BUCKET.",
            details={"bucket": kind},
        )
    return name


def _client() -> Any:
    """Import lazily so the app starts without google-cloud credentials present."""
    try:
        # The ignore is for mypy alone. ``google`` is a namespace shared by several
        # distributions; once one of them ships type information (google-genai does),
        # mypy resolves ``google.cloud`` for real and no longer waves this through as a
        # missing import. google-cloud-storage itself is untyped.
        from google.cloud import storage  # type: ignore[attr-defined]
    except ImportError as exc:  # pragma: no cover - dependency is declared
        raise IntegrationUnavailable("google-cloud-storage is not installed.") from exc
    return storage.Client()


CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform"


@lru_cache(maxsize=1)
def _adc() -> Any:
    """Application Default Credentials, resolved once.

    Cached because ``google.auth.default()`` re-reads the environment and, on Cloud
    Run, talks to the metadata server. The returned object refreshes its own token in
    place, so caching it does not pin an expired one.
    """
    import google.auth

    credentials, _ = google.auth.default(scopes=[CLOUD_PLATFORM_SCOPE])
    return credentials


def reset_signing_credentials() -> None:
    """Drop the cached credentials. For tests, and for a credential swap at runtime."""
    _adc.cache_clear()


def _signing_kwargs() -> dict[str, str]:
    """The extra arguments ``generate_signed_url`` needs when ADC cannot sign locally.

    Signing a V4 URL requires an RSA private key. Where does the key come from?

    * **Locally**, ``FIREBASE_CREDENTIALS_FILE`` points at a service-account JSON that
      contains one, so ``google-cloud-storage`` signs offline and needs nothing here.
    * **On Cloud Run**, credentials come from the metadata server and carry *only* a
      bearer token. There is no key to sign with, and the library raises::

          AttributeError: you need a private key to sign credentials. the credentials
          you are currently using <class
          'google.auth.compute_engine.credentials.Credentials'> just contains a token.

      The fix is to route signing through the IAM ``signBlob`` API, which the library
      does when given both ``service_account_email`` and ``access_token``.

    ``roles/iam.serviceAccountTokenCreator`` on the service account is necessary but
    **not sufficient** — without these arguments the library never calls ``signBlob``
    at all. ``DEPLOY_CLOUD_RUN.md`` §3 used to imply the role alone was enough.

    Returning ``{}`` for key-bearing credentials keeps local development on the offline
    path, which needs no IAM round trip per signature.
    """
    credentials = _adc()

    # Service-account credentials expose a `signer`; metadata-server ones do not.
    if getattr(credentials, "signer", None) is not None:
        return {}

    import google.auth.transport.requests

    if not credentials.valid:
        credentials.refresh(google.auth.transport.requests.Request())

    email = getattr(credentials, "service_account_email", None)
    # The metadata server reports the literal string "default" until a refresh has
    # resolved the real address. Signing with that would fail with a confusing 403.
    if not email or email == "default":
        raise IntegrationUnavailable(
            "Cannot sign a storage URL: the runtime credentials carry no private key "
            "and no service-account email could be resolved to sign through IAM.",
        )

    return {"service_account_email": email, "access_token": credentials.token}


def _extension(file_name: str) -> str:
    suffix = PurePosixPath(file_name).suffix.lstrip(".").lower()
    # Guard against a filename like "photo" or "..\\..\\etc\\passwd".
    return suffix if suffix.isalnum() and len(suffix) <= 8 else "bin"


def attachment_path(
    estimate_id: str, room_index: int | None, item_index: int | None, file_name: str
) -> str:
    """Build the object key for an estimate attachment.

    Matches the legacy scheme exactly. The millisecond timestamp is what keeps two
    uploads to the same line item from colliding.
    """
    room = room_index if room_index is not None else 0
    item = item_index if item_index is not None else 0
    stamp = int(time.time() * 1000)
    return f"{estimate_id}/{room}_{item}_{stamp}.{_extension(file_name)}"


def closing_form_path(project_id: str, form_number: int, file_name: str) -> str:
    """Build the object key for a closing-form photo.

    Lives in the attachments bucket under its own ``projects/`` prefix, which keeps it
    clear of the estimate keys (those start with a bare estimate UUID) and lets one
    prefix check authorise the whole family. The legacy app stored this photo as a
    base64 data URI inside the ``closing_form_1`` JSONB column, which bloated every
    project-detail read; only the key is stored now.
    """
    stamp = int(time.time() * 1000)
    return f"projects/{project_id}/closing-forms/{form_number}_{stamp}.{_extension(file_name)}"


def avatar_path(user_id: str, file_name: str) -> str:
    """Build the object key for a profile avatar. Deliberately overwrites in place."""
    return f"{user_id}/avatar.{_extension(file_name)}"


# ── Signing ───────────────────────────────────────────────────────────────────


async def create_upload_url(kind: BucketKind, storage_path: str, content_type: str) -> SignedUpload:
    """Mint a V4 signed PUT URL for a direct browser upload.

    ``content_type`` is baked into the signature, so the browser must send exactly the
    same ``Content-Type`` header on the PUT. It is returned in ``required_headers`` so
    the client does not have to guess.
    """
    settings = get_settings()
    bucket_name = _bucket_name(kind)
    ttl = settings.signed_upload_url_ttl_seconds

    def _sign() -> str:
        blob = _client().bucket(bucket_name).blob(storage_path)
        url: str = blob.generate_signed_url(
            version="v4",
            expiration=timedelta(seconds=ttl),
            method="PUT",
            content_type=content_type,
            **_signing_kwargs(),
        )
        return url

    url = await asyncio.to_thread(_sign)
    return SignedUpload(
        upload_url=url,
        storage_path=storage_path,
        required_headers={"Content-Type": content_type},
        expires_in=ttl,
    )


async def create_download_url(kind: BucketKind, storage_path: str) -> str | None:
    """Mint a V4 signed GET URL. Returns ``None`` if storage is unconfigured.

    Returning ``None`` rather than raising is deliberate: an attachment list should
    still render its rows (file names, types, indices) when signing is unavailable,
    with the URL simply absent. That mirrors the legacy behaviour, which fell back to
    ``url: null`` per attachment.
    """
    settings = get_settings()
    try:
        bucket_name = _bucket_name(kind)
    except IntegrationUnavailable:
        return None

    ttl = settings.signed_url_ttl_seconds

    def _sign() -> str:
        blob = _client().bucket(bucket_name).blob(storage_path)
        url: str = blob.generate_signed_url(
            version="v4",
            expiration=timedelta(seconds=ttl),
            method="GET",
            **_signing_kwargs(),
        )
        return url

    try:
        return await asyncio.to_thread(_sign)
    except Exception as exc:
        log.error("storage_sign_failed", path=storage_path, error=str(exc))
        return None


async def delete_object(kind: BucketKind, storage_path: str) -> bool:
    """Remove an object. Never raises — a missing object is not an error here.

    Deletion is best-effort by design: the database row is the system of record, and an
    orphaned blob is a cleanup problem, not a failed request.
    """
    try:
        bucket_name = _bucket_name(kind)
    except IntegrationUnavailable:
        log.info("storage_delete_skipped", path=storage_path)
        return False

    def _delete() -> None:
        _client().bucket(bucket_name).blob(storage_path).delete()

    try:
        await asyncio.to_thread(_delete)
    except Exception as exc:
        log.warning("storage_delete_failed", path=storage_path, error=str(exc))
        return False
    return True


def public_url(kind: BucketKind, storage_path: str) -> str | None:
    """Direct URL for objects in a publicly-readable bucket.

    Only meaningful for avatars, which the legacy system served publicly. Attachments
    must always go through ``create_download_url``.
    """
    try:
        bucket_name = _bucket_name(kind)
    except IntegrationUnavailable:
        return None
    return f"https://storage.googleapis.com/{bucket_name}/{storage_path}"
