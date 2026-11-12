# Deployment: Vercel (web) + Render (worker) + Supabase (database and storage)

This project runs as two long-lived pieces plus two managed services:

| Piece | Host | Process |
|---|---|---|
| Web app and API | Vercel (Next.js) | `npm run build` / `npm start` (Vercel handles this) |
| Background worker | Render Background Worker | `npm run worker` |
| PostgreSQL | Supabase | Migrations applied once, then as new migrations are added |
| Object storage | Supabase Storage (S3 protocol) | Private bucket, accessed with S3 credentials |
| Email | Resend | `MAIL_DRIVER=resend` |

There is no Docker and no ClamAV in this deployment. Malware scanning is disabled with
`SCANNER_DRIVER=none`; see [Security tradeoffs](#security-tradeoffs).

## Environments

This page describes **production**. Do not deploy straight to live: stand up the **staging** copy
first and sign it off. Staging uses the same topology on separate Vercel, Render and Supabase
resources, with its own keys and synthetic data. See [STAGING.md](STAGING.md) for the full runbook,
isolation rules and the promotion checklist. The staging worker blueprint is
[`render.staging.yaml`](../render.staging.yaml).

## 1. Local check (one time)

```bash
npm install
cp .env.example .env        # point DATABASE_URL at a local PostgreSQL 16 database
npm run migrate
npm run seed -- --with-demo
npm run dev:all
```

Confirm the app loads at http://localhost:3000 before deploying.

## 2. Supabase: database and storage

### Database

1. Create a Supabase project and wait for it to finish provisioning.
2. Copy the connection string from **Project Settings → Database**:
   - **Render worker and one-off migrations:** use the **Session pooler** (port `5432`).
   - **Vercel:** use the **Transaction pooler** (port `6543`) to avoid exhausting connections.
   - If you use the same session-pooler URL everywhere, that is fine for a small internal app.
3. Use the pooler, not the direct `db.<project-ref>.supabase.co` host. Direct connections are
   IPv6-only on many networks and fail with `ENOTFOUND`/`ECONNABORTED`. The pooler host looks like
   `aws-1-<region>.pooler.supabase.com` and the username is `postgres.<project-ref>`.
4. URL-encode special characters in the password (`#` → `%23`, `@` → `%40`). Append
   `?uselibpqcompat=true&sslmode=require` so `pg` accepts Supabase's certificate chain:

   ```
   postgresql://postgres.<project-ref>:<url-encoded-password>@aws-1-<region>.pooler.supabase.com:5432/postgres?uselibpqcompat=true&sslmode=require
   ```
5. Run migrations from your laptop against the production database:

   ```bash
   DATABASE_URL="<session-pooler-url>" npm run migrate
   ```

   Never run `npm run db:reset` against production; it drops the schema.

6. Load reference data. `npm run seed` refuses to run when `APP_ENV=production`, so run it one time
   from your laptop with the production database and bucket configured:

   ```bash
   APP_ENV=development \
   DATABASE_URL="<session-pooler-url>" \
   STORAGE_DRIVER=s3 \
   S3_BUCKET=... S3_REGION=... S3_ENDPOINT=... S3_FORCE_PATH_STYLE=true \
   S3_SERVER_SIDE_ENCRYPTION=none \
   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
   npm run seed -- --with-demo
   ```

   Omit `--with-demo` for real staff only. The offer templates are written to the S3 bucket during
   this step. Alternatively, upload templates later through **Administration → Offer templates**.
   For a real deployment, import the bank directory from the HR export instead of seeding synthetic
   staff.

### Storage

1. Create a **private** bucket in Supabase Storage. Do not make it public.
2. Generate S3 access keys in **Storage → S3 Configuration → Access keys**.
3. Configure the bucket:

   ```
   STORAGE_DRIVER=s3
   S3_BUCKET=<bucket name>
   S3_REGION=<project region, e.g. eu-west-1>
   S3_ENDPOINT=https://<project-ref>.supabase.co/storage/v1/s3
   S3_FORCE_PATH_STYLE=true
   S3_SERVER_SIDE_ENCRYPTION=none
   AWS_ACCESS_KEY_ID=<S3 access key>
   AWS_SECRET_ACCESS_KEY=<S3 secret key>
   ```

   `S3_ENDPOINT` must use the exact project reference. Supabase rejects server-side encryption
   headers, hence `S3_SERVER_SIDE_ENCRYPTION=none`. Supabase supports `CopyObject`, which the app
   uses to move scanned files out of quarantine.

## 3. Vercel: web app

1. Push the repository to GitHub and import it into Vercel as a Next.js project.
2. Add the environment variables below under **Settings → Environment Variables** (Production).
3. Deploy. No custom build command is needed.

Required on Vercel:

| Variable | Value |
|---|---|
| `APP_ENV` | `production` |
| `APP_URL` | `https://<your-vercel-domain>` |
| `DATABASE_URL` | Supabase **transaction pooler** URL (port `6543`) |
| `STORAGE_DRIVER` | `s3` |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` | From Supabase Storage |
| `S3_FORCE_PATH_STYLE` | `true` |
| `S3_SERVER_SIDE_ENCRYPTION` | `none` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Supabase S3 keys |
| `SCANNER_DRIVER` | `none` |
| `MAIL_DRIVER` | `resend` |
| `RESEND_API_KEY` | Resend API key |
| `MAIL_FROM` | Verified sender, e.g. `ARAF Retail Asset Factory <noreply@araf.ng>` |
| `FIELD_ENCRYPTION_KEY` | `openssl rand -base64 32` |
| `APP_HMAC_KEY` | `openssl rand -base64 32` |
| `STORAGE_ENCRYPTION_KEY` | `openssl rand -base64 32` |
| `COOKIE_SECURE` | `true` |
| `TRUSTED_PROXY_HOPS` | `1` |
| `MAX_UPLOAD_BYTES` | `4194304` |
| `OFFER_PDF_CONVERTER` | `none` |

**Upload limit.** Vercel rejects any function request body over 4.5 MB, so keep
`MAX_UPLOAD_BYTES` at or below 4 MB. Larger PDFs fail with a 413 before the app sees them.
Supporting larger files requires a direct-to-S3 presigned upload flow (not implemented).

## 4. Render: background worker

1. Create a **Background Worker** service from the same repository. `render.yaml` in this repo can
   create it as a Blueprint; otherwise configure it manually:
   - Build command: `npm ci`
   - Start command: `npm run worker`
   - Pre-deploy command: `npm run migrate`
2. Add the same variables as Vercel, with these differences:
   - `DATABASE_URL`: Supabase **session pooler** URL (port `5432`).
   - `SCANNER_DRIVER`: `none`.
   - `APP_URL`: the Vercel production URL.
   - Worker-only scheduler settings are optional: `WORKER_POLL_MS`, `RETENTION_YEARS`,
     `RETENTION_PURGE_ENABLED`.
3. Deploy. The worker handles outbox email, weekly/monthly digests, document rescans and retention.
   Several workers are safe (`SKIP LOCKED` and advisory locks), but one is enough.

The worker runs TypeScript directly through `tsx`, which is now a runtime dependency (not a
devDependency), so it works even when Render installs production dependencies only.

## 4a. Staff Personal Financing settings

- Migration `007_staff_personal_financing.sql` runs with the others (`npm run migrate`; the Render
  worker's pre-deploy command does this).
- The worker processes offer expiries, reminders and the documentation pipeline: it must run.
- SharePoint is optional and off by default. To enable it, set the `SHAREPOINT_*` variables from
  `.env.example` on the **Render worker** (it uploads; the web app only reads status). See
  `docs/STAFF_FINANCING.md` section 8 for the Entra ID registration and permissions.
- Before the first staff offer can be issued, a Super Admin must load the bank-approved staff offer
  wording (Administration → Staff financing settings) and record the bank's approval on Offer templates.

## 5. First live checks

1. Open the Vercel URL and request an OTP. Confirm the email arrives through Resend.
2. Sign in as a seeded Super Admin and open **Administration → Offer templates**; review and
   **Approve for production** each template.
3. Upload a small PDF on a draft request. It should appear as clean immediately
   (`SCANNER_DRIVER=none`).
4. Check the Render worker logs for outbox/digest activity.
5. Drive one case to closure to confirm the worker sends the closure pack email.

## Security tradeoffs

- **Scanning is disabled.** `SCANNER_DRIVER=none` accepts every file and marks it clean. This is
  acceptable only if uploads come from trusted internal staff over HTTPS. Enable a real scanner
  before accepting untrusted files.
- **Secrets must match across hosts.** `FIELD_ENCRYPTION_KEY`, `APP_HMAC_KEY` and
  `STORAGE_ENCRYPTION_KEY` must be byte-identical on Vercel and Render, or documents cannot be
  decrypted and sessions break.
- **No public registration.** Create or seed the first Super Admin yourself. There is no sign-up.
- **Backups and availability.** Supabase free projects pause after inactivity; use a paid plan for
  anything beyond a demo. Configure database backups before go-live.
