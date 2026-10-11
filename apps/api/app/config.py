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

    # ── AI note parsing ───────────────────────────────────────────────────────
    #
    # OpenAI is the primary provider. Groq remains configured as a fallback for one
    # release: deploying the code and setting the secret are separate acts here, so a
    # hard cutover would leave the parser dead in the window between them. Once
    # OPEN_AI_API_KEY is set in every environment, the Groq settings and the branch in
    # ``integrations/ai_provider`` come out.
    #
    # Spelled OPEN_AI_API_KEY, not OPENAI_API_KEY, to match what is actually set in the
    # environment. Renaming it "correctly" would silently unconfigure the parser.
    open_ai_api_key: str | None = None
    openai_model: str = "gpt-4o-mini"
    openai_base_url: str = "https://api.openai.com/v1"

    groq_api_key: str | None = None
    #: Groq retires hosted models on its own schedule and does not keep the old
    #: name working — a retired id fails every call with a 400 that only says the
    #: model does not exist. `llama-3.3-70b-versatile` was the original default and
    #: is gone. Check https://console.groq.com/docs/models before assuming this one
    #: is still live; overriding GROQ_MODEL per environment is cheaper than a deploy.
    groq_model: str = "openai/gpt-oss-120b"
    groq_base_url: str = "https://api.groq.com/openai/v1"

    # ── Google Calendar ───────────────────────────────────────────────────────
    calendar_timezone: str = "America/Los_Angeles"

    # ── Outbound HTTP ─────────────────────────────────────────────────────────
    http_timeout_seconds: float = 20.0

    # ── BuildCo Assistant (the voice agent) ───────────────────────────────────
    #
    # With nothing set the service boots and the assistant reports itself disabled,
    # like every other integration here. There is no secret: the model is reached
    # with the Cloud Run service account.

    #: Whether the feature exists in this environment. Read once at startup, so it is
    #: a deploy-time switch. **It is not the way to stop live conversations**: an
    #: instance draining its sockets keeps the value it started with. The team's
    #: allowance, which is read from the database, is the off switch.
    agent_enabled: bool = False
    #: ``pilot`` or ``everyone``. ``everyone`` has to be typed; nothing defaults to it.
    agent_audience: Literal["pilot", "everyone"] = "pilot"
    #: Who gets the assistant while the audience is ``pilot``. **Empty means nobody**,
    #: so a variable forgotten in a new environment gives it to no one.
    agent_pilot_emails: Annotated[list[str], NoDecode] = Field(default_factory=list)
    #: Whether this process mounts the voice WebSocket and loads ADK. True on the
    #: ``buildco-agent`` service and for local development; false on ``buildco-api``,
    #: which serves only the assistant's REST endpoints.
    agent_serve_live: bool = False

    #: Model ids are configuration because they are what rots: see ``groq_model``.
    agent_model: str = "gemini-3.8-live"
    agent_voice: str = "Kore"
    google_cloud_project: str | None = None
    google_cloud_location: str = "us-central1"

    #: The public WebSocket origin handed to the browser. Hosting's ``/api/**`` rewrite
    #: does not proxy WebSockets, so in production this is the agent service's own
    #: ``wss://…run.app`` origin, not the site's.
    agent_ws_base_url: str = "ws://localhost:8000"

    agent_max_session_seconds: int = 1800
    agent_daily_minutes_default: int = 10
    agent_idle_warning_seconds: int = 90
    agent_idle_timeout_seconds: int = 120
    #: How long an unanswered proposal waits before it expires.
    agent_proposal_ttl_seconds: int = 600
    #: How long the microphone stays live after a read-back before the audio pauses.
    agent_approval_voice_window_seconds: int = 30
    agent_transcript_retention_days: int = 90
    #: A session ticket is single-use and short-lived: it travels in a URL.
    agent_ticket_ttl_seconds: int = 60

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

    @field_validator("agent_pilot_emails", mode="before")
    @classmethod
    def _split_pilot_emails(cls, v: object) -> object:
        """Comma-separated in the environment; compared lower-cased."""
        if isinstance(v, str):
            return [email.strip().lower() for email in v.split(",") if email.strip()]
        return v

    @field_validator("agent_ws_base_url")
    @classmethod
    def _strip_ws_trailing_slash(cls, v: str) -> str:
        return v.rstrip("/")

    @model_validator(mode="after")
    def _forbid_disabled_auth_outside_dev(self) -> Settings:
        if self.auth_disabled and self.environment in ("staging", "production"):
            raise ValueError(
                "AUTH_DISABLED must not be set in staging or production. "
                "It bypasses all authentication."
            )
        return self

    @model_validator(mode="after")
    def _forbid_a_half_configured_agent_service(self) -> Settings:
        """Refuse to start the voice service without what it needs to send email.

        Every integration here degrades to a logged no-op when its credential is
        missing, which is right for local development and exactly wrong for this
        process. It is the one that sends meeting invites and reviewer emails for
        whatever the assistant commits, and its environment is managed separately from
        the API's. Left to degrade, a missing key means the user is told a meeting was
        created and nobody is ever invited to it. A missing value is therefore a failed
        deploy, which someone sees.
        """
        if not self.agent_serve_live or self.environment not in ("staging", "production"):
            return self
        problems = []
        if not self.resend_api_key:
            problems.append("RESEND_API_KEY is not set, so no invite or review email is sent")
        if "localhost" in self.site_url or "127.0.0.1" in self.site_url:
            problems.append("SITE_URL points at localhost, so emailed links go nowhere")
        if self.notify_from_email == "onboarding@resend.dev":
            problems.append(
                "NOTIFY_FROM_EMAIL is the Resend sandbox sender, which delivers only to "
                "the account owner"
            )
        if problems:
            raise ValueError(
                "AGENT_SERVE_LIVE is set, but this process cannot send the email the "
                "assistant's actions owe: " + "; ".join(problems) + "."
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
