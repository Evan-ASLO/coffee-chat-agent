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
- [ ] Migration `0004_beta_access.sql` applies before beta mode is enabled.
- [ ] Migration `0005_structured_job_filters.sql` applies, then a normal later-generated tracker snapshot repopulates derived fields.
- [ ] `JOBS_INGEST_SECRET` exists in the Worker and tracker publisher stores with matching values.
- [ ] `BETA_ACCESS_MODE=ALLOWLIST` and normalized `BETA_ADMIN_EMAILS` are configured only after migration 0004.
- [ ] `ENABLE_JOB_OUTREACH_LINKING` is absent or `false`.
- [ ] The Cloudflare edge rate limiter is 10 requests per 60 seconds per `CF-Connecting-IP`.

## Catalog and ingestion

- [ ] Send a signed current snapshot and record HTTP status, `snapshotHash`, `activeCount`, `upsertedCount`, `deactivatedCount`, and `importRunId`.
- [ ] Confirm the tracker and Worker report the exact same canonical hash and job count. The first post-fix baseline was 167 jobs and `fb06484d97af1c43511fddf802b9381e91b6fc6a7a7e712a4b2e644bb0d9410e`; subsequent runs must use their own current pair.
- [ ] Repeat the exact snapshot and confirm `idempotent: true`.
- [ ] Exercise A → B → A and confirm A-only jobs reactivate.
- [ ] Confirm stale/equal-time conflicting snapshots fail.
- [ ] Confirm `/api/jobs` reports `catalog.state = fresh`.
- [ ] Confirm Industry, Length, and Term facets have expected counts; test at least one combined filter and pagination.
- [ ] Confirm existing Search, Company, Location, Region, and Career Track filters still combine with the new selects.
- [ ] Confirm a generated time older than two hours produces a warning while jobs remain browsable.
- [ ] Confirm ingest logs contain counts/hash only, never the secret or raw body.
- [ ] Before enabling Adzuna credentials, verify every `source === "adzuna"` card shows the linked **Jobs by Adzuna** text/logo at least 116 × 23, with keyboard focus and accessible label/alt.

## Public and private behavior

- [ ] In `ALLOWLIST` mode, signed-out visitors see only the private-beta landing and legal/contact/sign-in/request links.
- [ ] Direct signed-out `/api/jobs` access returns `BETA_ACCESS_REQUIRED`.
- [ ] Verified unapproved Google login/request creates one normalized pending request, no normal user, and no session; repeated requests return the same neutral confirmation.
- [ ] Environment admins can list and manage requests; approved non-admins receive `FORBIDDEN`.
- [ ] Approve, deny, revoke, and re-approve actions create audit events.
- [ ] Revocation invalidates existing sessions and a stale session is rejected on its next validation.
- [ ] Approved signed-in users can search, filter, paginate, and open job source URLs; OPEN-mode compatibility is covered by automated tests only.
- [ ] Saved and application-state APIs require authentication and CSRF.
- [ ] User A cannot read, update, import, link, or unlink User B's data.
- [ ] A zero-match legacy import remains retryable and returns only the caller's references.
- [ ] A completed legacy import preserves existing server states and exact retries are idempotent.
- [ ] With linking disabled, job surfaces omit **People to contact**, linked discovery/read/link/unlink return `FEATURE_DISABLED`, and independent Coffee Chat discovery remains available.
- [ ] With linking enabled, Jobs grid/list, Saved, Home recent roles and Applications offer **People to contact**, including without keys. Opening/navigation/refresh/tutorial/paging perform no provider search, enrichment, drafting or sending.
- [ ] Saved links are ownership-scoped, reload without provider calls, deduplicate, survive refresh and retain job context. Missing keys offer Settings; duplicate clicks and stale job/account responses cannot start or replace another search.
- [ ] Confident tiers are ordered lexicographically: same-function junior, internship/new-grad recruiter, other same-firm junior. Former/wrong-firm profiles are rejected; senior/ambiguous profiles remain unconfirmed. Analyst/associate alone and recruiter junior status are not evidence. Each job has its own reasons/evidence/source links and preserves broader-match warnings.
- [ ] Search/ordinary Retry (including legacy requests without `mode`) are Tavily-only for full/partial/zero/unconfirmed/duplicate-heavy/error/missing-key outcomes and show only Tavily plan costs. Invalid modes are rejected before provider calls.
- [ ] Find more with AI/Retry with AI explicitly send `AI_SUPPLEMENT`, read only the selected provider's encrypted key/model, make at most one selected AI invocation and zero Tavily calls, and never chain, auto-top-up or retry providers. Existing stored preferences are preserved, including `NONE`.
- [ ] Selected-provider costs sit beside the AI action. Fresh unchecked authorization permits up to 3 Anthropic web searches plus tokens; each omitted budget stays at 1, invalid limits are rejected, and the hard cap is 3 for the whole request, not per tier. Consent resets on request, criteria, navigation, dialog/account/context change.
- [ ] Both surfaces preserve saved/Tavily contacts on AI failure/empty/duplicates, merge and re-rank new contacts, and discard stale criteria/job/account/logout responses. Disabled/missing selected-provider keys show guidance with zero provider calls.
- [ ] Each provider adapter requires a direct canonical citation, rejects uncited/redirect/host-mismatched/job-page objects, and preserves accepted Tavily people on errors.
- [ ] `SEARCH_LIMITED` names the actual request limit, not quota/auth failure, preserves validated partials and keeps status heading/body visibly separated. Tavily/AI phases remain clear; AI-only summaries never claim Tavily ran.
- [ ] Selected-provider failures normalize to `RATE_LIMITED`, `SEARCH_LIMITED`, `AUTH`, `BAD_REQUEST`, `UNSUPPORTED`, `TIMEOUT`, `MALFORMED_RESPONSE`, or `PROVIDER_ERROR`; summaries/audits contain only provider/category/HTTP status/model/counts/authorized cap/safe reason and never raw provider bodies/messages, prompts, results, URLs, or credentials.

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
