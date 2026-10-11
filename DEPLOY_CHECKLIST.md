# Deploy checklist and human-action register

**Read this before every release.** It is the running list of everything that needs a
person — decisions, credentials, console clicks, and the hand-verification that stands
in for an automated end-to-end suite.

It exists because two things are true of this project at once: a merge to `production`
deploys nothing on its own ([`RELEASE.md`](RELEASE.md)), and no test anywhere drives a
real browser against a real backend ([`BACKLOG.md`](BACKLOG.md) §12). So a green
`development` means the code is *believed* correct, not that anyone has watched it work.

> Naming note: this is deliberately not called a backlog. [`BACKLOG.md`](BACKLOG.md)
> records known gaps in the system. **This file records what a human must do**, and
> every entry is either a blocker, a step, or a thing to check with your own eyes.

---

## 1. Blockers — production is wrong until these are done

These are not "nice to have before launch". Each one means a feature that looks fine in
the UI and silently fails for real users.

### 1.1 Resend — key and sender are not in production

**Status: open. Local development is configured; production is not.**

A domain is verified and `notifications@lahandyconstruction.com` is the sender.
`apps/api/.env` carries both values for local work. Cloud Run does **not** read that
file — it takes `RESEND_API_KEY` from the Secret Manager secret `resend-key` and
`NOTIFY_FROM_EMAIL` from its own environment.

Until both are updated, production sends as `onboarding@resend.dev`, which **delivers
only to the address that owns the Resend account**. Every other recipient is dropped.
And `integrations/email.py` never raises — it logs `email_skipped` and returns `False` —
so nothing appears broken while every reviewer email, every access request, and every
project-assignment notice quietly fails to arrive.

```bash
# Paste the key at the prompt, then Ctrl-D. Do not pass it on the command line —
# it would land in your shell history.
gcloud secrets versions add resend-key \
  --project=buildco-production-505918 --data-file=-

gcloud run services update buildco-api \
  --project=buildco-production-505918 --region=us-central1 \
  --update-env-vars=NOTIFY_FROM_EMAIL=notifications@lahandyconstruction.com
```

- [ ] Secret updated
- [ ] `NOTIFY_FROM_EMAIL` updated on the service
- [ ] A real estimate sent for review to an address **outside** the Resend account, and
      confirmed to arrive

> The key was shared in a chat transcript. Rotating it is cheap and worth doing.

### 1.2 Signed Cloud Storage URLs fail on Cloud Run

**Status: fixed in code. Needs an API release to take effect, then verifying.**

`generate_signed_url` had no signing identity, so on Cloud Run — where the credentials
carry a bearer token and no private key — uploads returned 500 and downloads came back
with a `null` URL and **no error anywhere**. `storage._signing_kwargs()` now routes
signing through the IAM `signBlob` API when the credentials cannot sign locally.
[`BACKLOG.md`](BACKLOG.md) §2 has the diagnosis.

This one cannot be confirmed from a test suite — it depends on what the metadata server
hands the process, which only exists on Cloud Run.

- [ ] API released with the fix
- [ ] Upload a photo in production: the thumbnail appears
- [ ] **Reload the page.** The thumbnail still resolves — this is the half that used to
      fail silently
- [ ] If it does not: confirm `roles/iam.serviceAccountTokenCreator` is bound **on the
      service account resource itself**, not just project-wide. The role is necessary
      but is not sufficient on its own, and the runbook used to imply otherwise

### 1.3 Google sign-in shows an unverified-app warning

**Status: open, and it will not resolve itself.** [`BACKLOG.md`](BACKLOG.md) §5.

The OAuth app is in Testing mode, so **every tester's Google account must be added under
Test users** (100 max) or their sign-in fails. They will also see "Google hasn't
verified this app" and must click **Advanced → Go to BuildCo**, because sign-in requests
the sensitive `calendar.events` scope.

Two consequences that surprise people later:

- In Testing mode, Google **refresh tokens expire after 7 days**. Calendar and Meet-link
  creation will need periodic re-consent.
