# Releasing to production — manual procedure

**Automatic deployment on merge is not available.** The GitHub repository lives under the
client's account, so it cannot be connected to Cloud Build in the interim project. Until
that changes (see [`BACKLOG.md`](BACKLOG.md) §1), **a merge to `production` deploys
nothing** — someone has to run the release.

The important consequence: `production` being green is no longer the same as production
*running* that code. The branch is the intent; a release is the act.

---

## What a release actually is

The same pipeline that would have run automatically, triggered by hand. `cloudbuild.yaml`
lives in the repo for both apps and is run with `gcloud builds submit --config=…`.

That matters more than it sounds. The alternative — a hand-typed sequence of `docker
build`, `gcloud run deploy` — is a second procedure that drifts from the first, and the
drift is only discovered on the day CI is finally connected. Running the real config keeps
one definition of "deploy", so switching to triggers later changes *who* pushes the
button and nothing else.

Both pipelines gate before they ship:

```
API   ruff -> mypy -> pytest -> docker build -> push -> migrate (Cloud Run Job) -> deploy
WEB   npm ci -> vitest -> vite build (tsc -b gates it) -> firebase deploy
```

A failure at any step stops the ones after it. A red suite or a failed migration cannot
reach a serving revision.

---

## Before you release

```bash
git switch production && git pull
git log --oneline origin/production..origin/development   # what is about to ship
```

- [ ] `development` merged into `production` and pushed
- [ ] You are on `production` with a clean tree — **the build uploads your working
      directory, not the branch.** Uncommitted local edits WILL ship. This is the single
      easiest way to deploy something that exists on no branch at all
- [ ] Any new migration is backward-compatible with the currently deployed revision
      (expand/contract — `apps/api/DEVELOPMENT_GUIDELINES.md` §8)

Confirm the tree is clean and matches the remote:

```bash
git status --porcelain                      # must be empty
git rev-parse HEAD origin/production        # must match
```

---

## Release the API

```bash
cd "path/to/buildco"
gcloud builds submit \
  --project=buildco-production-505918 \
  --config=apps/api/cloudbuild.yaml \
  --substitutions=SHORT_SHA=$(git rev-parse --short HEAD) \
  .
```

`SHORT_SHA` must be passed explicitly. It is a built-in that Cloud Build populates only
for trigger-driven builds; a manual submit leaves it empty, which would tag the image
`:` and fail. Passing the real sha is also what keeps rollback to one command.

Takes roughly 6–10 minutes. Watch for:

- `check` — ruff, mypy, pytest. Fails here means do not release
- `migrate` — runs `alembic upgrade head` as a Cloud Run Job with the app's own service
  account and Cloud SQL attachment, so it cannot succeed somewhere the app then fails
- `deploy` — prints the service URL on success

Then verify:

```bash
curl -sf https://buildco-production-505918.web.app/readyz
curl -s  https://buildco-production-505918.web.app/api/v1/auth/status?email=you@example.com
```

`/readyz` is the one that matters — it actually touches the database. (`/healthz` will
always 404: Cloud Run's front end reserves that path. See `BACKLOG.md`.)

## Release the frontend

```bash
gcloud builds submit \
  --project=buildco-production-505918 \
  --config=apps/staff-web/cloudbuild.yaml \
  .
```

No substitutions needed. Takes roughly 2–3 minutes. Then hard-refresh
<https://buildco-production-505918.web.app> and confirm the change is live.

**Release only what changed.** The two are independent — an API-only change does not need
a frontend release, and vice versa.

---

## Tag the release

```bash
git tag -a v0.3.0 -m "Short description of what shipped"
git push origin v0.3.0
```

Tagging is what makes "roll back to what we had on Tuesday" one command instead of an
archaeology exercise. It matters more without CI, not less: with no build history tied to
commits, the tag is the only durable record of what was released and when.

---

## Rolling back

Traffic rollback is instant and does not rebuild anything:

```bash
gcloud run revisions list --service=buildco-api --region=us-central1 \
  --project=buildco-production-505918
gcloud run services update-traffic buildco-api --region=us-central1 \
  --project=buildco-production-505918 --to-revisions=REVISION_NAME=100
```

**It does not roll back the database.** That is the whole reason migrations must stay
backward-compatible with the previously deployed revision. Rolling code back onto a
migrated schema only works if the old code can still run against it.

Frontend rollback is through the Firebase console → Hosting → release history → Rollback.

---

## What is NOT in the pipeline

`gcloud run deploy` is called with only `--image`. Every other setting — environment
variables, secret bindings, the Cloud SQL attachment, scaling, `--no-cpu-throttling` — is
preserved from the existing service and is **not** described in `cloudbuild.yaml`.

That is deliberate: it keeps secret names out of the repository. But it means changing a
config value is a separate manual act, and editing `cloudbuild.yaml` will not do it:

```bash
gcloud run services update buildco-api --region=us-central1 \
  --project=buildco-production-505918 \
  --update-env-vars=KEY=value
```

The full deploy command, with every flag and why each one is there, is in
[`apps/api/docs/DEPLOY_CLOUD_RUN.md`](apps/api/docs/DEPLOY_CLOUD_RUN.md) §8. Infrastructure
provisioning (Cloud SQL, buckets, secrets, IAM) is the rest of that document and is
one-time work already done.

---

## When CI becomes possible

Connecting the repository is the only missing piece — the configs, the IAM grants and the
service account are already in place and have all been exercised. Both pipelines were run
end to end through Cloud Build before this document was written.

Create two triggers, both on branch `^production$`:

| | API trigger | Web trigger |
|---|---|---|
| Config | `apps/api/cloudbuild.yaml` | `apps/staff-web/cloudbuild.yaml` |
| Included files | `apps/api/**` | `apps/staff-web/**`, `firebase.json`, `.firebaserc` |

The included-files filter is what keeps a backend commit from rebuilding the frontend.
`SHORT_SHA` then populates itself and the `--substitutions` flag above becomes unnecessary.

Everything else in this document stays true, minus the part where a human runs it.
