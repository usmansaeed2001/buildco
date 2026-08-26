"""Application settings.

Values come from environment variables (and a local ``.env`` in development). In
Cloud Run they arrive as plain env vars injected from Secret Manager — see
``--set-secrets`` in the deploy command, and the secret-name mapping table in the
README.

Every third-party credential is optional. When one is absent the corresponding
integration degrades to a logged no-op rather than raising, so the service boots and
serves in an environment with nothing provisioned. That mirrors the behaviour of the
legacy Node functions, which returned early from ``sendEmail`` when ``RESEND_API_KEY``
was unset.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated, Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

Environment = Literal["local", "test", "staging", "production"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ── Core ──────────────────────────────────────────────────────────────────
    environment: Environment = "local"
    debug: bool = False
    api_v1_prefix: str = "/api/v1"

    #: Canonical public origin of the app. Used to build approval links and the
    #: logo URL in emails. The legacy functions defaulted this to three different
    #: hardcoded hosts across four files; there is now exactly one source.
    site_url: str = "http://localhost:5173"

    #: Origins allowed to call the API from a browser. Accepts a comma-separated
    #: string from the environment; ``NoDecode`` stops pydantic-settings from trying
    #: to JSON-parse it first, so the validator below gets the raw value.
    cors_origins: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["http://localhost:5173"]
    )

    # ── Database ──────────────────────────────────────────────────────────────
    #: SQLAlchemy async URL, e.g.
    #:   postgresql+asyncpg://user:pass@localhost:5432/buildco
    #: On Cloud Run with the Cloud SQL connector, point the host at the unix socket:
    #:   postgresql+asyncpg://user:pass@/buildco?host=/cloudsql/PROJECT:REGION:INSTANCE
    database_url: str = "postgresql+asyncpg://buildco:buildco@localhost:5432/buildco"

    #: Kept deliberately small: db-f1-micro has a low connection ceiling and Cloud Run
    #: runs many instances, each with its own pool. See README "Connection budget".
    db_pool_size: int = 2
    db_max_overflow: int = 3
    db_echo: bool = False

    # ── Auth (Firebase) ───────────────────────────────────────────────────────
    #: Path to a service-account JSON file. When unset, the Admin SDK falls back to
    #: Application Default Credentials, and if those are missing too the auth
    #: provider switches to its fake implementation.
    firebase_credentials_file: str | None = None
    firebase_project_id: str | None = None

    #: Development escape hatch: skip token verification and inject a synthetic
    #: owner profile so every endpoint is exercisable before Firebase exists.
    #: Rejected outright in staging/production.
    auth_disabled: bool = False
    auth_dev_email: str = "dev-owner@buildco.local"
    auth_dev_name: str = "Dev Owner"

    # ── Storage (Cloud Storage) ───────────────────────────────────────────────
    gcs_attachments_bucket: str | None = None
    gcs_avatars_bucket: str | None = None
    #: Signed download URL lifetime. The legacy code used 7 days (the Supabase max).
    signed_url_ttl_seconds: int = 604_800
    signed_upload_url_ttl_seconds: int = 900

    # ── Email (Resend) ────────────────────────────────────────────────────────
    resend_api_key: str | None = None
    notify_from_email: str = "onboarding@resend.dev"

    # ── Slack ─────────────────────────────────────────────────────────────────
    slack_webhook_url: str | None = None

    # ── AI (Groq) ─────────────────────────────────────────────────────────────
    groq_api_key: str | None = None
    groq_model: str = "llama-3.3-70b-versatile"
    groq_base_url: str = "https://api.groq.com/openai/v1"

    # ── Google Calendar ───────────────────────────────────────────────────────
    calendar_timezone: str = "America/Los_Angeles"

    # ── Outbound HTTP ─────────────────────────────────────────────────────────
    http_timeout_seconds: float = 20.0

    @field_validator("site_url")
    @classmethod
    def _strip_trailing_slash(cls, v: str) -> str:
        return v.rstrip("/")

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, v: object) -> object:
        """Accept a comma-separated string so the value survives an env var."""
        if isinstance(v, str):
            return [origin.strip() for origin in v.split(",") if origin.strip()]
        return v

    @model_validator(mode="after")
    def _forbid_disabled_auth_outside_dev(self) -> Settings:
        if self.auth_disabled and self.environment in ("staging", "production"):
            raise ValueError(
                "AUTH_DISABLED must not be set in staging or production. "
                "It bypasses all authentication."
            )
        return self

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def logo_url(self) -> str:
        return f"{self.site_url}/logo.png"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached settings accessor. Use this everywhere instead of instantiating."""
    return Settings()