- None of this affects email/password sign-in, which is the smoother path for a beta.

- [ ] Every tester's Google account allowlisted, or testers told to use email/password
- [ ] Consent screen branded (app name, support email, logo, home page, privacy policy)

---

## 2. Before you run a release

From [`RELEASE.md`](RELEASE.md), repeated here because it is the step most easily
skipped:

- [ ] `development` merged into `production` and pushed
- [ ] **Working tree is clean.** `gcloud builds submit` uploads your working directory,
      not the branch — uncommitted edits *will* ship, and that is the easiest way to
      deploy something that exists on no branch at all
- [ ] `git status --porcelain` empty and `git rev-parse HEAD origin/production` matching
- [ ] Any new migration is backward-compatible with the currently deployed revision
- [ ] Release only what changed — the API and the frontend are independent

After the API release:

```bash
API=$(gcloud run services describe buildco-api --region=us-central1 \
  --project=buildco-production-505918 --format='value(status.url)')

curl -sf "$API/readyz"    # {"status":"ready","database":"up"}
curl -s "https://buildco-production-505918.web.app/api/v1/auth/status?email=you@example.com"
```

Check `/readyz` against the **Cloud Run URL**, not the Hosting origin — it sits outside
`/api/**`, so Hosting serves `index.html` and `curl -sf` passes whether the database is
reachable or not.

`/healthz` always 404s: Cloud Run's front end reserves that exact path and the request
never reaches the container. **Point uptime checks at `/livez`**, which is the same
probe under a path that is not intercepted. A check aimed at `/healthz` reports a
perfectly healthy service as down.

---

## 2b. After migrating: check the estimate totals backfilled

**No test covers this and none can.** The suite builds its schema from
`Base.metadata.create_all` and never runs a migration, so a green run says nothing about
whether revision `b7c4e1f2a930` filled in `total_amount` for the estimates already in the
database. If it silently did nothing, every existing estimate sorts as $0 under "Highest
total" and nothing else looks wrong.

```sql
-- Should return no rows: an estimate with line items but a zero stored total.
SELECT identifier, total_amount, jsonb_array_length(rooms) AS rooms
FROM estimates
WHERE total_amount = 0 AND jsonb_array_length(rooms) > 0;
```

Spot-check a couple against what the app shows — the number on the card is computed
independently, so if they agree the backfill worked.

---

## 3. Hand-verification, because nothing else does it

No automated test drives a real browser, a real Firebase session, or real Postgres
together. Until that changes ([`BACKLOG.md`](BACKLOG.md) §12), these paths are verified
only by someone walking them.

Run these against production after a release, or locally before merging something risky.

### 3.1 Estimates — the core loop

- [ ] Sign in; the estimates list loads
- [ ] Create an estimate; it opens in the editor with a `CLM-######` claim ID
- [ ] Add a room, add a line item, set a quantity and a unit cost
- [ ] **Wait ~2 seconds, then reload.** The values are still there — this proves the
      debounced autosave committed
- [ ] Edit a field and navigate away within a second, then come back. The edit survived
      (autosave flushes on unmount)
- [ ] Undo restores a deleted room, including its line items
- [ ] Export CSV; open it in Excel and confirm columns line up and accented characters
      render
- [ ] Deep-link straight to `/estimates/<id>` in a fresh tab — it loads rather than 404s

### 3.2 The approval loop

- [ ] Send an estimate for approval to an address you control
- [ ] **The email arrives** (this is what §1.1 gates)
- [ ] Open the link in a private window with no session. The review page renders
- [ ] Approve. A receipt appears
- [ ] Reload the same link. It now says the estimate was already reviewed, not "not
      found"
- [ ] Request changes on a different estimate; the note reaches the submitter and shows
      in the editor under "View changes requested"

### 3.3 Notes parsing, dictation and the report

- [ ] **Parse notes** on an estimate: dictate or type "Kitchen — 200 square feet of
      drywall at 2.50", parse, and confirm the preview shows a Kitchen room.
      **This now runs on OpenAI** — see §5 for `OPEN_AI_API_KEY`
