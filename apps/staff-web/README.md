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

### What the tests cover, and what they do not

`npm run test` (Vitest + Testing Library + MSW) covers components, pages and the pure
logic in `domain/`, with the network mocked. It is fast, runs anywhere, and needs
nothing running.

Nothing currently exercises a real browser against the real API, so the `/api/v1`
proxy, Firebase Auth and Postgres are only ever verified together **by hand**. That is
a deliberate deferral, recorded as `BACKLOG.md` §12 — read it before assuming a green
suite means a working sign-in.

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
  components/   design system — Button, Badge, Modal, Table, Tabs, FileDrop, form controls, AppShell
  features/     one folder per area: auth, estimates, projects, meetings, team, review
  lib/          formatting, CSV, PDF, speech
  styles/       the Tailwind theme
```

`domain/` deliberately mirrors `apps/api/app/services/rules/`. `estimateTotals.ts` and
`estimateRules.ts` are ports of their Python counterparts, and their tests are ported
case-for-case from `apps/api/tests/unit/`. **When the Python changes, change both.**

Two things that will bite if you do not know them:

**Line-item `category` and `unit` are free text, not enums.** `ITEM_CATEGORIES` and
`ITEM_UNITS` are what the dropdowns *offer*; the API accepts any bounded string. That is
what lets a team define its own units in Settings and what stops a legacy `electrical`
row being rewritten to `other` on every save. `withCurrent` in `LineItemsTable` keeps
whatever a row already holds in its dropdown, so rendering a row never silently changes
its value.

**Every money value is a string.** `Decimal` serialises to JSON as `"1234.56"`, so
`totals.total`, `amount`, `total_budget`, `quantity`, and `unit_cost` are all
`string`. Route them through `domain/money.ts`; never `Number()` two and add them.

**Update payloads are built field by field.** Request schemas set `extra="forbid"`, so
spreading a fetched object into a `PATCH` sends `id` and `created_at` and earns a 422.

**Breakpoints inside the signed-in shell are `app-sm:`, not `sm:`.** The shell sits in
`components/AppFrame`, which can dock a panel beside the app, and a viewport breakpoint
cannot see that the app has been given less room. `app-sm:`, `app-md:`, `app-lg:` and
`app-xl:` (declared in `styles/index.css`) measure the app column instead, at the same
widths as their viewport namesakes. Plain `sm:` is still right outside the shell: the
sign-in screens and the reviewer's page. `components/appBreakpoints.test.ts` fails if a
viewport variant appears inside the shell, because nothing else would: jsdom lays
nothing out, so the mistake is invisible until someone opens the panel.

**A grid track that holds a table is `minmax(0,1fr)`, not `1fr`.** A bare `1fr` cannot
be narrower than its widest content, so a wide table stretches the track and the page
scrolls sideways, instead of the table scrolling inside `TableWrap`.

**`Modal` has two forms.** Normally it is the native `<dialog>`. While a panel is docked
it renders into the app column instead, because `showModal()` would make the panel
unusable. A dialog must therefore not assume it is in the top layer, and anything fixed
to the window belongs outside the app column (`AppFrame`'s `launcher`), since a fixed
element inside a container is positioned against the container.

**The editor does not follow the query cache, so a write it did not make has to be
handed to it.** It seeds its details and rooms once and autosaves the whole payload.
`reseed` in `EstimateEditorPage` is how a server copy written by something else gets in;
without it the next keystroke puts the old values back.

---

## BuildCo Assistant

`src/features/agent/`. A voice and text assistant in a panel beside the app. It is off
unless the API says otherwise (`GET /agent/status`), so with nothing configured there is
no launcher and none of this runs. The design is `AGENT_SPEC.md` at the repository root;
the server half is described in `apps/api/README.md`.

| File | What it is |
|---|---|
| `AgentProvider.tsx` | Mounted once in `AppShell`. Owns the socket and the audio; everything else is the reducer |
| `agentState.ts` | A pure reducer over the frames the server sends. Test it by handing it frames |
| `protocol.ts` | The WebSocket frames, mirroring `apps/api/app/agent/conversation.py`. The server is the authority |
| `transport.ts`, `audio.ts` | The socket behind an interface, and the microphone and speaker worklets |
| `AgentPanel.tsx`, `AgentHistory.tsx`, `AgentMemories.tsx` | The panel, past conversations, and the Profile section |

**It writes nothing itself.** A change is *staged*: the server sends a proposal, the
real page shows the real form filled in and read-only, and the user approves or rejects
from the panel. Three pages stage proposals, each with `useStagedProposal(...kinds)`:
the calendar (a meeting), the supplements list (a new supplement) and the supplement
editor (details, status, sending for review). A page tells the provider when the form is
actually on screen, and only then is the server told; that is what stops the assistant
describing a form nobody can see. **To stage a new kind, add it to one page's
`useStagedProposal` call and render it there. The route comes from the server.**

**While it works, the app column is `inert`** and the panel is not (`AppFrame`'s
`locked`). The lock is never left on behind a dead connection: see `isLocked`.

**The editor hands itself to the assistant three ways** (`EstimateEditorPage`): which
supplement is open (`useAgentRecord`), a way to make sure pending edits are saved before
anything is proposed against them (`registerEditor`), and a re-seed after a commit, so
that the next keystroke does not autosave the old values over what was just approved.

**A dropped connection is not the end.** The provider asks for the same conversation
back for a minute, then asks the server what became of the last action either way, so
the panel never says something was lost when it was saved.

In tests, `./transport` and `./audio` are mocked and the conversation is driven by
handing the provider frames: see `AgentProvider.test.tsx`.

### How it looks

The look is `AGENT_DESIGN.md` at the repository root. It changes how the assistant is
drawn and nothing about what it does: what a frame means, when the app locks, and what
Approve, Reject, Stop and End do are all still in the provider and the reducer.

| File | What it is |
|---|---|
| `Orb.tsx`, `presence.ts` | The assistant's face, and which of its eleven states it is in. Worked out from what the panel already knows |
| `AgentPanel.tsx` | The four zones: `PanelHeader`, the body (`HeroState`, `Conversation`, `AgentHistory`), `Dock`, `Controls` |
| `ApprovalCard.tsx`, `Receipt.tsx` | What is waiting to be saved, pinned in the dock; and what became of it, left in the conversation |
| `levels.ts` | The microphone and voice levels as two CSS variables on the card. **Not React state**: nothing re-renders for sound |
| `motion.ts`, `usePresence.ts`, `settling.ts` | The little motion that script drives, and keeping a leaving element on screen long enough to be seen leaving |
| `components/staged.tsx` | How a form the assistant filled in is marked. The form controls read it, so a staged form shows no placeholders |
| `styles/assistant.css` | The orb, the aura and every movement. The colours, shadows and durations are tokens in `index.css` |

Three things to keep true when changing any of it:

- **Violet means "the assistant's, not saved yet", and nothing else.** Blue stays "your
  action" and green stays "saved". Violet is the same lightness as the brand blue, so it
  is never the only signal: the same things are dashed and say so in words.
- **Only `transform` and `opacity` move**, and no animation delays, hides or moves a
  control that could be pressed. Reduced motion needs nothing extra for CSS; script
  checks `reducedMotion()`.
- **The approval card shows what the server sent.** It lays values out; it never formats
  a date or looks a person up. `labels.facts` and `approval_reason` on a proposal are
  typed and used when present, and the server does not send them yet: until it does the
  card draws the same layout from the labels it already has.

**The gallery** is how the look is reviewed without holding a conversation. Run
`npm run dev` and open `/dev/assistant`: the orb and the panel in every state, in light
and dark, drawn from fixed frames through the real reducer (`galleryFixtures.ts`).
`/dev/assistant?scene=stage` is the whole frame, with the launcher, the lock and a staged
form, and buttons that send what a server would, for watching what happens between
states. The route exists only in development and is not in a production build.

---

## The estimates list sorts server-side, and so does everything else on it

Status, search, the date window, pagination **and the sort order** are all the API's job.
Nothing on that screen filters or orders in the browser, because a list that shows one
page at a time cannot correctly do either locally — page two would be filtered and sorted
against only the rows page two happens to hold.

Two consequences worth knowing:

- **"Highest total" reads a stored column.** `rooms` is JSONB, so the total is otherwise
  only knowable in Python. `estimates.total_amount` is maintained on write, purely so the
  database can order by it — the number rendered on the card still comes from
  `totals`, computed per request. If those two ever disagree the display stays right and
  only the ordering is stale, which is the safer way round.
- **The screen asks for `sort=recently_edited` explicitly.** The API's own default is
  still `recently_created`, so no other caller's ordering moved.

The unread dots are the reason `GET /estimates/ids` exists: they have to know what is in
the statuses you are *not* looking at, which a paginated, filtered list cannot tell them.

## The calendar is per-person, not per-team

`GET /meetings` returns what you created and what you were invited to. `scope=all` gives
the whole team's calendar to an owner or admin and is **silently clamped** for everyone
else — so the "Everyone" button not being rendered for a member is a convenience, not the
mechanism. Anyone may create a meeting; only its creator, or an elevated user, may change
or cancel it.

This reverses the original design, which was a deliberately shared calendar with
elevated-only editing. Both the old docstrings and `DEPLOY_CHECKLIST.md` §3.6 said so, and
both have been updated — if you find a comment claiming the calendar is shared, it is
stale, not a spec.

## Settings are shared by the team

The Settings screen — the universal rate list, custom units, custom categories, and
notification toggles — is stored server-side in `catalogue_items` and `team_settings`,
and read through `api/queries/settings.ts`.

This is a deliberate change from the legacy app, which kept all of it in
`localStorage`. That made the "universal" rate list neither universal nor visible to
anyone else: two estimators on the same job saw different prices, and clearing site
data lost the lot. The notification toggles were worse — they gated nothing at all,
because the emails are sent server-side and the browser was never consulted.

Reads are open to any authenticated user, because the estimate editor needs the
catalogue and the custom units to render a line. Writes are elevated: one person
changing a rate changes what everyone quotes.

One thing is still per-browser, and should be: which estimates you have already seen,
which drives the unread dots on the estimates list. That is genuinely
per-person-per-device — syncing it would mean a colleague opening an estimate clears
your dot. It lives in `src/lib/seen.ts`, is capped so the key cannot grow without
limit, and guards every `localStorage` access: it throws in Safari private mode and
wherever a browser is set to block site data.

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
