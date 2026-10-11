"""Shared test fixtures.

Tests run against SQLite by default so the suite needs no Docker and no network.
Point ``TEST_DATABASE_URL`` at Postgres to run the same tests with production
fidelity — worth doing in CI, since SQLite does not enforce CHECK constraints on
enum-backed columns the same way and treats JSON as text.

Authentication is bypassed by overriding ``get_current_user`` with a fixture-chosen
profile, which gives each test precise control over the caller's role. Notifications
are replaced with a recorder so nothing is ever actually sent.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any

# Configure the environment before anything imports app.config, whose settings object
# is cached for the process lifetime.
#
# **Assigned, never ``setdefault`` and never ``pop``.** pydantic-settings reads a
# developer's ``.env`` as well as the environment, and the environment wins. So:
#
# * ``pop`` protects nothing. Removing ``SLACK_WEBHOOK_URL`` from the environment leaves
#   the value in ``.env`` in force. That is how this suite came to post every test
#   submission to a real Slack channel: a production webhook was in a local ``.env``,
#   this file popped the variable and believed the integration was off.
# * ``setdefault`` protects only when the shell has not exported the variable. A
#   developer with ``DATABASE_URL`` exported at their dev database would have had these
#   tests create and drop every table in it.
#
# An empty string is "unset" to every integration here (each checks ``if not …``), and it
# outranks whatever the file says.
os.environ["ENVIRONMENT"] = "test"
os.environ["SITE_URL"] = "http://testserver"
os.environ["CORS_ORIGINS"] = "http://testserver"
os.environ["DATABASE_URL"] = os.environ.get("TEST_DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ["AUTH_DISABLED"] = "false"

#: Every setting that would let a test reach a real third party. Checked again below,
#: after the settings are loaded, because being wrong about this is not survivable.
OUTBOUND_SETTINGS = {
    "RESEND_API_KEY": "resend_api_key",
    "SLACK_WEBHOOK_URL": "slack_webhook_url",
    "OPEN_AI_API_KEY": "open_ai_api_key",
    "GROQ_API_KEY": "groq_api_key",
    "GCS_ATTACHMENTS_BUCKET": "gcs_attachments_bucket",
    "GCS_AVATARS_BUCKET": "gcs_avatars_bucket",
    "FIREBASE_CREDENTIALS_FILE": "firebase_credentials_file",
}
for variable in OUTBOUND_SETTINGS:
    os.environ[variable] = ""

# The assistant is off under test unless a test switches it on, for the same reason.
os.environ["AGENT_ENABLED"] = "false"
os.environ["AGENT_AUDIENCE"] = "pilot"
os.environ["AGENT_PILOT_EMAILS"] = ""
os.environ["AGENT_SERVE_LIVE"] = "false"
os.environ["GOOGLE_CLOUD_PROJECT"] = ""

import logging  # noqa: E402

import pytest  # noqa: E402

# The SQLite driver logs every statement, which buries the assertion that actually
# failed. Application logs stay at ERROR so a genuine 500 is still visible.
for chatty in ("aiosqlite", "sqlalchemy.engine", "asyncio"):
    logging.getLogger(chatty).setLevel(logging.WARNING)
logging.getLogger("app").setLevel(logging.CRITICAL)
from fastapi import Depends  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy.ext.asyncio import (  # noqa: E402
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import StaticPool  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.db import get_db  # noqa: E402
from app.deps import get_current_user  # noqa: E402
from app.main import create_app  # noqa: E402
from app.models import Base  # noqa: E402
from app.models.enums import Role, UserStatus  # noqa: E402
from app.models.profile import Profile  # noqa: E402
from app.models.settings import SETTINGS_ROW_ID, TeamSettings  # noqa: E402

# Refuse to run at all if any integration is still configured. The assignments above
# should make this impossible; this is here because "should" was the whole problem.
_configured = [
    variable
    for variable, attribute in OUTBOUND_SETTINGS.items()
    if getattr(get_settings(), attribute)
]
if _configured:
    raise RuntimeError(
        "Refusing to run the tests: these integrations are configured and a test could "
        f"reach a real service: {', '.join(_configured)}. Check tests/conftest.py."
    )
if not get_settings().database_url.startswith(("sqlite", "postgresql+asyncpg://")) or (
    "TEST_DATABASE_URL" not in os.environ and not get_settings().database_url.startswith("sqlite")
):
    raise RuntimeError("Refusing to run the tests against a database that is not a test one.")


def pytest_collection_modifyitems(config, items):  # type: ignore[no-untyped-def]
    """Skip the ``postgres``-marked tests on SQLite, where they would prove nothing.

    They assert on row locks. SQLite ignores ``FOR UPDATE``, so there they would either
    fail for no reason or, worse, pass without the lock existing.
    """
    if get_settings().database_url.startswith("postgresql"):
        return
    skip = pytest.mark.skip(reason="needs Postgres row locks: run `make test-pg`")
    for item in items:
        if "postgres" in item.keywords:
            item.add_marker(skip)


@pytest.fixture(scope="session")
def settings():  # type: ignore[no-untyped-def]
    return get_settings()


@pytest.fixture(scope="session", autouse=True)
def no_real_network():  # type: ignore[no-untyped-def]
    """Make any real HTTP request from a test fail, loudly, before it leaves the machine.

    The second line of defence behind the settings above. Every outbound call in this
    codebase goes through httpx, and a real request ends at one of these two transports.
    A test that talks to the app itself uses ``ASGITransport``, and one that fakes a
    third party uses ``MockTransport``; neither is touched. So the only thing this can
    break is a test that was about to contact a real service, which is the point.

    Session-scoped with a patcher of its own, not the ``monkeypatch`` fixture: asking for
    that here would set it up ahead of every test's own fixtures and so undo a test's
    patches after them instead of before, which breaks any fixture that cleans up
    something a test has patched.
    """
    import httpx

    def refuse(self, request, *args, **kwargs):  # type: ignore[no-untyped-def]
        raise RuntimeError(
            f"A test tried to make a real network request to {request.url.host}. Tests "
            "must never reach a real service: fake the integration instead."
        )

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", refuse)
        patch.setattr(httpx.HTTPTransport, "handle_request", refuse)
        yield


@pytest.fixture
async def engine(settings):  # type: ignore[no-untyped-def]
    """A fresh schema per test, so no test can observe another's rows."""
    kwargs: dict[str, Any] = {}
    if settings.database_url.startswith("sqlite"):
        # StaticPool keeps every session on the same in-memory database.
        kwargs = {"poolclass": StaticPool, "connect_args": {"check_same_thread": False}}

    eng = create_async_engine(settings.database_url, **kwargs)
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await eng.dispose()


