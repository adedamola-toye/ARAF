# Staging: the pre-live test environment

Staging is a full, production-shaped copy of the app used to test changes and get bank sign-off
before anything reaches live users. It mirrors production's topology but runs on **its own**
Supabase project, bucket, keys and Vercel/Render services. Nothing is shared with production.

For the live deployment, see [DEPLOYMENT.md](DEPLOYMENT.md). This page covers the environment that
comes first.

## Isolation rules (read before creating anything)

| Rule | Why |
|---|---|
| Separate Supabase project and bucket | A reset, migration or test upload in staging must never touch live data or documents. |
| Fresh `FIELD_ENCRYPTION_KEY`, `APP_HMAC_KEY`, `STORAGE_ENCRYPTION_KEY` | Staging sessions, OTPs and document links must not be replayable against production, and staging must not decrypt production files. |
| Never copy production data into staging | Customer BVN/TIN and real cases do not belong in a test environment. Seed synthetic data instead. |
| Separate Resend key and sender | Test mail must not appear to come from the live app, and a staging mistake must not burn the production sending reputation. |
| Separate Vercel project | Prevents staging variables, domains or deploys from leaking into the production project. |
| `APP_ENV=production` | Keeps the production guards (no dev keys, no dev storage, no dev scanner) active, so staging tests the same code paths as live. |

Staging deliberately keeps `APP_ENV=production`. It is *not* a development environment; local
development with synthetic data is described in [LOCAL_SETUP.md](LOCAL_SETUP.md).

## Topology

| Piece | Staging host | Notes |
|---|---|---|
| Web app and API | Vercel project `araf-staging` | Deploys the `staging` branch |
| Background worker | Render `araf-worker-staging` | Blueprint file [`render.staging.yaml`](../render.staging.yaml) |
| PostgreSQL | Supabase project `araf-staging` | Separate database |
| Object storage | Supabase Storage bucket `araf-documents-staging` | Private bucket |
| Email | Resend | Staging key and sender |

## 1. Branch model

Use two long-lived branches:

```
staging     -> deploys to the staging environment
araf-retail-asset-factory -> deploys to production (the current deploy branch)
```

Create `staging` from the production deploy branch, merge feature work into `staging` first, run the
checklist below, then merge `staging` (or a reviewed PR) into the production branch. Keep both
branches building from the same code; never apply manual dashboard-only fixes to staging only.

## 2. Supabase staging project

