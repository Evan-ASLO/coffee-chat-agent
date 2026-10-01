# Monitoring configuration

## Dashboards

Cloudflare Operator maintains panels for:

- Worker request volume, latency, 2xx/4xx/5xx by path;
- ingest successes, failures, idempotent runs, active/upserted/deactivated counts, and rate-limit denials;
- public catalog generated/import times and age;
- D1 errors, latency, writes, and storage;
- queue retries and dead-letter messages;
- OAuth callback errors and unauthorized/CSRF rejections;
- Gmail sends/reply sync and Sheets synchronization failures; and
- resume upload/analyze/delete failures by MIME type and size band, never file contents.

## Alerts

| Signal | Warning | Critical | Owner role |
|---|---|---|---|
| Catalog age | 90 minutes | 120 minutes | Tracker Operator |
| Hash/count comparison | any mismatch | unresolved for 15 minutes | Tracker Operator + Release Lead |
| Ingest response | one non-2xx | two consecutive non-2xx or no success within 15 minutes | Tracker Operator |
| Ingest 429 | more than 2 in 10 minutes | sustained 429s blocking scheduled publish | Cloudflare Operator |
| Worker 5xx | >0.5% for 5 minutes | >1% for 5 minutes | Cloudflare Operator |
| D1 operation errors | 1 repeated operation | 3 consecutive failures or integrity error | Cloudflare Operator |
| Queue/DLQ | any retry spike | any DLQ message | Cloudflare Operator |
| OAuth callbacks | 2 failures in 10 minutes | 5 failures in 10 minutes or existing-user login outage | OAuth Owner |
| Gmail/Sheets sync | 2 consecutive test failures | confirmed send/state corruption | OAuth Owner + Release Lead |
| Cross-user isolation | n/a | any failure | Privacy/Security Reviewer + Release Lead |

## Synthetic checks

Run every five minutes from an approved monitor:

1. `GET /api/health` is 200.
2. `GET /api/jobs?page=1&pageSize=1` is 200.
3. `catalog.state` is not `never-imported` after launch and does not remain `stale`.
4. Pagination metadata and returned job shape are valid.

Run authenticated smoke checks with a dedicated test account at least daily during parallel run and after every deployment: session, save/delete state, and a read-only prospect list. Gmail send and Sheet-write smoke tests remain manual and approval-gated.

## Structured log requirements

- Keep `requestId`, event name, path/method, error code, import run ID, snapshot hash, and counts.
- Never log `JOBS_INGEST_SECRET`, HMAC input/signature, raw snapshot body, cookies, OAuth tokens/codes, API keys, email bodies, or resume content.
- Restrict log access by role and retain only as long as operational/security policy requires.

## Incident linkage

Every critical alert opens the relevant procedure:

- freshness/hash/ingest: [PARALLEL_RUN_CRITERIA.md](PARALLEL_RUN_CRITERIA.md);
- auth: [OAUTH_AUDIT.md](OAUTH_AUDIT.md);
- data/routing: [ROLLBACK_PROCEDURE.md](ROLLBACK_PROCEDURE.md);
- cutover window: [CUTOVER_RUNBOOK.md](CUTOVER_RUNBOOK.md).
