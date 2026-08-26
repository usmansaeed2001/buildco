# staff-web — React internal ops app

The staff-facing frontend for the BuildCo API: supplement estimates, projects and
payment milestones, meetings, and team administration.

Replaces the legacy static HTML app (`index.html`, `home.html`, `app.html`,
`projects.html`) that talked to Netlify Functions and Supabase.

> Deploying this is a separate document: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
> The short version is that almost nothing changes between here and production.

---

## Prerequisites

| | |
|---|---|
| Node | 20 or newer (`node --version`) |
| The API | Running on `localhost:8000` — see [`apps/api/README.md`](../api/README.md) |
| Firebase | A registered **Web app**, for the config values below |

---

## Setup

**1. Start the backend.** Nothing here works without it.

```bash
cd apps/api
make db-up          # Postgres in Docker
make migrate        # apply the schema
make dev            # http://localhost:8000
```

**2. Configure Firebase.**

```bash
cd apps/staff-web
cp .env.example .env.local
```

Fill in the six `VITE_FIREBASE_*` values from the Firebase console under
**Project settings (gear) → Your apps → Web app**. If no web app is listed, add one —
this is a **separate thing from the backend's service account** and is not created
alongside it (see [`apps/api/docs/FIREBASE_SETUP.md`](../api/docs/FIREBASE_SETUP.md) §7).

While you are there, confirm `localhost` appears under **Authentication → Settings →
Authorized domains**. A missing entry fails sign-in with an error that never mentions
domains.

Running without these is not fatal — the app redirects to `/setup`, which lists exactly
what is missing and where to find it.

**3. Run it.**

```bash
npm install
npm run dev         # http://localhost:5173
```

The first person to sign in against an empty database **becomes the owner**. That is
the backend's provisioning rule (`FIREBASE_SETUP.md` §9), not a frontend behaviour, and
it replaces the Supabase `handle_new_user()` trigger.

---

## How it reaches the API

The app always calls a same-origin **`/api/v1/...`**. What sits behind that path differs
per environment, and nothing in the code does:

```
development    fetch("/api/v1/estimates")
                 └─> Vite dev-server proxy ──> http://localhost:8000

production     fetch("/api/v1/estimates")
                 └─> Firebase Hosting rewrite ──> Cloud Run
```

The proxy is four lines in [`vite.config.ts`](vite.config.ts); the rewrite is in
`firebase.json`. Two consequences worth knowing:

- **`VITE_API_BASE_URL` is not needed for a normal deploy.** It exists only to point a
  local build at a remote backend, and doing so makes requests cross-origin, which then
  requires that origin in the backend's `CORS_ORIGINS`.
- **CORS does not apply in production at all**, because the request never leaves the
  origin. It does apply in development, where the browser really is talking to
  `:5173` while the API is on `:8000` — the proxy is what hides that.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with HMR on :5173 |
| `npm run build` | Typecheck, then production build into `dist/` |
| `npm run preview` | Serve `dist/` locally — **no API proxy**, see below |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run test` | Vitest, once |
| `npm run test:watch` | Vitest, watching |
| `npm run generate:api` | Regenerate `src/api/schema.d.ts` from the API's OpenAPI schema |

`npm run preview` serves the built files but has **no proxy**, so every API call 404s.
To exercise a production build end to end, use the Firebase emulator instead — it
applies the real rewrite. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

### Regenerating API types

`src/api/schema.d.ts` is generated, committed, and must never be hand-edited. When the
backend's schemas change:

```bash
# with the API running on :8000
npm run generate:api
npm run typecheck      # every break is a contract change you now have to handle
```

Committing it means a build never needs a running API — CI can build this without
standing up Postgres.

---

## Architecture

```
src/
  api/          schema.d.ts (generated), client.ts, queries/ (TanStack Query hooks)
  auth/         Firebase setup, AuthProvider, route guards
  domain/       pure logic — money, totals, permission rules. Unit-tested.
  components/   design system — Button, Badge, Modal, form controls, AppShell
  features/     one folder per area: auth, estimates, projects, meetings, team, review
  lib/          formatting, local settings, CSV, PDF, speech
  styles/       the Tailwind theme
```

`domain/` deliberately mirrors `apps/api/app/services/rules/`. `estimateTotals.ts` and
`estimateRules.ts` are ports of their Python counterparts, and their tests are ported
case-for-case from `apps/api/tests/unit/`. **When the Python changes, change both.**

Two things that will bite if you do not know them:

**Every money value is a string.** `Decimal` serialises to JSON as `"1234.56"`, so
`totals.total`, `amount`, `total_budget`, `quantity`, and `unit_cost` are all
`string`. Route them through `domain/money.ts`; never `Number()` two and add them.

**Update payloads are built field by field.** Request schemas set `extra="forbid"`, so
spreading a fetched object into a `PATCH` sends `id` and `created_at` and earns a 422.

---

## Settings are stored in this browser

The Settings screen — the universal rate list, custom units, custom categories, and
notification toggles — writes to `localStorage`. There is no table or endpoint for any
of it, in this backend or the previous one.

So it is **per-browser and per-device**: it does not sync between machines, is not
shared with the team, and is lost when site data is cleared. That matches the legacy
behaviour exactly, and it is a deliberate deferral rather than an oversight.

Everything is isolated in `src/lib/localSettings.ts`, so moving it server-side later is
a contained change: add the tables and endpoints, then swap that module's
implementation.

---

## Troubleshooting

**Redirected to `/setup` on every page.** No Firebase config. Fill in `.env.local` and
restart — Vite reads env files only at startup.

**Sign-in fails with an error that mentions nothing useful.** The origin is probably
missing from **Authentication → Settings → Authorized domains**.

**Every API call 404s.** The backend is not running, or is not on port 8000. Check
`curl http://localhost:8000/healthz`.

**Signed in, but every request 401s.** The account was banned — the backend rechecks
status on each request, so revocation is immediate. The app signs you out
automatically; the login screen then explains it and files an access request.

**`/readyz` says degraded.** The API is up but the database is not. `make db-up` in
`apps/api`.