1. Create a **new** Supabase project named `araf-staging`. Do not reuse the production project.
2. From **Project Settings → Database**, copy:
   - **Session pooler** (port `5432`) for the Render worker and one-off migrations.
   - **Transaction pooler** (port `6543`) for the Vercel web app.
   - Append `?uselibpqcompat=true&sslmode=require` and URL-encode special characters in the
     password, as described in [DEPLOYMENT.md](DEPLOYMENT.md#database).
3. Create a **private** bucket named `araf-documents-staging`. Generate S3 access keys under
   **Storage → S3 Configuration → Access keys**.
4. Note the S3 endpoint, region and bucket values; they go into both Vercel and Render.

## 3. Staging secrets

Generate new values (never copy production secrets):

```bash
openssl rand -base64 32   # FIELD_ENCRYPTION_KEY
openssl rand -base64 32   # APP_HMAC_KEY
openssl rand -base64 32   # STORAGE_ENCRYPTION_KEY
```

Store them in the bank's secret manager under a `staging` entry. The three values must be identical
on the staging Vercel project and the staging Render worker, and different from production.

## 4. Resend for staging

Pick one of these, in order of preference:

1. **Dedicated staging subdomain** — verify `staging.araf.ng` in Resend and send from
   `ARAF Retail Asset Factory (Staging) <noreply@staging.araf.ng>`. This keeps staging mail fully
   separate from live mail.
2. **Separate key on the verified domain** — create a Resend key named `araf-staging` and use
   `MAIL_FROM="ARAF Retail Asset Factory (Staging) <noreply@araf.ng>"`. The staging risk is limited
   to the staging key.
3. **Resend test sender** — `onboarding@resend.dev` only delivers to the Resend account owner. Use
   this before any domain is verified, accepting that sign-in codes only reach that one inbox.

Use testers' real inboxes for OTPs during sign-off; do not send staging traffic to the whole bank.
See [EMAIL.md](EMAIL.md) for DNS and verification details.

## 5. Vercel staging project

1. Create a **new** Vercel project `araf-staging` from the same repository.
2. Set **Production Branch** to `staging`.
3. Add these under **Settings → Environment Variables** (Production scope of this project):

| Variable | Staging value |
|---|---|
| `APP_ENV` | `production` |
| `APP_URL` | `https://<araf-staging-domain>` |
| `DATABASE_URL` | Supabase **transaction pooler** (port `6543`) |
| `STORAGE_DRIVER` | `s3` |
| `S3_BUCKET` | `araf-documents-staging` |
| `S3_REGION`, `S3_ENDPOINT` | From the staging Supabase project |
| `S3_FORCE_PATH_STYLE` | `true` |
| `S3_SERVER_SIDE_ENCRYPTION` | `none` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Staging Supabase S3 keys |
| `SCANNER_DRIVER` | `none` |
| `MAIL_DRIVER` | `resend` |
| `RESEND_API_KEY` | Staging Resend key |
| `MAIL_FROM` | Staging sender from section 4 |
| `FIELD_ENCRYPTION_KEY`, `APP_HMAC_KEY`, `STORAGE_ENCRYPTION_KEY` | Fresh staging values |
| `COOKIE_SECURE` | `true` |
| `TRUSTED_PROXY_HOPS` | `1` |
| `MAX_UPLOAD_BYTES` | `4194304` |
| `OFFER_PDF_CONVERTER` | `none` |

4. Deploy the `staging` branch and confirm the build succeeds.

## 6. Render staging worker

1. In Render, create a Blueprint from the same repository.
2. Set **Branch** to `staging` and **Blueprint Path** to `render.staging.yaml`.
3. Render creates `araf-worker-staging`. Fill every `sync: false` variable in the dashboard using
   the staging values above, with these differences:
   - `DATABASE_URL`: Supabase **session pooler** (port `5432`).
   - `APP_URL`: the staging Vercel URL.
4. Deploy. The pre-deploy command runs `npm run migrate` against the staging database.

## 7. Migrate and seed the staging database (one time)

Create a local, gitignored `.env.staging` from the template:

```bash
cp .env.staging.example .env.staging
```

Fill in the database password, pooler host, generated keys, Resend key and S3 keys. Then apply the
schema from your laptop:

```bash
ENV_FILE=.env.staging npm run migrate
```

`ENV_FILE` tells the CLI scripts which env file to load; the default remains `.env`, so local
development is unchanged.

Then seed once. `npm run seed` refuses to run when `APP_ENV=production`, so override it to
`development` for this one command:

```bash
APP_ENV=development ENV_FILE=.env.staging npm run seed -- --with-demo
```

Before pressing Enter, confirm the host in `DATABASE_URL` contains the staging project reference and
`S3_BUCKET` is `araf-documents-staging`. `--with-demo` loads synthetic staff and cases; use it in
staging so testers have a full workflow to click through.

Direct connections (`db.<ref>.supabase.co`) are IPv6-only and commonly fail with
`ENOTFOUND`/`ECONNABORTED`. If migration fails, switch `DATABASE_URL` to the **session pooler** URL
from Supabase → Connect (IPv4, port `5432`).

Never run `npm run db:reset` against staging unless you intend to wipe it and reseed.

Run the readiness check at any time (database, S3, mail settings and key lengths):

```bash
ENV_FILE=.env.staging npm run doctor
```

## 8. Connection troubleshooting

Supabase exposes three different database hosts. Using the wrong one is the most common staging
failure:

| Host | Port | Reachable from | Use for |
|---|---|---|---|
| `db.<ref>.supabase.co` | `5432` | IPv6 only (or IPv4 add-on) | Direct connections only |
| `aws-<index>-<region>.pooler.supabase.com` | `5432` | IPv4 | Render worker, laptop migrations (session mode) |
| `aws-<index>-<region>.pooler.supabase.com` | `6543` | IPv4 | Vercel (transaction mode) |

The pooler index and region cannot be derived; copy the exact string from **Supabase → Connect**.

| Symptom | Cause | Fix |
|---|---|---|
| `ENETUNREACH 2a05:...:5432` in Render/Vercel logs | `DATABASE_URL` is the direct IPv6 host, or the IPv4 address of a direct host | Use the shared pooler URL (session `5432` on Render, transaction `6543` on Vercel). |
| `tenant/user postgres.<ref> not found` | Wrong pooler host index or wrong region | Copy the pooler string from the dashboard; `aws-0` and `aws-1` are not interchangeable. |
| `(ENOIDENTIFIER) no tenant identifier provided` | Pooler username is `postgres` without `.<project-ref>`, so Supavisor cannot identify the tenant | Use `postgres.<project-ref>` in `DATABASE_URL`. |
| `tenant/user postgres not found` / auth failure | Pooler username is `postgres` instead of `postgres.<project-ref>` | Fix the username in the connection URL. |
| Vercel 500 on sign-in (`Server Components render`) | Env vars scoped to Preview instead of Production, wrong `DATABASE_URL`, or no redeploy after editing them | Check **Settings → Environment Variables → Production**, fix, then **Redeploy**. |
| `column "..." of relation "..." does not exist` after deploying new code | The code has a migration the database has not applied | Run `ENV_FILE=.env.staging npm run migrate` (or `npm run doctor` to list pending migrations), then retry. |
| `Could not find the module` / build errors | `NODE_ENV` or build cache issue | Redeploy with "Clear build cache". |

`src/server/config.ts` now rejects a direct Supabase host on Vercel/Render and a pooler username
without the project ref, so these show up as a clear error instead of a network timeout.

## 9. Staging sign-off checklist

Run this on every change that will reach production, and record the result:

1. Sign in with an OTP; confirm the staging mail arrives and the code works.
2. Check staff, roles and workspaces (**Administration**).
3. Approve each offer template for production **in staging** (approval is per database).
4. Generate an offer letter of each applicant type and review the Word/PDF output.
5. Upload a small PDF and confirm it is stored in the staging bucket and appears clean.
6. Drive one case from request through assessment, approval, disbursement and closure.
7. Confirm the worker logs show outbox delivery and the closure pack email.
8. Confirm `RETENTION_PURGE_ENABLED=false` in staging and no blobs were purged.
9. Verify no request in the staging app links to production URLs, buckets or mail senders.

## 10. Promoting to live

Once staging sign-off passes:

1. Merge the tested code into the production branch.
2. Apply new migrations to the **production** database with
   `DATABASE_URL="<prod session-pooler-url>" npm run migrate`.
3. Deploy Vercel and Render production as described in [DEPLOYMENT.md](DEPLOYMENT.md).
4. Re-run the first live checks in DEPLOYMENT.md section 5. Offer-template approvals and the bank
   directory import are not copied from staging; repeat them against production.

## 11. Housekeeping

- **Pause staging when idle.** Render worker plans and Supabase projects bill while running; pause
  or downscale between test cycles. Free Supabase projects also pause after inactivity.
- **Keep staging schema current.** Both branches run the same migrations; if staging drifts, reset
  it and reseed rather than patching by hand.
- **Retire or rotate staging secrets** if a laptop, key or tester leaves the programme.
- **Do not enable real bank APIs** in staging unless the provider has given staging credentials.
