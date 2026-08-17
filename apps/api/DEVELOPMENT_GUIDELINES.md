# Development Guidelines — BuildCo API

The contract this codebase is held to. Read it before writing code here, whether you
are a person or an agent picking up a fresh session.

The short version: **routers are thin, services orchestrate, rules decide, integrations
are the only things that touch the network.** Everything below follows from that.

---

## 1. The layers, and what each may do

| Layer | May do | May **not** do |
|---|---|---|
| `routers/` | Validate input, declare required role, call one service, serialise, schedule background work | Query the database, contain business rules, check roles inline |
| `deps.py` | Authenticate, authorise, load a row for an access check | Contain domain logic |
| `services/` | Load data, call rules, mutate the session, raise `AppError` | Import FastAPI, call `commit()`, make network calls directly |
| `services/rules/` | Compute decisions from plain data | Any I/O whatsoever — no session, no HTTP, no clock reads that matter |
| `services/integrations/` | Call third-party APIs | Contain business rules |
| `models/` | Define tables and trivial derived properties | Contain behaviour |
| `schemas/` | Define the wire contract and validate it | Query anything |

Dependencies point one way: `routers → services → rules`. If you find yourself wanting
a rule to import a service, the rule needs an argument instead.

### Why `rules/` is separate

The project auto-transitions are the most business-visible logic in the system. In the
legacy backend the same nested `if` was copy-pasted into three handlers and drifted.
Extracting it as a pure function means the whole matrix is testable in milliseconds
with no database, and there is exactly one place it can be wrong.

If a decision can be expressed as *data in, decision out*, it belongs in `rules/`.

---

## 2. Adding a feature — worked example

Say we are adding **project documents**: files attached to a project rather than to an
estimate line item.

**1. Model** — `app/models/project_document.py`

```python
class ProjectDocument(Base, UUIDPrimaryKey, TimestampMixin):
    __tablename__ = "project_documents"

    project_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    file_name: Mapped[str] = mapped_column(String(500), nullable=False)
    storage_path: Mapped[str] = mapped_column(String(1000), nullable=False)
```

Then **re-export it from `app/models/__init__.py`**. A model that is not imported there
is invisible to Alembic autogenerate — the classic way to silently lose a table.

Keep `import uuid` at module level, not under `TYPE_CHECKING`: SQLAlchemy resolves
`Mapped[...]` annotations when the class is created.

**2. Schemas** — `app/schemas/project_document.py`

```python
class ProjectDocumentCreate(Schema):  # Schema forbids unknown keys
    file_name: str = Field(min_length=1, max_length=500)
    storage_path: str = Field(min_length=1, max_length=1000)


class ProjectDocumentOut(ORMSchema):  # ORMSchema reads from ORM objects
    id: uuid.UUID
    project_id: uuid.UUID
    file_name: str
    created_at: datetime
```

A field a client must never set does not appear on the request model. Do not accept it
and strip it later.

**3. Rules** — only if there is a decision to make. "Who may delete a document?" is
one; put it in `services/rules/project_rules.py` as a pure predicate over snapshots.

**4. Service** — `app/services/project_service.py` (extend the existing one; a new file
per table is not the unit here)

```python
async def add_document(
    session: AsyncSession, actor: Profile, project: Project, data: dict[str, Any]
) -> ProjectDocument:
    document = ProjectDocument(project_id=project.id, **data)
    session.add(document)
    await session.flush()  # flush for the id, never commit
    log_activity(session, project.id, actor, "Document added", document.file_name)
    return document
```

**5. Router** — `app/routers/projects.py`

```python
@router.post(
    "/{project_id}/documents",
    response_model=ProjectDocumentOut,
    status_code=status.HTTP_201_CREATED,
)
async def add_document(
    body: ProjectDocumentCreate,
    db: DbSession,
    actor: CurrentUser,
    project: AccessibleProject,  # loads the project AND enforces access
) -> ProjectDocumentOut:
    """Attach a document to a project."""
    document = await project_service.add_document(db, actor, project, body.model_dump())
    return ProjectDocumentOut.model_validate(document)
```

Register the router in `app/main.py` if it is a new one.

