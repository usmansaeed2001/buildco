# Releasing to production

**A merge to `main` deploys nothing.** A release is a separate act: GitHub → Actions →
**Release** → Run workflow. `main` being green means the code is ready to ship; a tag
means it has.

---

## What a release actually is

One workflow, [`.github/workflows/release.yml`](.github/workflows/release.yml), in four
steps:

```
prepare ──► deploy-api ──► deploy-web ──► publish
```

| Step | What it does |
|---|---|
| `prepare` | Refuses unless it is on `main` and CI passed on that commit. Reads the last `vX.Y.Z` tag, works out the next version, and looks at what changed since. |
| `deploy-api` | Only if `apps/api` changed. Submits `apps/api/cloudbuild.yaml`, then checks `/readyz` and the version on both Cloud Run services. |
| `deploy-web` | Only if `apps/staff-web`, `firebase.json` or `.firebaserc` changed, and only after the API. Submits `apps/staff-web/cloudbuild.yaml`, then checks the site. |
| `publish` | Only if everything above passed. Tags the commit and writes the release notes. |

The deploys themselves are the two `cloudbuild.yaml` files, submitted with `gcloud
builds submit --config=…` exactly as they were when releases were run from a laptop. The
workflow decides when, in what order and with which version; it does not contain a
second copy of how to deploy. That is also why releasing by hand, further down, is still
the same release.

Both pipelines gate before they ship:

```
API   ruff -> mypy -> pytest -> docker build -> push -> migrate (Cloud Run Job) -> deploy
WEB   npm ci -> vitest -> vite build (tsc -b gates it) -> firebase deploy
```

A failure at any step stops the ones after it. A red suite or a failed migration cannot
reach a serving revision.

---

## Before you release

Work through [`DEPLOY_CHECKLIST.md`](DEPLOY_CHECKLIST.md) §1 and §2 first. It carries
the blockers that make a feature look fine in the UI and fail silently for real users —
the Resend sender being the current one.

```bash
git fetch --tags origin
git log --oneline $(git tag -l 'v*' --sort=-v:refname | head -1)..origin/main   # what is about to ship
```

- [ ] Everything meant to ship is merged into `main`, and nothing that is not
- [ ] CI is green on the latest commit of `main`
- [ ] Any new migration is backward-compatible with the currently deployed revision
      (expand/contract — `apps/api/DEVELOPMENT_GUIDELINES.md` §8)

**A release takes all of `main`.** There is no way to ship one pull request and hold
back another that merged before it. If something on `main` is not ready, revert it
first.

---

## Run the release

GitHub → Actions → **Release** → Run workflow, with the branch left on `main`.

| Field | What to enter |
|---|---|
| `bump` | `patch` for fixes and internal changes. `minor` for something new staff can see, or any database migration. `major` is reserved for `1.0.0`. |
| `summary` | Optional. What shipped, in a few words. It becomes the tag message and the first line of the release notes. |
| `force_all` | Leave off. Ticked, it deploys both apps even if one has not changed. |
| `dry_run` | Leave off. Ticked, it works out the version, proves the sign-in to Google Cloud, and stops. |

An API release takes roughly 6–10 minutes and a web release 2–3. The run page shows
the version it chose and which apps it is deploying before anything is touched.

In the `deploy-api` log, the Cloud Build steps to watch are:

- `check` — ruff, mypy, pytest. Fails here means nothing was released
- `migrate` — runs `alembic upgrade head` as a Cloud Run Job with the app's own service
  account and Cloud SQL attachment, so it cannot succeed somewhere the app then fails
- `deploy` and `deploy-agent` — roll the two Cloud Run services

When it finishes, the tag `vX.Y.Z` and a GitHub Release exist, and:

- [ ] Hard-refresh <https://supplements.buildcogrp.com> — the address staff actually
      use. Settings shows the new version at the foot of the page
- [ ] If the API was released, someone on the pilot list presses Start in BuildCo
      Assistant and hears it answer. The workflow cannot check this one; see below
- [ ] Anything in [`DEPLOY_CHECKLIST.md`](DEPLOY_CHECKLIST.md) §3 that the release
      touched

### What the workflow has already checked

It does not tag until all of these pass, so there is no need to repeat them by hand:

- `/readyz` on `buildco-api` and on `buildco-agent` — the database is reachable from each
- `/livez` on both reports the version just built — the new image is the one serving
- The site's `index.html` carries the new version — the new bundle is the one served
- `/api/v1/auth/status` returns JSON through the site — the Hosting rewrite still reaches
  Cloud Run

The first two are made against the Cloud Run addresses, never the site. `/readyz` and
`/livez` sit outside `/api/**`, so Hosting does not rewrite them — the SPA catch-all
serves `index.html` and you get `200 text/html` whatever state the API is in. A check
aimed there passes whether the database is reachable or not, which is worse than not
checking at all.

