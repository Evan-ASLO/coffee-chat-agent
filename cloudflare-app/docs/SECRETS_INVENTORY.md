# Secrets inventory

Never put secret values in this file, tickets, logs, screenshots, fixtures, or commits.

| Item | Storage | Consumer | Rotation trigger | Owner role |
|---|---|---|---|---|
| `JOBS_INGEST_SECRET` | Cloudflare Worker secret and tracker publisher secret store | Snapshot HMAC signer/verifier | suspected disclosure, publisher host compromise, scheduled security rotation | Tracker Operator + Cloudflare Operator |
| `GOOGLE_CLIENT_SECRET` | Cloudflare Worker secret | OAuth code exchange | Google client-secret rotation or suspected disclosure | OAuth Owner |
| `MASTER_ENCRYPTION_KEY_V1` | Cloudflare Worker secret | Existing encrypted credentials/resumes | cryptoperiod or suspected disclosure; retain while V1 ciphertext exists | Privacy/Security Reviewer + Cloudflare Operator |
| `MASTER_ENCRYPTION_KEY_V2` | Cloudflare Worker secret when introduced | New/re-encrypted credentials/resumes | key-rotation plan | Privacy/Security Reviewer + Cloudflare Operator |
| `SESSION_SIGNING_KEY` | Cloudflare Worker secret | OAuth state/payload sealing | suspected disclosure or planned session reset | Cloudflare Operator |
| Per-user Google refresh tokens | AES-256-GCM ciphertext in D1 | Gmail/Drive/Sheets | user reconnect/revocation | User, operated by OAuth Owner |
| Per-user Tavily/Hunter/AI keys | AES-256-GCM ciphertext in D1 | Selected provider operation | user replacement/deletion | User |
| Deployment/API credentials | Approved CI/CD or operator credential store | Wrangler, DNS, Vercel | staff/role change, compromise, provider policy | Release Lead + platform owner role |

Non-secret configuration includes `GOOGLE_CLIENT_ID`, D1 database ID, rate-limit namespace, model names, `APP_ORIGIN`, and `ENABLE_JOB_OUTREACH_LINKING`.

## Rotation procedures

### Ingestion secret

The current protocol accepts one secret. Pause scheduled publishing, update the Worker and tracker stores in one controlled window, deploy/restart both sides, send one signed snapshot, verify hash/count, then resume. Do not log the test signature/body.

### Encryption master key

Add the new key version, set `ACTIVE_KEY_VERSION` for new writes, verify old-version decrypt support, re-encrypt through an approved migration, and remove the old key only after no V1 ciphertext remains and a restore test passes.

### Session signing key

Rotation invalidates sealed OAuth state and may invalidate active sessions depending on implementation. Announce the session impact, rotate during a controlled window, and verify login/logout/CSRF.

### Google client secret

Update the Worker secret and test code exchange. Rotating or adding an OAuth client secret/redirect URI does not by itself require deleting stored refresh tokens; validate token continuity rather than forcing reconnect without evidence.

## Review cadence

Privacy/Security Reviewer validates inventory, access, rotation dates, and deletion capability before preview, before public launch, and quarterly thereafter.