- [ ] Add it to an estimate that already has rooms; the existing ones survive
- [ ] Undo takes the parse back
- [ ] **Dictation is Chromium-only.** In Chrome or Edge the Dictate button appears; in
      Firefox or Safari it is replaced by a line of text saying so. Check both — a mic
      button that silently does nothing is worse than none
- [ ] Dictate in Spanish with the ES toggle
- [ ] **Report → Download PDF.** Open the file: the figures match the screen, and a long
      estimate spans several pages with no trailing blank page
- [ ] Try the parser with `GROQ_API_KEY` unset (or watch for a 503 in production): the
      message should say the parser is unconfigured and that items can still be added by
      hand — not show a raw error

> **This moved to OpenAI because of exactly that.** Groq retires hosted models without
> aliasing the old id forward, and a retired id fails **every** call with a 400 saying
> only that the model does not exist. It happened twice: `llama-3.3-70b-versatile` was
> already dead when the environment was first provisioned, and was *still* the value in
> `apps/api/.env` when parsing was reported broken. The adapter now logs the model id on
> a provider 400, so the next time it is one log line rather than a guess.
>
> Groq remains wired as a fallback for **one release**, so that deploying the code and
> setting the secret need not happen at the same moment. Once `OPEN_AI_API_KEY` is set
> everywhere, delete `GROQ_API_KEY`, `GROQ_MODEL`, and the branch in
> `integrations/ai_provider.py`.

### 3.4 Projects

- [ ] Create a project; it opens on its own page
- [ ] Advance the work stepper. It responds immediately, and survives a reload
- [ ] Put the project **on hold**, then resume it
- [ ] Add two milestones. Mark both paid — with the work still in progress the project
      stays **Active**
- [ ] Set work status to **Completed**. The project becomes **Closed**, and the line
      beside the badge says why
- [ ] **Un-pay one milestone.** The project reopens to **Pending Payment**. This is the
      one to check by hand: the legacy app only ever moved a project forward, so a
      mistaken "paid" click closed it permanently
- [ ] Link a supplement. It appears in the budget as revenue on top of the base budget
- [ ] Edit Labor / Materials / Collected; the figures save on blur and the profit line
      recomputes
- [ ] Sign in as a **member assigned to the project**: they can advance work and pay
      milestones, but cannot edit details, delete, change status, or delete a milestone
- [ ] Sign in as a member **not** assigned: the project 404s rather than 403s, and the
      list says they have no assigned projects

### 3.5 Closing forms

These are **signed legal documents**. The wording is reproduced verbatim from the legacy
app and must not be paraphrased — someone has agreed to those exact sentences.

- [ ] Open the **Material Sign-Off**. Check the letterhead against the legacy form:
      address, phone, email, licence number
- [ ] It refuses to submit without a signature
- [ ] Add a material photo *(needs §1.2 released)*; the thumbnail appears
- [ ] Submit it. The card marks it done, and the activity feed records it
- [ ] Reopen it, click **Edit**, correct a field, submit again — these are signed on a
      phone in a driveway and a typo must be fixable
- [ ] **Print it.** Only the document prints — no dialog chrome, no page navigation, no
      buttons. Fields print as filled-in blanks rather than as form controls with
      borders. Compare against a legacy printout side by side
- [ ] Open the **Project Sign-Off**. Confirm the $250-per-day and 7-day clauses read
      exactly as they did before
- [ ] It refuses to submit without **both** signatures
- [ ] Submit it. The work status becomes **Completed**, and the project closes (or moves
      to awaiting payment if a milestone is unpaid)

### 3.6 Calendar and meetings

- [ ] The month grid shows six weeks and does not change height as you page
- [ ] **Create a meeting at 6pm.** It appears on *that* day, not the next one. This is
      the timezone check — UTC bucketing puts an evening meeting in the Americas on
      tomorrow
