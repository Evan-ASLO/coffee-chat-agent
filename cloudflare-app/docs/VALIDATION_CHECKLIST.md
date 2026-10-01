# Validation checklist

Use this checklist for the Cloudflare preview and again before public cutover. Record evidence in the release ticket; do not paste secret values, resume contents, OAuth tokens, or raw ingestion bodies.

## Roles

- **Release Lead:** owns go/no-go and evidence.
- **Cloudflare Operator:** Worker, D1, queues, rate limiter, logs, domain, and rollback.
- **Tracker Operator:** scraper normalization, dual publish, hash/count comparison, and freshness.
- **OAuth Owner:** Google OAuth client, consent screen, redirect URIs, Gmail, Drive, and Sheets.
- **Privacy/Security Reviewer:** data handling, resume decision, secret inventory, and isolation.
- **Support Observer:** user-facing smoke tests and incident notes.

## Build and configuration

- [ ] `npm run check` passes.
- [ ] `npm audit --audit-level=low` reports no unresolved vulnerabilities.
- [ ] `npx wrangler deploy --dry-run` lists D1, queue, assets, and `JOBS_INGEST_RATE_LIMITER`.
- [ ] Migration `0003_jobs_platform.sql` applies to a fresh isolated local D1 store.
- [ ] `JOBS_INGEST_SECRET` exists in the Worker and tracker publisher stores with matching values.
- [ ] `ENABLE_JOB_OUTREACH_LINKING` is absent or `false`.
- [ ] The Cloudflare edge rate limiter is 10 requests per 60 seconds per `CF-Connecting-IP`.

## Catalog and ingestion

- [ ] Send a signed current snapshot and record HTTP status, `snapshotHash`, `activeCount`, `upsertedCount`, `deactivatedCount`, and `importRunId`.
- [ ] Confirm the tracker and Worker report the exact same canonical hash and job count. The first post-fix baseline was 167 jobs and `fb06484d97af1c43511fddf802b9381e91b6fc6a7a7e712a4b2e644bb0d9410e`; subsequent runs must use their own current pair.
- [ ] Repeat the exact snapshot and confirm `idempotent: true`.
- [ ] Exercise A → B → A and confirm A-only jobs reactivate.
- [ ] Confirm stale/equal-time conflicting snapshots fail.
- [ ] Confirm `/api/jobs` reports `catalog.state = fresh`.
- [ ] Confirm a generated time older than two hours produces a warning while jobs remain browsable.
- [ ] Confirm ingest logs contain counts/hash only, never the secret or raw body.

## Public and private behavior

- [ ] Signed-out users can search, filter, paginate, and open job source URLs.
- [ ] Saved and application-state APIs require authentication and CSRF.
- [ ] User A cannot read, update, import, link, or unlink User B's data.
- [ ] A zero-match legacy import remains retryable and returns only the caller's references.
- [ ] A completed legacy import preserves existing server states and exact retries are idempotent.
- [ ] With linking disabled, job cards omit **Find people at this company**, linked discovery/link/unlink return `FEATURE_DISABLED`, and independent Coffee Chat discovery remains available.

## Google and encrypted-data smoke tests

Use designated test accounts and non-sensitive fixtures.

- [ ] Basic Google login requests only `openid email profile`.
- [ ] Incremental connect obtains Gmail send/read-only, Drive file, and Sheets scopes.
- [ ] Create the CRM Sheet and update one test prospect.
- [ ] Draft and send one test email only after both approval gates; verify reply sync.
- [ ] Upload, read back, optionally attach, and delete one benign TXT and one benign DOCX/PDF fixture within 5 MB.
- [ ] Verify stored provider credentials and resumes are never returned as plaintext.

## Resume launch gate

Encrypted PDF/DOCX/TXT uploads up to 5 MB are acceptable for the controlled private beta. Before broad public launch, the Privacy/Security Reviewer and Release Lead must choose and document one option:

1. keep uploads restricted to an approved beta cohort;
2. disable uploads for broad launch; or
3. implement a privacy-preserving malware/file-safety and quarantine design.

No malware scanner exists today. Do not claim scanning and do not send resumes to VirusTotal or another third party without an approved privacy review.

## Completion

- [ ] Seven-day criteria in [PARALLEL_RUN_CRITERIA.md](PARALLEL_RUN_CRITERIA.md) pass.
- [ ] Backup and restore drill in [CUTOVER_RUNBOOK.md](CUTOVER_RUNBOOK.md) passes.
- [ ] OAuth audit, secrets inventory, rollback, and monitoring documents are reviewed.
- [ ] Release Lead records go/no-go and unresolved decisions.