@pytest.fixture
async def session_factory(engine):  # type: ignore[no-untyped-def]
    return async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)


@pytest.fixture
async def db(session_factory) -> AsyncIterator[AsyncSession]:
    """A session for arranging fixtures and asserting on state directly."""
    async with session_factory() as session:
        yield session


# ── Notification recorder ─────────────────────────────────────────────────────


@dataclass
class SentNotification:
    kind: str
    subject: str
    template: str
    context: dict[str, Any]
    recipient: str | None = None
    #: The notification-settings key this message is gated on, if any. Recorded rather
    #: than acted on — see `fake_admins`.
    pref: str | None = None


@dataclass
class NotificationRecorder:
    """Captures what would have been sent, so tests can assert on it."""

    sent: list[SentNotification] = field(default_factory=list)

    def subjects(self) -> list[str]:
        return [s.subject for s in self.sent]

    def templates(self) -> list[str]:
        return [s.template for s in self.sent]


@pytest.fixture(autouse=True)
def fake_auth_provider():  # type: ignore[no-untyped-def]
    """Pin token verification to the fake provider for every test.

    Without this the result depends on the machine: a developer with
    ``FIREBASE_CREDENTIALS_FILE`` set in ``.env`` (or with gcloud ADC available) builds
    the real provider, which rejects the synthetic tokens these tests send. Popping the
    env vars is not enough, because pydantic-settings still reads ``.env``.
    """
    from app.services.integrations import firebase

    def _unavailable(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("Firebase is deliberately unavailable under test.")

    # Patch the construction rather than ``get_auth_provider`` itself: routers import
    # that function by reference at module scope, so rebinding the module attribute
    # would not reach them. Making the real provider fail to build sends the (cached,
    # shared) resolver down its own non-production fallback to the fake.
    original = firebase.FirebaseAuthProvider
    firebase.FirebaseAuthProvider = _unavailable  # type: ignore[assignment]
    firebase.reset_auth_provider()
    try:
        yield
    finally:
        firebase.FirebaseAuthProvider = original  # type: ignore[assignment]
        firebase.reset_auth_provider()


@pytest.fixture
def notifications(monkeypatch) -> NotificationRecorder:  # type: ignore[no-untyped-def]
    from app.services import notifications as module

    recorder = NotificationRecorder()

    async def fake_admins(subject, template, context, *, exclude_id=None, pref=None):  # type: ignore[no-untyped-def]
        # `pref` is accepted and recorded but NOT acted on. Re-implementing the gate
        # here would only test the fake; the real gate lives in `notify_admins` and is
        # exercised against it directly in `test_settings_api`.
        recorder.sent.append(
            SentNotification("admins", subject, template, dict(context), pref=pref)
        )

    async def fake_one(recipient, subject, template, context, *, attachments=None):  # type: ignore[no-untyped-def]
        recorder.sent.append(SentNotification("one", subject, template, dict(context), recipient))

    async def fake_many(recipients, subject, template, context, *, attachments=None):  # type: ignore[no-untyped-def]
        recorder.sent.append(
            SentNotification("many", subject, template, dict(context), ",".join(recipients))
        )

    monkeypatch.setattr(module, "notify_admins", fake_admins)
    monkeypatch.setattr(module, "notify_one", fake_one)
    monkeypatch.setattr(module, "notify_many", fake_many)
    return recorder


# ── Profiles ──────────────────────────────────────────────────────────────────


async def _make_profile(
    session_factory, *, role: Role, email: str | None = None, name: str = ""
) -> Profile:
    async with session_factory() as session:
        profile = Profile(
            id=uuid.uuid4(),
            firebase_uid=f"fb-{uuid.uuid4().hex[:12]}",
            email=email or f"{role.value}-{uuid.uuid4().hex[:6]}@buildco.test",
            full_name=name or f"Test {role.value.title()}",
            role=role.value,
            status=UserStatus.ACTIVE.value,
        )
        session.add(profile)
        await session.commit()
        await session.refresh(profile)
        return profile


@pytest.fixture
async def owner(session_factory) -> Profile:  # type: ignore[no-untyped-def]
    return await _make_profile(session_factory, role=Role.OWNER, name="Olivia Owner")


@pytest.fixture
async def admin(session_factory) -> Profile:  # type: ignore[no-untyped-def]
    return await _make_profile(session_factory, role=Role.ADMIN, name="Adam Admin")


@pytest.fixture
async def member(session_factory) -> Profile:  # type: ignore[no-untyped-def]
    return await _make_profile(session_factory, role=Role.MEMBER, name="Mia Member")


@pytest.fixture
async def other_member(session_factory) -> Profile:  # type: ignore[no-untyped-def]
    return await _make_profile(session_factory, role=Role.MEMBER, name="Sam Second")


@pytest.fixture
async def reviewer(session_factory) -> Profile:  # type: ignore[no-untyped-def]
    """A profile configured as the team's estimate reviewer.

    Deliberately a ``member``: who signs off on an estimate is a business decision, not
    an administrative permission, and a test suite that only ever proved it works for an
    admin would let that distinction quietly rot.

    Any test that submits an estimate for review needs this — without a configured
    reviewer, submission is a 409 by design.
    """
    profile = await _make_profile(
        session_factory, role=Role.MEMBER, name="Rita Reviewer", email="rita@buildco.test"
    )
    async with session_factory() as session:
        row = TeamSettings(id=SETTINGS_ROW_ID, default_reviewer_id=profile.id)
        session.add(row)
        await session.commit()
    return profile


# ── HTTP client ───────────────────────────────────────────────────────────────


@pytest.fixture
def app_factory(session_factory, notifications):  # type: ignore[no-untyped-def]
    """Build an app whose database and current user are under the test's control."""

    def build(user: Profile | None):  # type: ignore[no-untyped-def]
        application = create_app()

        async def override_db() -> AsyncIterator[AsyncSession]:
            async with session_factory() as session:
                try:
                    yield session
                except Exception:
                    await session.rollback()
                    raise
                else:
                    await session.commit()

        application.dependency_overrides[get_db] = override_db

        if user is not None:

            async def override_user(session: AsyncSession = Depends(get_db)) -> Profile:
                """Re-read per request so role changes made mid-test are honoured.

                It takes the *request's* session rather than opening its own, because
                that is what the real ``get_current_user`` does. Loading the profile
                into a separate session returns an object that detaches the moment that
                session closes, so any handler mutating the current user — saving an
                avatar, updating a name — would flush nothing and silently no-op.
                """
                refreshed = await session.get(Profile, user.id)
                return refreshed if refreshed is not None else user

            application.dependency_overrides[get_current_user] = override_user

        return application

    return build


@pytest.fixture
def client_as(app_factory) -> Callable[[Profile | None], AsyncClient]:  # type: ignore[no-untyped-def]
    """Build an HTTP client acting as a given profile, or anonymously with ``None``."""

    def build(user: Profile | None) -> AsyncClient:
        application = app_factory(user)
        return AsyncClient(transport=ASGITransport(app=application), base_url="http://testserver")

    return build


@pytest.fixture
async def owner_client(client_as, owner) -> AsyncIterator[AsyncClient]:  # type: ignore[no-untyped-def]
    async with client_as(owner) as client:
        yield client


@pytest.fixture
async def member_client(client_as, member) -> AsyncIterator[AsyncClient]:  # type: ignore[no-untyped-def]
    async with client_as(member) as client:
        yield client


@pytest.fixture
async def anon_client(client_as) -> AsyncIterator[AsyncClient]:  # type: ignore[no-untyped-def]
    async with client_as(None) as client:
        yield client
