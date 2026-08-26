# Deploying the API to Cloud Run

Ordered so that each step can be verified before the next one depends on it. Set the
shared variables once and paste the rest as-is.

```bash
export PROJECT=your-gcp-project-id
export REGION=us-central1
export SERVICE=buildco-api
export INSTANCE=buildco-db
export CONN="$PROJECT:$REGION:$INSTANCE"

gcloud config set project "$PROJECT"
```

---

## 1. Enable the APIs

Do this first. Every later step fails with a permissions-shaped error if an API is off,
and that error never names the API as the cause.

```bash
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com
```

- [ ] APIs enabled

---

## 2. Cloud SQL

The provisioning commands are in [`DATABASE.md` §3](DATABASE.md#3-cloud-sql-migration).
After running them:

- [ ] Instance created with `POSTGRES_16`, backups on, PITR on
- [ ] `buildco` database created
- [ ] `buildco_app` user created, password generated and stored in Secret Manager
- [ ] `max_connections=50` flag set
- [ ] `--max-instances × (DB_POOL_SIZE + DB_MAX_OVERFLOW) < max_connections` still
      holds for the `--max-instances` you plan to deploy with (defaults: 5 per
      instance, so stay at or below 10)

---

## 3. Service account

A dedicated identity, not the Compute Engine default. The default account is shared by
every service in the project and is over-privileged by design.

```bash
gcloud iam service-accounts create buildco-api --display-name="BuildCo API"
export SA="buildco-api@$PROJECT.iam.gserviceaccount.com"

for role in roles/cloudsql.client \
            roles/secretmanager.secretAccessor \
            roles/storage.objectAdmin \
            roles/firebaseauth.admin \
            roles/iam.serviceAccountTokenCreator; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:$SA" --role="$role" --condition=None
done
```

Why each one:

| Role | Needed for |
|---|---|
| `cloudsql.client` | Connecting through the Cloud SQL connector |
| `secretmanager.secretAccessor` | Reading the injected secrets |
| `storage.objectAdmin` | Attachment and avatar objects |
| `firebaseauth.admin` | Verifying ID tokens via ADC — see step 5 |
| `serviceAccountTokenCreator` | **Signing GCS URLs.** Cloud Run's credentials carry no private key, so the client signs via the IAM `signBlob` API, which requires this role *on the service account itself*. This is the one that gets missed — and it fails quietly: `create_download_url` logs `storage_sign_failed` and returns `null`, so attachments render with no URL rather than erroring. Uploads do raise. |

- [ ] Service account created and all five roles bound

---

## 4. Secrets

```bash
printf '%s' "postgresql+asyncpg://buildco_app:PASSWORD@/buildco?host=/cloudsql/$CONN" \
  | gcloud secrets create database-url --data-file=-

printf '%s' "https://your-app.web.app" | gcloud secrets create site-url --data-file=-
printf '%s' "re_..."  | gcloud secrets create resend-key    --data-file=-
printf '%s' "https://hooks.slack.com/..." | gcloud secrets create slack-webhook --data-file=-
printf '%s' "gsk_..." | gcloud secrets create groq-key      --data-file=-
```

Two things that bite here:

- **`printf`, not `echo`.** `echo` appends a newline, and it becomes part of the secret
  value. A trailing `\n` on `DATABASE_URL` produces a connection error that looks
  nothing like a formatting problem.
- **The host is `@/buildco?host=/cloudsql/...`** — no hostname before the `/`. The
  Cloud SQL connector is a Unix socket, not a TCP endpoint.

The full variable → secret-name mapping is the table in
[`README.md` § Configuration](../README.md#configuration). Every integration credential
is optional; unset ones degrade to a logged no-op rather than blocking boot.

- [ ] `database-url` created, with no trailing newline
- [ ] `site-url` set to the real Firebase Hosting origin
- [ ] Remaining integration secrets created (or deliberately skipped)

---

## 5. Firebase credentials

**Do not ship the service-account JSON.** `secrets/firebase-admin.json` exists for local
development; it is gitignored and the Dockerfile never copies it. Keep it that way.

In Cloud Run, leave `FIREBASE_CREDENTIALS_FILE` unset and let the Admin SDK use
Application Default Credentials — that is what `roles/firebaseauth.admin` on the service
account is for. Set only:

```
FIREBASE_PROJECT_ID=your-firebase-project-id
```

The provider resolves Firebase → ADC → fake. **`ENVIRONMENT=production` is what makes
that chain safe:** `get_auth_provider()` re-raises instead of falling back, so a
misconfigured ADC fails the deploy loudly rather than accepting every token.

The corollary is the trap. At `ENVIRONMENT=staging` the same failure logs
`firebase_unavailable_using_fake` and serves happily with authentication disabled in all
but name. If you stand up a staging service, check its logs for that event before
pointing anything real at it.

- [ ] `FIREBASE_PROJECT_ID` set, `FIREBASE_CREDENTIALS_FILE` left unset
- [ ] No key file inside the image

---

## 6. Build and push

```bash
gcloud artifacts repositories create buildco --repository-format=docker --location="$REGION"

cd apps/api
gcloud builds submit --tag "$REGION-docker.pkg.dev/$PROJECT/buildco/$SERVICE:$(git rev-parse --short HEAD)"
```

Tag with the commit sha, not `latest` — it is what makes a rollback a one-line command
and lets you tell which revision is actually running.

- [ ] Image built and pushed with a sha tag

---

## 7. Migrate before deploying

Run migrations as a **Cloud Run Job**, not from a laptop or CI runner: the job gets the
same Cloud SQL connectivity and the same service account as the app, so it cannot
succeed in an environment the app then fails in.

```bash
export IMAGE="$REGION-docker.pkg.dev/$PROJECT/buildco/$SERVICE:$(git rev-parse --short HEAD)"

gcloud run jobs create buildco-migrate \
  --image="$IMAGE" --region="$REGION" --service-account="$SA" \
  --set-cloudsql-instances="$CONN" \
  --set-secrets=DATABASE_URL=database-url:latest \
  --command=alembic --args=upgrade,head

gcloud run jobs execute buildco-migrate --region="$REGION" --wait
```

`--wait` matters: without it the command returns immediately and you deploy against a
schema that may not exist yet.

> Before this runs against data, finish the two outstanding verification queries in
> [`DATABASE.md` § Outstanding](DATABASE.md#outstanding-two-queries-against-production).
> `0001` has not yet been checked against live **data**, only against the live column list.

- [ ] Job created and executed successfully
- [ ] Tables present (`gcloud sql connect`, then `\dt`)

---

## 8. Deploy

```bash
gcloud run deploy "$SERVICE" \
  --image="$IMAGE" \
  --region="$REGION" \
  --service-account="$SA" \
  --add-cloudsql-instances="$CONN" \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=10 \
  --cpu=1 --memory=512Mi \
  --timeout=300 \
  --set-env-vars="ENVIRONMENT=production,FIREBASE_PROJECT_ID=$PROJECT,GCS_ATTACHMENTS_BUCKET=$PROJECT-attachments,GCS_AVATARS_BUCKET=$PROJECT-avatars,CORS_ORIGINS=https://your-app.web.app" \
  --set-secrets="DATABASE_URL=database-url:latest,SITE_URL=site-url:latest,RESEND_API_KEY=resend-key:latest,SLACK_WEBHOOK_URL=slack-webhook:latest,GROQ_API_KEY=groq-key:latest"
```

- `--max-instances=10` is the connection budget, not an arbitrary cap. Raising it means
  revisiting §2.
- `ENVIRONMENT=production` makes `config.py` reject `AUTH_DISABLED` outright. Keep it.
- `--allow-unauthenticated` is correct here: the app does its own Firebase auth. IAM
  auth would block the browser.

- [ ] Deployed; revision serving

---

## 9. Verify

```bash
export URL=$(gcloud run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')

curl -sf "$URL/healthz"   # liveness: process is up
curl -sf "$URL/readyz"    # readiness: database actually reachable
curl -s  "$URL/api/v1/auth/status"
```

`/readyz` is the one that matters — it is what fails when `DATABASE_URL` has a trailing
newline or the Cloud SQL instance was not attached.

Then, with a real Firebase ID token:

```bash
curl -s -H "Authorization: Bearer $ID_TOKEN" "$URL/api/v1/users/me"
```

A `200` with your own profile proves ADC-based token verification works. A `200`
describing a user you are not means the Admin SDK fell through to the fake provider —
which at `ENVIRONMENT=production` should have been impossible, so check that the
variable is actually set on the revision.

- [ ] `/healthz` 200
- [ ] `/readyz` 200 — database reachable
- [ ] Real ID token returns the correct profile
- [ ] An attachment download URL resolves (proves `serviceAccountTokenCreator`)

---

## 10. Wire up the frontend

- [ ] Firebase Hosting rewrite (or the frontend's API base URL) points at `$URL`
- [ ] `CORS_ORIGINS` contains the exact Hosting origin, scheme included
- [ ] `SITE_URL` matches it — reviewer approval links are built from it and will 404
      against the wrong host

---

## Rollback

```bash
gcloud run revisions list --service="$SERVICE" --region="$REGION"
gcloud run services update-traffic "$SERVICE" --region="$REGION" --to-revisions=REVISION=100
```

Traffic rollback is instant, but it does **not** roll back the database. That is why
migrations must stay backward-compatible with the previously deployed revision — the
expand/contract discipline in [`DATABASE.md` § Migration discipline](DATABASE.md#migration-discipline).