**6. Tests** — a happy path and an authorisation denial, at minimum:

```python
async def test_a_document_can_be_attached(owner_client): ...
async def test_an_unassigned_member_cannot_attach_a_document(client_as, member): ...
```

**7. Migration**

```bash
uv run alembic revision --autogenerate -m "add project documents"
```

Then **read the generated file** before committing it. Autogenerate misses server
defaults, check-constraint changes, and anything requiring a data backfill.

---

## 3. Authorisation

**Always at the route, never in the handler.**

```python
# Right — the requirement is visible in the signature and in the OpenAPI schema.
async def create_project(body: ProjectCreate, actor: Elevated) -> ProjectOut: ...


# Wrong — this is how the legacy backend ended up with handlers that disagreed.
async def create_project(body: ProjectCreate, actor: CurrentUser) -> ProjectOut:
    if actor.role not in ("owner", "admin"):
        raise Forbidden(...)
```

Available guards, in `deps.py`:

| Dependency | Admits |
|---|---|
| `CurrentUser` | Any authenticated, non-banned user |
| `Elevated` | Owners and admins |
| `Owner` | Owners only |
| `AccessibleProject` | Loads a project and 404s a member who is not assigned to it |
| `require_role(...)` | Build a custom combination — rarely needed |

Row-level rules that a route cannot express (may *this* user edit *that* estimate) live
in `services/rules/` and are applied by the service.

**404 versus 403.** When the resource's *existence* is itself privileged — another
member's estimate, an unassigned project — return 404. Use 403 when the caller may know
the thing exists but not perform the action, such as editing a locked estimate.

---

## 4. Transactions

`get_db` commits once at the end of a successful request and rolls back on any
exception. Therefore:

- **Services never call `commit()`.** They `flush()` when they need a generated id.
- A multi-step operation — update a project, write an activity row, run the rules
  engine, write its follow-up rows — is atomic automatically.
- Anything that must survive independently of the request belongs in a background task
  with its own session (see `services/notifications.py`).

Use `session.begin_nested()` when an expected `IntegrityError` must not poison the
surrounding transaction — `estimate_service.create_estimate` does this for identifier
collisions.

---

## 5. Background work

Email, Slack, and calendar calls **never** block a response.

```python
@router.post("/{estimate_id}/submit")
async def submit(..., background: BackgroundTasks) -> SubmitForReviewOut:
    result = await estimate_service.submit_for_review(db, user, estimate_id, ...)
    background.add_task(notifications.notify_one, recipient, subject, template, context)
    return ...
```

Background tasks run after the response and after the session has closed, so they must
open their own session — `notifications.notify_admins` does. Nothing in that module
raises; a provider outage must not surface as a request error for work that already
committed.

---

## 6. Integrations

Each adapter in `services/integrations/` follows the same contract:

- Reads configuration from `get_settings()`.
- **Degrades to a logged no-op** when its credential is missing, so the service boots
  and serves with nothing provisioned. This is what makes local development and CI
  possible without a GCP project.
- Raises `IntegrationUnavailable` (503) only when the request genuinely cannot be
  satisfied without it — the AI parser with no Groq key, a signed upload URL with no
  bucket.
- Swallows and logs failures for fire-and-forget work.

Adding a new one: create the module, add its optional settings to `config.py` and
`.env.example`, add a row to the README's configuration table, and give it a fake for
tests.

---

## 7. Testing

```bash
uv run pytest                       # everything, ~12s
uv run pytest tests/unit            # rules only, no DB
uv run pytest -k project_rules      # one area
TEST_DATABASE_URL=postgresql+asyncpg://buildco:buildco@localhost:5432/buildco_test uv run pytest
```

Tests default to SQLite so the suite needs no Docker and no network. Run them against
Postgres in CI: SQLite does not enforce CHECK constraints the same way and treats JSON
as text, so a type or constraint bug can hide there.

**Expectations:**

- Every function in `rules/` needs unit tests covering its whole matrix. These are
  cheap — there is no excuse for a gap.
- Every route needs at least a happy path and an authorisation denial.
- Any behaviour that differs deliberately from the legacy backend gets a test naming
  the difference, so nobody "fixes" it back.