- [ ] Reload. It is still on the same day at the same time
- [ ] Click a day → the day view opens; the URL carries the date, so it can be shared
- [ ] Invite someone. **They receive an ICS invite** (this needs §1.1)
- [ ] Change only the colour. **No new invite is sent** — the backend re-invites only on
      a material change, and re-inviting for a recolour is what trained people to ignore
      the legacy invites
- [ ] Move the time. An invite *is* re-sent
- [ ] Cancel it. Attendees receive a cancellation
- [ ] Sign in as a **member**: they see **only meetings they created or were invited
      to** — not the whole team's calendar. This reverses the original design; if a
      member can see an owner's unrelated meeting, the scope filter is broken open
- [ ] The same member can **create** a meeting, and can edit and cancel that one
- [ ] They **cannot** edit or cancel a meeting someone else created, even one they are
      invited to (403, not a hidden button — check the API, not just the UI)
- [ ] As an owner, the **Everyone** scope shows the whole team; as a member that option
      is not offered, and adding `?scope=all` to the URL by hand still shows only theirs
- [ ] **Week, day and year views.** The day and week views are an hour grid: drag across
      it to create a meeting at those times, and check a plain click also works
- [ ] Tab into the day grid and press Enter — a meeting can be created without a mouse

> **Google Meet links need §1.3.** Without a Google sign-in carrying the
> `calendar.events` scope, meetings are created with no Meet link — which is normal, not
> a failure, and the form says so. In Testing mode the refresh token expires after
> **7 days**, so this will stop working periodically until the OAuth app is verified.

### 3.6b Reviewer, pagination and the report

- [ ] **Settings → Reviewer**: choose someone. Any user is selectable, including a
      `member` — that is deliberate, approval is authorised by the emailed token rather
      than by a role
- [ ] Send an estimate for review. The modal **names** the reviewer rather than asking
      for an address, and the mail arrives at that person's account email
- [ ] Clear the reviewer (or test on a fresh database) and try to submit: it fails with a
      message pointing at Settings, and the estimate stays `active` rather than being
      marked submitted with nothing sent
- [ ] **New estimate** now asks for a name before it creates anything. Create one with a
      name, a client and a claim ID, and confirm the card on the list shows that name
- [ ] Create one with the claim ID left blank: a `CLM-######` is generated
- [ ] Try a claim ID that already exists: it is refused with a message naming it, and
      **no estimate is created under a different number**. This is the failure the change
      exists to prevent — silently renumbering what somebody typed
- [ ] A claim ID with spaces (`Self Pay`) is accepted. That is deliberate; the identifiers
      already in the database look like that
- [ ] Rows created by the old flow read **Untitled · CLM-…** rather than all saying
      "New Estimate"
- [ ] The card shows **Edited …**, and it changes after you edit that estimate
- [ ] An estimate with no rooms says **Not priced yet** rather than $0.00
- [ ] **Sort**: all four orders work. "Highest total" reflects an edit made *after*
      creation — that is the one that catches a stale stored total
- [ ] **Row menu** on a card: Archive (owners/admins only — check a member does not see
      it) and Delete, which confirms first and lands in Trash
- [ ] Opening the row menu does **not** open the estimate
- [ ] **New estimate**: the Project manager field is pre-filled with your own name
- [ ] The estimate editor's second tab reads **Supplement Details**, not Project Details
- [ ] **Estimates list**: page through with Previous/Next; the count is the total, not
      the page. Narrow it with the date pickers and confirm paging resets to the first
      page
- [ ] The unread dots on the status chips still light for statuses that are **not** on
      the current page — they are fed by `GET /estimates/ids`, not by the list
- [ ] **Report → Download PDF** on an estimate with photos: the photos are in the file.
      Reload first, so the images are fetched cold — that is the case that used to
      rasterise as empty boxes *(needs §1.2 released)*

### 3.7 Team, profile and settings

- [ ] **Team**: change someone's role; it takes effect on reload
- [ ] Your own row offers no role control and a disabled Remove — nobody changes their
      own role, and nobody removes themselves