`/healthz` will always 404 — Cloud Run's front end reserves that exact path and the
request never reaches the container. See [`BACKLOG.md`](BACKLOG.md) §6.

### When a step fails

**Nothing is tagged**, so the version number is not used up. Read the failed job's log,
then:

- **A check or a build failed.** Nothing was deployed. Fix it with a pull request and
  run the workflow again from the new commit.
- **It failed for a reason outside the code** — a timeout, a Google Cloud hiccup. Use
  **Re-run failed jobs** on the same run. It keeps the version already chosen and skips
  what already passed.
- **The API deployed and the web app did not.** Production is running the new API with
  the old pages, which the backward-compatibility rule for migrations is there to make
  safe. Re-run the failed job, or fix forward. Until `publish` runs, the API reports a
  version that has no tag.
- **A smoke check failed after a deploy.** The new revision is serving and is suspect.
  Roll back first ([Rolling back](#rolling-back)), then find out why.

A second run started while one is in progress waits for it to finish, and only then
works out its version. Two releases cannot overlap.

---

## The voice service, `buildco-agent`

BuildCo Assistant's voice connection is served by a second Cloud Run service running the
API's image. **The API release rolls it too** — the `deploy-agent` step in
`apps/api/cloudbuild.yaml` deploys the same image to `buildco-agent`, so there is no
separate command. Creating the service is one-time work, in
[`apps/api/docs/DEPLOY_CLOUD_RUN.md`](apps/api/docs/DEPLOY_CLOUD_RUN.md) §8b.

That step skips itself when it cannot find the service, and it cannot tell "does not
exist" from "not allowed to look" — so a skip is a fault, not a pass. The workflow
catches it: a skipped voice service is still on the old image, reports the old version,
and fails the release.

What the workflow cannot do is press Start:

- [ ] Someone on the pilot list presses Start and hears it answer

That check is not optional. `/readyz` proves the process and the database; it says
nothing about whether a browser is let in.

### `CORS_ORIGINS` on `buildco-agent` must list every address staff use

Today that is two: `https://supplements.buildcogrp.com` and
`https://buildco-production-505918.web.app`.

On `buildco-api` this variable is never tested, because the browser reaches the API
through the site's own address. The voice connection goes straight to `buildco-agent`,
which compares the page's address against its own list and refuses anything else. Copying
the API's value — which names only the `web.app` address — is exactly how the first
production deploy went wrong.

The symptom is the panel saying **"Conversation ended. The connection was lost."** the
moment Start is pressed, with nothing wrong anywhere else. The service logs a `403` on
`/api/v1/agent/live` and no reason:

```bash
gcloud logging read \
  'resource.labels.service_name="buildco-agent" AND httpRequest.status=403' \
  --project=buildco-production-505918 --freshness=1h --limit=5
```

The fix is the variable, not a release. The value contains a comma and so does the flag,
so `^##^` tells gcloud to split on `##` instead:

```bash
gcloud run services update buildco-agent --region=us-central1 \
  --project=buildco-production-505918 \
  "--update-env-vars=^##^CORS_ORIGINS=https://supplements.buildcogrp.com,https://buildco-production-505918.web.app"
```

A new address for the app — another custom domain, say — has to be added here as well as
to Firebase Hosting.

### Its settings are its own

Changing a variable on `buildco-api` changes nothing on `buildco-agent`, and the reverse.
Email settings and secrets must match between the two; the voice service refuses to start
without them.

Who gets the assistant is decided on `buildco-api` alone:

```bash
gcloud run services update buildco-api --region=us-central1 \
  --project=buildco-production-505918 \
  "--update-env-vars=^##^AGENT_PILOT_EMAILS=first@example.com,second@example.com"
```

**The off switch is not a deploy.** An owner sets the daily allowance to 0 in Settings,
which ends live conversations within seconds.

---

## Releasing by hand

For when GitHub Actions is unavailable, or the workflow itself is what is broken. It is
the same release: the same two configs, submitted from a laptop instead.

**The build uploads your working directory, not the branch.** Uncommitted local edits
WILL ship. This is the single easiest way to deploy something that exists on no branch
at all, and it is the main thing the workflow protects against.

```bash
git switch main && git pull
git status --porcelain                # must be empty
git rev-parse HEAD origin/main        # must match

git tag -l 'v*' --sort=-v:refname | head -1      # the last version released
```

Decide the next version from that, and use the same number for every command below.
Release only what changed — the two apps are independent.

### The API

```bash
cd "path/to/buildco"
gcloud builds submit \
  --project=buildco-production-505918 \
  --config=apps/api/cloudbuild.yaml \
  --substitutions=SHORT_SHA=$(git rev-parse --short HEAD),_VERSION=X.Y.Z \
  .
```

`SHORT_SHA` must be passed explicitly. It is a built-in that Cloud Build populates only
for trigger-driven builds; a manual submit leaves it empty, which would tag the image
`:` and fail. Passing the real sha is also what keeps rollback to one command.

`_VERSION` is the number without the `v`. Left out, the build still succeeds but the
service reports `0.0.0.dev0`, and nobody can tell from outside which release is running.

Then make the checks the workflow would have made:

```bash
for SERVICE in buildco-api buildco-agent; do
  URL=$(gcloud run services describe $SERVICE --region=us-central1 \
    --project=buildco-production-505918 --format='value(status.url)')
  curl -sf "$URL/readyz"; echo        # {"status":"ready","database":"up"}
  curl -sf "$URL/livez";  echo        # "version" must be the one you passed
done

curl -s "https://supplements.buildcogrp.com/api/v1/auth/status?email=you@example.com"
```

The last one goes through the site *because* it is under `/api/**`, so a JSON response
proves the rewrite still reaches Cloud Run.

### The frontend

```bash
gcloud builds submit \
  --project=buildco-production-505918 \
  --config=apps/staff-web/cloudbuild.yaml \
  --substitutions=_VERSION=X.Y.Z \
  .
```

Then hard-refresh <https://supplements.buildcogrp.com> and confirm Settings shows the
version. <https://buildco-production-505918.web.app> serves the same release.

### Tag it

```bash
git tag -a vX.Y.Z -m "What shipped, in a few words"
git push origin vX.Y.Z
gh release create vX.Y.Z --verify-tag --generate-notes
```

Fill in both the version and the message. An earlier form of this example carried a real
version number and was once pasted as it stood, which left a tag on the wrong commit.

Do not skip it. The workflow counts up from the newest tag, so a hand-run release that
is never tagged gives the next one the same number.

---

## Rolling back

Traffic rollback is instant and does not rebuild anything:

```bash
gcloud run revisions list --service=buildco-api --region=us-central1 \
  --project=buildco-production-505918
gcloud run services update-traffic buildco-api --region=us-central1 \
  --project=buildco-production-505918 --to-revisions=REVISION_NAME=100
```

**Roll `buildco-agent` back with it**, to the revision running the same image. The API
issues the tickets the voice service redeems, and the two must agree about what a
proposal is. The same two commands, with `--service=buildco-agent` and `buildco-agent`.

**It does not roll back the database.** That is the whole reason migrations must stay
backward-compatible with the previously deployed revision. Rolling code back onto a
migrated schema only works if the old code can still run against it.

Frontend rollback is through the Firebase console → Hosting → release history → Rollback.

A rollback moves traffic; it does not move the tag. The GitHub Release list still shows
the version that was rolled back as the latest, so say so in that release's notes, and
follow with a patch release that either fixes or reverts.

To send traffic back to the newest revision afterwards:

```bash
gcloud run services update-traffic buildco-api --region=us-central1 \
  --project=buildco-production-505918 --to-latest
```

Until that is done, a new release builds a revision that receives no traffic, and the
workflow's version check fails — correctly.

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

## How the workflow signs in to Google Cloud

There is no key. Nothing is stored in GitHub's secrets, and there is nothing to rotate.

GitHub gives every workflow run a short-lived token that says which repository and
branch it is running for. Google Cloud is set up to accept that token, from one place
only, in exchange for a short-lived credential of its own.

| Piece | Name | What it does |
|---|---|---|
| Identity pool | `github` | Trusts tokens issued by GitHub Actions |
| Provider | `github-oidc` | Accepts a token only if it is for this repository **and** for `refs/heads/main` |
| Service account | `github-release@buildco-production-505918.iam.gserviceaccount.com` | What the workflow acts as. Reachable only through the pool |

The service account can submit a build, upload its source to the Cloud Build staging
bucket, read the build's log, and read the two Cloud Run services' addresses. It cannot
deploy anything itself. The builds run as the same account, with the same roles, as when
they were submitted by hand.

Two things would break the sign-in, and both are deliberate:

- **Running the workflow from any branch but `main`.** The provider refuses the token.
- **Recreating the repository** — a fresh copy pushed somewhere, rather than a rename
  or a transfer. The provider names the repository by GitHub's numeric id
  (`1320458042`), which survives both of those but belongs to this repository alone. The
  id appears in two places, and both would need the new one: the provider's condition,
  and the binding that lets the pool act as the service account.

  ```bash
  gcloud iam workload-identity-pools providers describe github-oidc \
    --project=buildco-production-505918 --location=global \
    --workload-identity-pool=github --format='value(attributeCondition)'

  gcloud iam service-accounts get-iam-policy \
    github-release@buildco-production-505918.iam.gserviceaccount.com \
    --project=buildco-production-505918
  ```

A workflow on a pull request or a feature branch cannot reach Google Cloud at all. That
is why [`ci.yml`](.github/workflows/ci.yml) needs no credentials: it only runs checks.
