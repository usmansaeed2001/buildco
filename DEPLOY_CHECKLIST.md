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
      drywall at 2.50", parse, and confirm the preview shows a Kitchen room
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

> `GROQ_MODEL` is the thing most likely to break this without warning. Groq retires
> hosted models without aliasing the old id forward, and a retired id fails **every**
> call with a 400 saying only that the model does not exist. Currently
> `openai/gpt-oss-120b`. If parsing suddenly stops working everywhere, check this first.

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
- [ ] Sign in as a **member**: they see the whole shared calendar but cannot create,
      edit or cancel

> **Google Meet links need §1.3.** Without a Google sign-in carrying the
> `calendar.events` scope, meetings are created with no Meet link — which is normal, not
> a failure, and the form says so. In Testing mode the refresh token expires after
> **7 days**, so this will stop working periodically until the OAuth app is verified.

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

### 3.8 Attachments *(needs §1.2 released first)*

- [ ] Upload a photo to a line item; the thumbnail appears
- [ ] Reload; the thumbnail still resolves — this is the part §1.2 breaks silently
- [ ] Upload a video; it opens and plays
- [ ] Delete an attachment; it disappears and stays gone after a reload
- [ ] Drag a file onto the drop zone rather than using the picker

---

## 4. Decisions waiting on you

Things I have deliberately not chosen unilaterally.

| Decision | Why it is yours | Where it bites |
|---|---|---|
| Rotate the Resend key | It was shared in a transcript | §1.1 |
| Google sign-in for the beta, or email/password only | Testing-mode allowlisting is real friction and the 7-day refresh expiry affects Calendar | §1.3 |
| Whether the settings screen keeps per-browser storage or moves server-side | Plan currently adds tables and endpoints for it; that is schema you may not want yet | Phase 8 of the plan |
| When to reconnect CI | Everything but the repo connection is done and exercised | `BACKLOG.md` §1 |

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
| `GROQ_MODEL` | Cloud Run env var | Groq retires hosted models without aliasing the old id forward. A retired id fails every call with a 400 saying only that the model does not exist. Currently `openai/gpt-oss-120b` |
| `SITE_URL` | Secret Manager `site-url` | Reviewer links are built from it. Wrong value = links to the wrong host |
| `GCS_ATTACHMENTS_BUCKET` / `GCS_AVATARS_BUCKET` | Cloud Run env vars | Unset means download URLs come back `null` and uploads 503 |

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
