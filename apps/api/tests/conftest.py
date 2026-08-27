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
os.environ.setdefault("ENVIRONMENT", "test")
os.environ.setdefault("SITE_URL", "http://testserver")
os.environ.setdefault("CORS_ORIGINS", "http://testserver")
os.environ.setdefault(
    "DATABASE_URL", os.environ.get("TEST_DATABASE_URL", "sqlite+aiosqlite:///:memory:")
)
# Keep every integration unconfigured so nothing reaches the network.
for leaky in (
    "RESEND_API_KEY",
    "SLACK_WEBHOOK_URL",
    "GROQ_API_KEY",
    "GCS_ATTACHMENTS_BUCKET",
    "GCS_AVATARS_BUCKET",
):
    os.environ.pop(leaky, None)

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


@pytest.fixture(scope="session")
def settings():  # type: ignore[no-untyped-def]
    return get_settings()


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
