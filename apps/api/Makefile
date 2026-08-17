# Shortcuts for the common loops. Everything here is a plain uv/docker command —
# nothing depends on make, it just saves typing.

.PHONY: help install dev test test-pg lint fix typecheck check db-up db-down \
        migrate migration downgrade reset clean

help:  ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install:  ## Install dependencies, including dev tooling
	uv sync --group dev

dev:  ## Run the API with reload on http://localhost:8000
	uv run uvicorn app.main:app --reload --port 8000

test:  ## Run the test suite (SQLite; no Docker needed)
	uv run pytest

test-pg: db-up  ## Run the test suite against real Postgres, as CI does
	@# A dedicated database: the suite creates and drops every table, so pointing
	@# it at the dev database would wipe local development data.
	@docker exec buildco-db createdb -U buildco buildco_test 2>/dev/null || true
	TEST_DATABASE_URL=postgresql+asyncpg://buildco:buildco@localhost:5432/buildco_test uv run pytest

lint:  ## Check formatting and lint rules
	uv run ruff check .
	uv run ruff format --check .

fix:  ## Apply auto-fixes and format
	uv run ruff check . --fix
	uv run ruff format .

typecheck:  ## Run mypy in strict mode
	uv run mypy app

check: lint typecheck test  ## Everything CI runs

db-up:  ## Start the local Postgres container
	docker compose up -d db
	@echo "waiting for postgres..."
	@until docker exec buildco-db pg_isready -U buildco -d buildco >/dev/null 2>&1; do sleep 1; done
	@echo "ready on localhost:5432"

db-down:  ## Stop the local Postgres container
	docker compose down

migrate:  ## Apply all migrations
	uv run alembic upgrade head

migration:  ## Generate a revision: make migration m="add project documents"
	@test -n "$(m)" || (echo 'usage: make migration m="what changed"' && exit 1)
	uv run alembic revision --autogenerate -m "$(m)"
	@echo
	@echo "Now READ the generated file. Autogenerate misses server defaults,"
	@echo "constraint changes, and data backfills entirely."

downgrade:  ## Roll back one revision
	uv run alembic downgrade -1

reset: db-down  ## Destroy the local database and rebuild it from scratch
	docker volume rm buildco-pgdata 2>/dev/null || true
	$(MAKE) db-up
	$(MAKE) migrate

clean:  ## Remove caches and build artefacts
	rm -rf .pytest_cache .mypy_cache .ruff_cache htmlcov .coverage
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