- [ ] As an **admin**, the owner's row offers no role control and Remove is disabled
      saying "The owner cannot be removed". Demote first is deliberate: it makes locking
      the team out of its own account a two-step, owner-only act
- [ ] Remove a member. They are signed out **immediately**, not at token expiry
- [ ] Have them try to sign in; an access request appears on the Team page. Restore it
      and confirm they can sign in again
- [ ] **Profile**: change your name; the topbar updates without a reload
- [ ] Upload a photo *(needs §1.2 released)*
- [ ] **Settings**: add a rate. **Open it in another browser or as another user** — it
      is there. This is the whole point of the phase; in the legacy app the "universal"
      rate list was per-browser
- [ ] Add a custom unit; it appears in the estimate editor's unit dropdown
- [ ] Turn off "Member removed", then remove someone. **No email arrives.** Turn it back
      on and repeat: the email arrives. The legacy toggles gated nothing at all

### 3.8 The parity sweep's own additions

- [ ] Add a rate in Settings, then in an estimate click **From rate list** — it is
      there, priced. Change the rate afterwards: the line you already added keeps its
      old price
- [ ] Add a custom unit in Settings; it appears in the estimate editor's unit dropdown
      and **saves** (this used to be a 422 — see the note below)
- [ ] Open an estimate migrated from the legacy app that uses an `electrical` or
      `plumbing` category. Edit something else and save. **The category is unchanged.**
      It used to be rewritten to `other` on every save
- [ ] With two statuses populated, look at one: the other's chip carries a red dot.
      Click it; the dot clears and stays cleared

### 3.9 Attachments *(needs §1.2 released first)*

- [ ] Upload a photo to a line item; the thumbnail appears
- [ ] Reload; the thumbnail still resolves — this is the part §1.2 breaks silently
- [ ] Upload a video; it opens and plays
- [ ] Delete an attachment; it disappears and stays gone after a reload
- [ ] Drag a file onto the drop zone rather than using the picker

---

### 3.10 BuildCo Assistant *(only once it is switched on)*

Nothing here applies while `AGENT_ENABLED` is unset: the release is safe to ship with
the assistant off, and that is how it should first go out.

**Before the pilot starts**

- [ ] Release with `AGENT_ENABLED` unset and confirm nothing has changed for anyone.
- [ ] Create `buildco-agent` (`apps/api/docs/DEPLOY_CLOUD_RUN.md` §8b) and compare its
      environment variables and secret bindings with `buildco-api`'s, line by line.
- [ ] Look up the project's **Vertex AI Live quota for concurrent sessions** and write
      it here: `____`. A quota below the pilot's size is refused conversations at busy
      moments, which should be a known number and not a surprise.
- [ ] Set a **budget alert on Vertex AI spend**. Worst case per day is team size ×
      the daily allowance.
- [ ] Decide `AGENT_SPEC.md` Q1 (cold start) and Q2 (instance caps).
- [ ] Put two or three people in `AGENT_PILOT_EMAILS` and set `AGENT_AUDIENCE=pilot`.

**Walkthrough: real microphone, real model, real Cloud Run, on laptop speakers and on
an iPad.** The automated tests script the model; these are what only a person can check.

- [ ] Someone not on the pilot list sees no launcher. Someone on it does.
- [ ] Start, ask for a meeting with nobody invited, hear the read-back, say yes after it
      ends. It is saved.
- [ ] Say yes *over* the read-back. It is not saved, and the assistant asks again.
- [ ] **An invite booked through the assistant arrives.** Ask for a meeting with an
      outside guest by email; the address is spelled back; approval needs a click; the
      guest receives the invite with its `.ics`. Nothing else proves the voice service
      can send email.
- [ ] **A review link sent through the assistant opens the real review page.** Ask it to
      send a supplement for review, click Approve, open the emailed link. A link to
      `localhost` means `SITE_URL` is wrong on `buildco-agent`.
