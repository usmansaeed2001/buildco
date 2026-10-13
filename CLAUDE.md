# CLAUDE.md

Guidance for Claude Code (and any other agent) working in this repository. It is a
map, not a copy: the linked documents are the source of truth, and where this file and
one of them disagree, the linked document wins.

## What this is

Monorepo for the BuildCo construction-operations platform: supplement estimates,
projects and payment milestones, meetings, and BuildCo Assistant.

```
apps/
  api/        FastAPI backend, Python 3.12, SQLAlchemy async, Alembic, Postgres 16
  staff-web/  React 19 + Vite + TypeScript + Tailwind 4, TanStack Query, Firebase Auth
assistant_docs/  Specs for BuildCo Assistant (AGENT_SPEC.md is the main one)
```

Production: API on Cloud Run, Postgres on Cloud SQL, frontend on Firebase Hosting with
an `/api/**` rewrite to Cloud Run (so the web app always calls same-origin `/api/v1`).

## Read before changing code

| Working on | Read first |
|---|---|
| Anything in `apps/api` | `apps/api/DEVELOPMENT_GUIDELINES.md` — the contract the backend is held to |
| Anything in `apps/staff-web` | `apps/staff-web/README.md`, especially "Architecture" |
| BuildCo Assistant | `assistant_docs/AGENT_SPEC.md`, then the companion docs it points to |
| Releases, deploys | `RELEASE.md`, `DEPLOY_CHECKLIST.md` |
| Known gaps | `BACKLOG.md` |

## Commands

API (from `apps/api`; `make help` lists everything):

```bash
uv sync --group dev          # install
make dev                     # run on :8000 (needs `make db-up` + `make migrate` first)
make test                    # pytest on SQLite, no Docker needed
make test-pg                 # pytest on Postgres in Docker, as CI does
make lint                    # ruff check + ruff format --check
make fix                     # ruff autofix + format
make typecheck               # mypy --strict on app/
make check                   # lint + typecheck + test
make migration m="..."       # autogenerate a revision — then READ it
```

Single test: `uv run pytest tests/unit/test_file.py::test_name`.

Web (from `apps/staff-web`):

```bash
npm ci
npm run dev                  # Vite dev server
npm run lint                 # eslint
npm run test                 # vitest run
npm run build                # tsc -b + vite build (this is also the typecheck)
npm run generate:api         # regenerate src/api/schema.d.ts from the running API
```

Before pushing, run what CI runs for the app you touched (`.github/workflows/ci.yml`):
API → ruff check, ruff format --check, mypy, pytest (SQLite and Postgres);
web → lint, test, build.

## Backend rules that matter most

Full detail in `apps/api/DEVELOPMENT_GUIDELINES.md`. The short version:
**routers are thin, services orchestrate, rules decide, integrations are the only
things that touch the network.**

- Dependencies point one way: `routers → services → services/rules`.
- `services/rules/` is pure: data in, decision out, no I/O. Every rule gets unit tests
  covering its whole matrix.
- Authorisation is declared at the route (dependency in the signature), never checked
  inline in a handler.
- Services never call `commit()`; they `flush()` when they need an id.
- Writes with more than one caller go through `services/actions.py`.
- Integrations degrade to a logged no-op when their credential is missing.
- Money is `Decimal` / `Numeric(12, 2)`. Never float.
- Datetimes are timezone-aware UTC. Enums are `StrEnum`, stored as text with a CHECK.
- Do **not** enable ruff's `TC` rules or move imports under `TYPE_CHECKING`:
  SQLAlchemy and FastAPI resolve annotations at runtime.
- Mutations are POST/PATCH/PUT/DELETE, never GET.
- Every route needs at least a happy-path test and an authorisation-denial test.
- New models are re-exported from `app/models/__init__.py`. New settings go in
  `config.py`, `.env.example`, and the README table.

## Migrations

- Must be backward-compatible with the currently deployed code (expand/contract): a
  release applies the migration and rolls the code as separate steps.
- Never edit a revision that has been applied anywhere; write a new one.
- Always read what autogenerate produced — it misses server defaults, constraint
  changes and data backfills.
- Every migration needs a working `downgrade()`, tested in both directions.

## Frontend rules that matter most

- `src/domain/` mirrors `apps/api/app/services/rules/` (totals, estimate, project, user
  rules) with tests ported case-for-case. **When the Python rule changes, change both.**
- API types are generated (`src/api/schema.d.ts`); don't hand-write domain types.
- Every money value from the API is a string. Route it through `domain/money.ts`;
  never `Number()` and add.
- Request schemas forbid extra fields: build PATCH payloads field by field, don't spread
  a fetched object.
- Inside the signed-in shell use `app-sm:`/`app-md:`/`app-lg:`/`app-xl:` breakpoints,
  not `sm:` etc. (`components/appBreakpoints.test.ts` enforces it).
- A grid track that holds a table is `minmax(0,1fr)`, not `1fr`.

## Git and releases

- One long-lived branch, `main`. Branch as `feature/…`, `fix/…`, `hotfix/…`, `chore/…`
  and open a PR into `main`.
- Commit subjects in the imperative mood; explain *why* in the body when not obvious.
- PR titles end up in release notes — write them for that reader.
- A merge to `main` deploys nothing. Releases are the manual Release workflow, which
  tags `vX.Y.Z`. **Never bump version numbers by hand** — the git tag is the version.
- Never commit `.env` files, service-account JSON, or other secrets.

## Comments

Write comments that tell the reader what they cannot recover from the code (why a thing
is done, what breaks otherwise). Don't narrate what the code plainly does.
