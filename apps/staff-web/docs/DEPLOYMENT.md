# Deploying staff-web to Firebase Hosting

Local development is [`README.md`](../README.md). This is the other half.

The headline: **the code does not change between environments, and neither does the API
URL.** The app calls `/api/v1/...` in both, and a rewrite rule decides what answers.

---

## What actually differs

| | Local | Production |
|---|---|---|
| Served by | Vite dev server, `:5173` | Firebase Hosting |
| `/api/v1/*` handled by | Vite proxy → `localhost:8000` | Hosting rewrite → Cloud Run |
| Request origin | Cross-origin (proxied) | **Same-origin** |
| CORS | Applies; backend must list `http://localhost:5173` | Does not apply at all |
| `VITE_API_BASE_URL` | Unset | Unset |
| `VITE_FIREBASE_*` | Same project | Same project |
| Backend `SITE_URL` | `http://localhost:5173` | The Hosting origin |

If you use one Firebase project for both, the frontend env is **identical** and there is
nothing to change at deploy time. A separate staging project means a second `.env` file
with that project's web config — and remember Vite inlines env vars at **build** time,
so each target needs its own build.

---

## One-time setup

**1. Install and sign in.**

```bash
npm install -g firebase-tools
firebase login
```

**2. Create `firebase.json` at the repo root** (`buildco/firebase.json`):

```jsonc
{
  "hosting": {
    "target": "staff",
    "public": "apps/staff-web/dist",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "rewrites": [
      {
        // Must come FIRST. Rewrites match in order, and the SPA catch-all below
        // would otherwise swallow every API call and return index.html — which
        // surfaces as "Unexpected token '<'" when the client tries to parse HTML
        // as JSON, and points nowhere near the actual cause.
        "source": "/api/**",
        "run": { "serviceId": "buildco-api", "region": "us-central1" }
      },
      {
        // SPA fallback: deep links like /estimates/abc-123 are client-side routes
        // with no file behind them. Without this they 404 on refresh.
        "source": "**",
        "destination": "/index.html"
      }
    ],
    "headers": [
      {
        // Hashed filenames, so they can be cached indefinitely.
        "source": "/assets/**",
        "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }]
      },
      {
        // index.html must NOT be cached, or a deploy leaves browsers loading the
        // old document that references asset filenames no longer being served.
        "source": "/index.html",
        "headers": [{ "key": "Cache-Control", "value": "no-cache" }]
      }
    ]
  }
}
```

**3. Point the hosting target at a site.**

```bash
firebase use buildco-production-505918
firebase target:apply hosting staff buildco-production-505918
```

**4. Authorize the domain for sign-in.**

Firebase console → **Authentication → Settings → Authorized domains** → add
`your-site.web.app` and any custom domain.

`FIREBASE_SETUP.md` §2 records that no production frontend domain has been authorised
yet, because until now there was no frontend. This is that step. Skipping it means
sign-in fails in production while working perfectly locally, with an error that never
mentions domains.

**5. Point the backend at the frontend.**

`SITE_URL` on the API must be the Hosting origin, because external reviewer links are
built from it (`{SITE_URL}/review/{token}`). Get it wrong and every emailed approval
link 404s — and you will not find out until a reviewer tries one.

```bash
printf '%s' "https://your-site.web.app" | gcloud secrets versions add site-url --data-file=-
gcloud run services update buildco-api --region=us-central1 \
  --update-secrets=SITE_URL=site-url:latest
```

---

## Rehearse before deploying

`npm run preview` is **not** a rehearsal — it has no rewrite, so every API call 404s.
Use the emulator, which applies the real `firebase.json`:

```bash
cd apps/staff-web && npm run build && cd ../..
firebase emulators:start --only hosting
```

Then confirm, at the emulator's URL:

- [ ] A deep link like `/estimates` loads on a **hard refresh** — proves the SPA fallback
- [ ] `/nonsense-path` renders the app's own not-found page, not Firebase's
- [ ] `/api/v1/...` reaches a backend rather than returning HTML

The emulator will not reach a real Cloud Run service unless one is deployed; the point
of the third check is that the rewrite ordering is right.

---

## Deploy

```bash
cd apps/staff-web
npm run build          # typechecks first; a type error stops the deploy here
cd ../..
firebase deploy --only hosting:staff
```

Then verify against the live URL:

- [ ] Sign in with email/password
- [ ] Sign in with Google. It asks for **no** Calendar access
- [ ] Create a meeting with **Add a Google Meet link** ticked. Google's Calendar
      permission popup appears at that tick, and the invite email carries the link. A
      popup that fails with an origin error means this domain is missing from the OAuth
      client's Authorised JavaScript origins
- [ ] Hard-refresh on a deep link
- [ ] Create an estimate, reload, confirm it persisted
- [ ] Submit one for review and open the emailed link in a private window

That last one is the end-to-end check that `SITE_URL` is right.

---

## Rollback

```bash
firebase hosting:versions:list --site your-site
firebase hosting:rollback
```

Hosting keeps previous versions, so rollback is immediate and needs no rebuild.

**It does not roll back the API or the database.** If a frontend release depended on a
backend change, rolling back only this half leaves them disagreeing. Cloud Run has its
own traffic rollback — see
[`apps/api/docs/DEPLOY_CLOUD_RUN.md`](../../api/docs/DEPLOY_CLOUD_RUN.md).

---

## CI

Deploying from CI needs a service account with the **Firebase Hosting Admin** role:

```bash
firebase init hosting:github
```

which provisions the account, stores its key as a repo secret, and writes the workflow.
Build and deploy are the same two commands as above; add `npm run test` and
`npm run typecheck` ahead of them so a broken build never reaches Hosting.