- [ ] Ask it to archive "this one" with a supplement open; it names that supplement.
- [ ] Ask it to delete something. It says it cannot and where to do it by hand.
- [ ] Open a dialog yourself, then ask for something. It asks you to close it first, and
      the panel stays usable beside the dialog.
- [ ] Press Stop on a staged meeting. The form becomes yours, still filled.
- [ ] Leave a proposal unanswered for 30 seconds. The microphone pauses; Tap to talk
      brings it back; Approve works throughout.
- [ ] Turn Wi-Fi off for ten seconds mid-conversation. It reconnects and carries on.
- [ ] "Remember that I like 45 minute meetings." It appears under Profile, What the
      assistant remembers, and can be deleted there.
- [ ] As an owner, set the daily allowance to 0 in Settings while someone is talking.
      Their conversation ends within a few seconds. Set it back.
- [ ] On the iPad: all of the above that involve audio, in Safari.

**In the first week, watch** (structured logs, by event name)

| Signal | Reading |
|---|---|
| `agent_proposal_superseded` per `agent_proposal_committed` | High means it is mishearing and being corrected |
| `agent_voice_commit_rejected` against voice approvals accepted | High means the timing guard is too strict for real speech |
| `agent_readback_unverified` | High means most voice approvals are being turned into clicks |
| `agent_proposal_handed_over` | People giving up on it mid-task |
| `agent_reconnected` per conversation | Network or Cloud Run trouble |
| `agent_live_error` | Vertex AI failures, quota included |
| `agent_allowance_exhausted`, and minutes used per person | Whether ten minutes fits real work |
| Cloud SQL connections in use | Whether the budget holds, especially during a deploy |
| Daily Vertex AI spend | Against team size × allowance |

Open it to everyone (`AGENT_AUDIENCE=everyone`) only when that list is quiet.

---

## 4. Decisions waiting on you

Things I have deliberately not chosen unilaterally.

| Decision | Why it is yours | Where it bites |
|---|---|---|
| Rotate the Resend key | It was shared in a transcript | §1.1 |
| Google sign-in for the beta, or email/password only | Testing-mode allowlisting is real friction and the 7-day refresh expiry affects Calendar | §1.3 |
| Whether the settings screen keeps per-browser storage or moves server-side | Plan currently adds tables and endpoints for it; that is schema you may not want yet | Phase 8 of the plan |
| When to reconnect CI | Everything but the repo connection is done and exercised | `BACKLOG.md` §1 |
| BuildCo Assistant: a warm voice instance, or an 8-second first connect | `--min-instances=1` on `buildco-agent` costs money every month | `AGENT_SPEC.md` Q1; §3.10 |
| BuildCo Assistant: instance caps during a rollout | Old and new revisions can each reach their cap, which overruns the connection budget on paper | `AGENT_SPEC.md` Q2; `apps/api/docs/DATABASE.md` |
| BuildCo Assistant: who is in the pilot, and when it opens to everyone | It is a list of people and a judgement about a week of real use | §3.10 |

---

## 5. Environment and config that must be set by hand

`gcloud run deploy` in the pipeline is called with `--image` only. Every other setting —
env vars, secret bindings, the Cloud SQL attachment, scaling — is preserved from the
existing service and is **not** described in `cloudbuild.yaml`. That keeps secret names
out of the repository, but it means changing a config value is a separate manual act and
editing `cloudbuild.yaml` will not do it.

