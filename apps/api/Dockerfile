# Multi-stage build. The runtime image carries no build tooling and no uv.

FROM python:3.12-slim AS builder

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

WORKDIR /app

# Dependencies first, as their own layer: application code changes on every commit,
# the lockfile rarely does, so this layer stays cached across most builds.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

COPY app ./app
COPY alembic ./alembic
COPY alembic.ini ./
RUN uv sync --frozen --no-dev


FROM python:3.12-slim AS runtime

# Never run as root.
RUN groupadd --system --gid 1001 app \
 && useradd --system --uid 1001 --gid app --no-create-home app

WORKDIR /app

COPY --from=builder --chown=app:app /app /app

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080

# The release version, read by app/__init__.py and reported by /livez. Declared this late
# so that a new number invalidates no layer worth caching. A plain `docker build` leaves
# the placeholder.
ARG APP_VERSION=0.0.0.dev0
ENV APP_VERSION=${APP_VERSION}

USER app
EXPOSE 8080

# Cloud Run sets $PORT and may not use 8080. Honour it.
# One worker per container: Cloud Run scales by adding containers, and extra workers
# would multiply the database connections each instance holds — see the connection
# budget in README.md.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1 --no-access-log"]
