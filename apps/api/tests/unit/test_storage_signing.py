"""How a storage URL gets signed, and why it differs between local and Cloud Run.

These are unit tests over ``_signing_kwargs`` rather than API tests, because the thing
being tested is a decision about credentials, not a request. No network and no GCP
project is involved: the credential shapes are stood up as fakes.

The bug they exist to prevent is real and shipped: signed uploads returned 500 on Cloud
Run, and downloads silently came back with no URL at all, while both worked perfectly on
every developer's machine.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.errors import IntegrationUnavailable
from app.services.integrations import storage


class KeyBearingCredentials:
    """A service-account JSON, as used locally. Carries a private key, so the client
    library can sign a V4 URL offline."""

    valid = True
    token = "local-token"
    service_account_email = "local-sa@example.iam.gserviceaccount.com"
    signer = object()


class MetadataCredentials:
    """Cloud Run's credentials. A bearer token and nothing to sign with.

    Deliberately has no ``signer`` attribute at all, which is what
    ``google.auth.compute_engine.Credentials`` looks like.
    """

    def __init__(self, *, valid: bool = True, email: str = "api@example.iam.gserviceaccount.com"):
        self.valid = valid
        self.token = "metadata-token"
        self.service_account_email = email
        self.refreshed = False

    def refresh(self, _request: Any) -> None:
        self.refreshed = True
        self.valid = True
        self.token = "refreshed-token"
        if self.service_account_email == "default":
            self.service_account_email = "api@example.iam.gserviceaccount.com"


@pytest.fixture(autouse=True)
def _clear_cache() -> Any:
    storage.reset_signing_credentials()
    yield
    storage.reset_signing_credentials()


def _use(credentials: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(storage, "_adc", lambda: credentials)


def test_credentials_with_a_private_key_sign_offline(monkeypatch: pytest.MonkeyPatch) -> None:
    """Local development must not gain an IAM round trip per signature."""
    _use(KeyBearingCredentials(), monkeypatch)

    assert storage._signing_kwargs() == {}


def test_metadata_credentials_sign_through_iam(monkeypatch: pytest.MonkeyPatch) -> None:
    """The Cloud Run path: no private key, so signing is delegated to signBlob.

    Passing both arguments is what makes the library call the IAM API. Holding
    ``roles/iam.serviceAccountTokenCreator`` is necessary but does nothing on its own.
    """
    _use(MetadataCredentials(), monkeypatch)

    assert storage._signing_kwargs() == {
        "service_account_email": "api@example.iam.gserviceaccount.com",
        "access_token": "metadata-token",
    }


def test_an_expired_token_is_refreshed_before_it_is_used(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    credentials = MetadataCredentials(valid=False)
    _use(credentials, monkeypatch)

    kwargs = storage._signing_kwargs()

    assert credentials.refreshed is True
    assert kwargs["access_token"] == "refreshed-token"


def test_a_valid_token_is_not_refreshed_on_every_signature(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Signing happens per attachment; a metadata round trip each time would show."""
    credentials = MetadataCredentials(valid=True)
    _use(credentials, monkeypatch)

    storage._signing_kwargs()

    assert credentials.refreshed is False


def test_an_unresolved_service_account_is_refused_rather_than_signed_with(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The metadata server reports the literal "default" until a refresh resolves it.

    Signing with that string fails at Google with a 403 that names nothing useful, so
    it is rejected here where the message can say what is actually wrong.
    """

    class NeverResolves(MetadataCredentials):
        def refresh(self, _request: Any) -> None:
            self.refreshed = True
            self.valid = True

    _use(NeverResolves(valid=False, email="default"), monkeypatch)

    with pytest.raises(IntegrationUnavailable, match="no private key"):
        storage._signing_kwargs()


def test_missing_service_account_email_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    _use(MetadataCredentials(email=""), monkeypatch)

    with pytest.raises(IntegrationUnavailable):
        storage._signing_kwargs()


@pytest.mark.anyio
async def test_a_download_url_survives_a_signing_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An attachment list must still render its rows when signing is unavailable.

    This is the failure mode that hid the original bug: uploads raised a visible 500,
    but downloads caught, logged ``storage_sign_failed`` and returned ``None`` — so
    existing attachments rendered with no URL and no error anywhere.
    """
    monkeypatch.setattr(storage, "_bucket_name", lambda _kind: "bucket")

    def explode() -> dict[str, str]:
        raise RuntimeError("no signing identity")

    monkeypatch.setattr(storage, "_signing_kwargs", explode)

    assert await storage.create_download_url("attachments", "some/path.png") is None