| Setting | Where it lives | Notes |
|---|---|---|
| `RESEND_API_KEY` | Secret Manager `resend-key` | §1.1 |
| `NOTIFY_FROM_EMAIL` | Cloud Run env var | §1.1 |
| *(no new config)* | — | Phase 8 added two tables but no new environment variables or secrets. |
| `OPEN_AI_API_KEY` | Secret Manager | Note the spelling — **not** `OPENAI_API_KEY`. Unset means `POST /ai/parse-estimate` falls back to Groq, and 503s if that is unset too |
| `OPENAI_MODEL` | Cloud Run env var | Defaults to `gpt-4o-mini` |
| `GROQ_MODEL` / `GROQ_API_KEY` | Cloud Run env var / Secret Manager | **Fallback only, for one release.** Remove both once OpenAI is configured everywhere |
| `SITE_URL` | Secret Manager `site-url` | Reviewer links are built from it. Wrong value = links to the wrong host |
| `GCS_ATTACHMENTS_BUCKET` / `GCS_AVATARS_BUCKET` | Cloud Run env vars | Unset means download URLs come back `null` and uploads 503 |
| `AGENT_ENABLED`, `AGENT_AUDIENCE`, `AGENT_PILOT_EMAILS`, `AGENT_WS_BASE_URL` | `buildco-api` env vars | Unset means the assistant does not exist: no launcher for anyone. The pilot list fails closed |
| Everything on `buildco-agent` | A second Cloud Run service | `apps/api/docs/DEPLOY_CLOUD_RUN.md` §8b. It must carry the **same** email settings and secrets as `buildco-api`, and refuses to start without them |
| The team's daily allowance | Settings page, owners and admins | Not an environment variable, on purpose: **0 switches the assistant off at once**, live conversations included |

---

## 6. Local development notes

- **Restart the API after editing `apps/api/.env`.** Settings are read once at startup,
  so a running process keeps the old values — including the Resend key.
- Vite reads `.env.local` only at startup too. Restart `npm run dev` after changing it.
- `npm run preview` serves the built files with **no API proxy**, so every call 404s. Use
  the Firebase emulator to exercise a production build.
- The test suite runs on SQLite and needs no Docker. Run `make test-pg` before merging
  anything that touches the schema — SQLite does not enforce CHECK constraints the same
  way and treats JSON as text.

---

## 7. Change log for this file

Newest first. Each phase appends what it added and what it now needs from you.

### BuildCo Assistant, Release 1
- §3.10 added: what to do before the pilot, the walkthrough, and what to watch.
- §4 gained three decisions, §5 the assistant's settings.
- **Ships switched off.** With `AGENT_ENABLED` unset nothing changes for anyone and no
  second service is needed. The migration is additive.
- **Needs from you, when you want it on:** the `buildco-agent` service, the Vertex AI
  quota and budget alert, the pilot list, and the walkthrough, which includes the only
  two checks that prove the voice service can send email.
- **A hole in the test suite was closed along the way.** The tests could reach a real
  integration through a developer's `.env`, and did: a production Slack webhook in a
  local file received every test submission. `tests/conftest.py` now makes that
  impossible three ways over. Keep production secrets out of local `.env` files anyway:
  the dev server uses whatever is there.

### Phase 9 — the parity sweep
- §3.8 added; attachments moved to §3.9.
- **A contract change, and the reason for it.** `LineItem.category` and `.unit` were
  enums; they are now bounded strings. Phase 8 let a team define its own units and
  categories, and the enum meant they could be defined but never used — picking one was
  a 422 for the whole estimate. The same enum forced legacy `electrical`/`plumbing` rows
  to be rewritten to `other` on every save, silently destroying a classification
  someone had chosen. Recorded as deliberate change #13 in `apps/api/README.md`, with a
  test naming it.
- **No migration.** `rooms` is JSONB and always was; only the validation changed. So
  this needs no schema step, and no existing data moves.
- The estimates list now fetches once and filters in the browser, because the unread
  dots need to know what is in the *other* statuses. Capped at the API's own ceiling of
  200; beyond that both the list and the dots would be computed from a partial set.
- Everything else in the prototype inventory was already built. What remains open is
  infrastructure, not features: §1.1–§1.3 above and `BACKLOG.md` §12 (no end-to-end
  coverage) and §14 (attachments keyed by position).

### Phase 8 — team, profile and settings
- §3.7 added; attachments moved to §3.8.
- **This phase adds schema.** One Alembic revision creates `catalogue_items` and
  `team_settings`. It is purely additive — no changes to existing tables — so it is safe
  to apply before the code that reads them is deployed, which is what expand/contract
  asks for. Applied, reversed and re-applied against Postgres before committing.