**Fixtures** (`tests/conftest.py`): `owner`, `admin`, `member`, `other_member` profiles;
`owner_client`, `member_client`, `anon_client`; `client_as(profile)` for anything else;
`notifications` recording what would have been sent; `db` for arranging state and
asserting on it directly.

Name tests as sentences describing the behaviour — `test_unpaying_a_milestone_reopens_a_closed_project`,
not `test_milestone_update_2`. The name is the specification.

---

## 8. Migrations

- **Never edit a revision that has been applied anywhere.** Write a new one.
- Always read what autogenerate produced. It misses server defaults, constraint
  changes, and data backfills entirely.
- Every migration needs a working `downgrade()`. Test both directions locally:
  ```bash
  uv run alembic upgrade head && uv run alembic downgrade -1 && uv run alembic upgrade head
  ```
- Migrations must be **backward-compatible with the currently deployed code**
  (expand/contract), because deploy and migrate are not atomic. Add a nullable column,
  ship code that writes it, backfill, then add the constraint — across separate
  releases.
- Never destructive without a fresh verified backup.

---

## 9. Style

- **Python 3.12.** Modern syntax: `X | None`, `list[X]`, `match`, PEP 695 generics.
- `ruff check` and `ruff format` are the arbiters. Line length 100.
- `mypy --strict` passes on `app/`. Keep it that way.
- The `TC` (flake8-type-checking) rules are **deliberately disabled** — they move
  imports into `if TYPE_CHECKING:`, which breaks SQLAlchemy's `Mapped[...]` resolution
  and FastAPI's annotation evaluation, both of which happen at runtime.
- Enums are `StrEnum` and stored as text with a CHECK constraint, matching the schema
  that transfers from Supabase.
- Money is `Decimal` and `Numeric(12, 2)`. Never float. Not anywhere, not once.
- Datetimes are timezone-aware UTC (`datetime.now(UTC)`), and columns are
  `DateTime(timezone=True)`.

### Comments

Explain **why**, not what. The code already says what.

```python
# Good — the reader cannot recover this from the code.
# Set eagerly: selectin loaders populate on a query, and a freshly flushed object has
# not been queried. Without this, serialising would lazy-load from async context.
creator = (user,)

# Useless.
# Set the creator.
creator = (user,)
```

Docstrings on anything public: what it does, and any non-obvious constraint or
consequence. Where behaviour differs from the legacy backend deliberately, say so and
say why — that is how the decision survives the next person's instinct to "fix" it.

---

## 10. Security

- Never trust a client-supplied path, id, or status. Validate ownership server-side —
  `attachment_service.record_attachment` checks the storage path prefix for exactly
  this reason.
- Secrets come from the environment. Never in code, never in a committed file.
  `.env` is gitignored; `.env.example` carries placeholders only.
- Public endpoints (`/auth/status`, `/public/reviews/*`) are the attack surface. Keep
  their responses minimal and free of internal identifiers, and think about
  enumeration before adding a field.
- Anything that mutates state is POST/PATCH/PUT/DELETE. Never GET — see the legacy
  approve-by-GET-link problem documented in the README.
- Tokens use `secrets`, never `random`, and are compared with
  `secrets.compare_digest`.
- `AUTH_DISABLED` is a local-development escape hatch. Settings validation refuses to
  start with it set in staging or production; do not weaken that check.

---

## 11. Pull request checklist

```markdown
- [ ] `uv run ruff check . && uv run ruff format --check .` passes
- [ ] `uv run mypy app` passes
- [ ] `uv run pytest` passes
- [ ] New rules have unit tests covering the whole matrix
- [ ] New routes have a happy-path test and an authorisation-denial test
- [ ] Authorisation is declared at the route, not checked inline
- [ ] New models are re-exported from `app/models/__init__.py`
- [ ] Migration generated, read line by line, and reversible
- [ ] New settings added to `config.py`, `.env.example`, and the README table
- [ ] New endpoints documented in the README endpoint table
- [ ] Deliberate behaviour changes documented and covered by a named test
```
