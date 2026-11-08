# Email delivery (Resend)

Sign-in OTPs and every notification (assignments, reminders, digests, closure packs) go through one
transport selected by `MAIL_DRIVER`:

| Driver | Behaviour |
|---|---|
| `dev` (default) | Captured in `dev_mailbox`, readable at `/dev/mailbox`. Nothing leaves the machine. Refused in production. |
| `resend` | Sent through the Resend HTTP API (`https://api.resend.com/emails`). Requires `RESEND_API_KEY` and a **verified** sending domain. |
| `smtp` | Sent through the bank-approved SMTP relay. |

OTP messages are sent directly (not through the outbox) and are never stored with the code. The other
notifications are queued in `notification_outbox` and delivered by `npm run worker`.

## Resend setup

1. Create an API key at **Resend → API Keys** with **Sending access**. Put it in `RESEND_API_KEY`.
2. Add the sending domain at **Resend → Domains → Add Domain**. Prefer a subdomain dedicated to the app,
   for example `mail.altbank.ng`; this avoids conflicts with the bank's existing mail on the root domain.
3. Resend shows the DNS records to add (typically an `MX` record plus `TXT` records for SPF and DKIM,
   and a DMARC record is recommended). Add them exactly as shown in **Cloudflare → DNS → Records**.
4. Wait for Resend to show the domain as **Verified** (usually minutes, occasionally a day).
5. Set the environment and restart the app and worker:

```dotenv
MAIL_DRIVER=resend
MAIL_FROM="WakeelBoost Work Desk <workdesk@mail.altbank.ng>"
RESEND_API_KEY=re_...
RESEND_BASE_URL=https://api.resend.com
# optional
RESEND_REPLY_TO=support@altbank.ng
```

`MAIL_FROM` must use the verified domain, otherwise Resend returns `403 domain is not verified`.

## Cloudflare notes

- **Proxy status does not apply to `MX` or `TXT` records.** If Resend asks you to add a `CNAME` (some
  setups use one for DKIM), set it to **DNS only** (grey cloud), not proxied.
- **Do not reuse a host that Cloudflare Email Routing already uses.** Email Routing adds its own
  `MX` records. Add Resend on a separate subdomain (for example `mail.altbank.ng`) instead of the root.
- Keep the records exactly as Resend shows them. Changing names, or adding an extra `SPF` `TXT` record,
  delays or blocks verification. Merge SPF values into one record only if you know both providers' rules.
- After verification, send one message and confirm it appears in **Resend → Emails**; that view shows
  delivery, bounce and complaint status.

## Testing before the domain is verified

Resend's shared sender `onboarding@resend.dev` can only deliver to the email address that owns the
Resend account. It cannot deliver sign-in codes to `@altbank.ng` staff, so keep `MAIL_DRIVER=dev`
locally until the domain is verified.

Once the API key or domain is ready, send a test message through the real transport:

```bash
npm run mail:test -- you@example.com
```

The script prints the driver and sender, and explains common failures (`401` API key, `403` unverified
domain). OTP uses the same transport, so a successful test means sign-in codes will also deliver.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `403 domain is not verified` | Finish DNS verification in Resend; make sure `MAIL_FROM` uses the verified domain. |
| `401` / invalid API key | Re-copy a key with Sending access into `RESEND_API_KEY`, then restart. |
| OTP says "code sent" but nothing arrives | Check the worker/app log and Resend → Emails. The app deliberately returns the same message even when delivery fails. Look for `EMAIL_FAILED` in the audit log. |
| Mail lands in spam | Complete SPF, DKIM and DMARC records; warm the domain before production traffic. |
| Attachment rejected | Resend limits the whole message to about 40 MB. Keep `CLOSURE_MAX_ATTACHMENT_BYTES` below that; larger closure packs are sent as a signed link. |