- **Run `alembic upgrade head` as part of the release.** The API pipeline does this as a
  Cloud Run Job, so a normal `gcloud builds submit` covers it — but if you deploy the
  image any other way, the settings screen will 500 until the migration runs.
- No new environment variables or secrets.
- The notification toggles now genuinely gate mail. In the legacy app they lived in
  `localStorage` and gated nothing, because the emails are sent server-side and the
  browser was never consulted. §3.7 has the check that proves it.
- Access attempts by removed users are deliberately **not** switchable — that is a
  security signal, not a routine update.

### Phase 7 — calendar and meetings
- §3.6 added; attachments moved to §3.7.
- **A backend bug was found and fixed here.** `MeetingUpdate` is a partial, so unlike
  `MeetingCreate` its schema cannot check that the end is after the start — a `PATCH`
  carrying only `end_time` had nothing to compare against and stored a meeting that
  finished before it began, which renders as a negative duration and produces an ICS
  Outlook rejects. `meeting_service.update_meeting` now checks the resulting range.
- Writing that check surfaced a second hazard worth knowing about generally: **SQLite
  returns naive datetimes where Postgres returns aware ones**, so any comparison between
  a stored datetime and an incoming one crashes on one of the two. `_as_utc` normalises.
  The suite was run against both.
- Nothing new is required of you beyond §3.6.

### Phase 6 — closing forms
- §3.5 added; attachments moved to §3.6.
- **The print check is the one that needs a human.** Printing cannot be asserted in a
  test suite — the layout comes from an `@media print` block and only a real print
  preview shows whether it worked. Compare against a legacy printout.
- The legal wording lives in one place (`features/projects/closingForms.ts`) and is
  covered by tests that assert the exact sentences. If the client ever revises the
  terms, that file is the only thing to change — but treat it as a legal change, not a
  copy edit.
- The material photo is stored as an object key, not a base64 data URI. The legacy app
  inlined the image into the JSONB column, which bloated every project-detail read.

### Phase 5 — projects
- §3.4 added; attachments moved to §3.5.
- The project status derivation is now re-implemented in the frontend so the screen can
  **explain** a status rather than only display it. It is not trusted as a source of
  truth — the API still decides — and it is pinned against the Python engine's own
  output: `apps/api/scripts/export_project_rules_matrix.py` generates all 336 cases and
  the frontend suite asserts agreement on every one. **Regenerate that file whenever
  `project_rules.evaluate` changes**, or the two will drift silently.
- Nothing new is required of you, but §3.4's un-pay step is worth doing by hand: it is
  the behaviour that differs most from the legacy app.

### Phase 4 — notes parsing, dictation, PDF report
- §3.3 added; attachments moved to §3.4.
- `jspdf` and `html2canvas` are now real dependencies rather than CDN `<script>` tags
  injected on first click. Both are dynamically imported, so they load only when a
  report is opened — worth preserving, they are ~780 KB together.
- **jspdf 2.x was rejected**: it depends on a DOMPurify with a critical advisory.
  Pinned to `^4.2.1`, and `npm audit` reports 0 vulnerabilities.
- Nothing new is required of you here, but `GROQ_MODEL` is called out in §3.3 as the
  thing most likely to break parsing silently.

### Phase 3 — attachments
- §1.2 moves from "broken, unfixed" to "fixed in code, needs a release and
  **production verification** — it cannot be proven from a test suite, because it
  depends on credentials that only exist on Cloud Run".
- §3.3 filled in.
- `/livez` added; §2 and §5 now point uptime checks at it rather than `/healthz`.
- New known limitation, `BACKLOG.md` §14: attachments are keyed by *position*, so
  deleting or reordering a line item leaves its photos pointing at whatever takes that
  slot. Worth knowing before anyone relies on photo evidence for a claim.

### Phase 2 — the approval loop
- §1.1 added: Resend is configured locally but not in production.
- §3.2 added.
- `BACKLOG.md` §3 closed — `/review/:token` is routed.

### Phase 1 — the estimate editor
- §3.1 added.
