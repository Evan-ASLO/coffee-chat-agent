# Internship & Coffee Chat Cloudflare app

This directory is the deployed Cloudflare Worker, D1 schema, queue consumer, tests, and no-build SPA for the unified Internship & Coffee Chat product: internship search, application tracking, approval-first networking, account-scoped analytics, settings, and the Home page's interactive Career Journey feature. The root Google Apps Script fallback is intentionally separate.

## Local development

```powershell
Copy-Item .dev.vars.example .dev.vars
npm install
npm run vendor:three
npm run db:migrate:local
npm run dev
```

Configure the existing Google/encryption values plus `JOBS_INGEST_SECRET` in `.dev.vars`. `BETA_ACCESS_MODE` defaults to `OPEN` when absent for backward compatibility. `ENABLE_JOB_OUTREACH_LINKING` defaults to false when absent; keep it false for preview unless deliberately testing the gated job-link flow. Never commit `.dev.vars`. Apply migrations remotely only as a separately approved deployment step.

## No-build client and 3D asset

The SPA remains plain HTML, CSS, and browser JavaScript served by the Worker assets binding. It does not require a client framework or runtime CDN.

- Three.js is pinned exactly in `package.json` and copied from the installed official npm package by `npm run vendor:three`.
- The self-hosted module/core files, MIT license, and package receipt live under `public/vendor/`.
- `npm run check` re-runs the deterministic vendor sync, so a missing or version-mismatched asset fails validation.
- The interactive scene is loaded only on authenticated Home, caps device pixel ratio and geometry, pauses offscreen or while the document is hidden, respects reduced motion, and disposes its renderer, scene resources, observers, listeners, and animation frame when another page renders.
- The HTML career-desk illustration and mirrored buttons remain available when WebGL is unsupported.

## Account-scoped analytics

`GET /api/analytics` is authenticated and ownership-scoped. It uses bounded queries over existing `user_job_states`, `prospects`, `jobs`, and `audit_events` records to return current application counts, networking counts, up to eight top companies, a 28-day activity series, and up to 30 recent activity entries. No analytics migration or third-party analytics service is required, and the UI does not invent growth percentages or future reminders.

## Approved-email beta

The private-beta gate uses two normal environment variables:

- `BETA_ACCESS_MODE`: only the exact value `ALLOWLIST` enables the gate; absent or any other value is `OPEN`.
- `BETA_ADMIN_EMAILS`: comma-separated emails, normalized to lowercase/trimmed. Environment admins are authorized even without a D1 allowlist row.

In `ALLOWLIST` mode:

- signed-out visitors see only the private-beta landing, legal/contact links, Google sign-in, and verified **Request access** flow;
- `/api/jobs` and job detail require an approved authenticated session;
- a verified but unapproved Google login creates/refreshes one pending request without creating a normal user or session;
- approved D1 emails and environment admins may create sessions;
- admin APIs require both a valid session and membership in `BETA_ADMIN_EMAILS`; and
- revocation ends existing sessions and is rechecked on later session validation.

Request responses are neutral and never disclose whether an email is already approved, pending, denied, or unknown. The request table stores normalized email, verified Google subject only while pending, status, and timestamps; the subject is cleared on approval/denial. It does not store an unverified form email or display name.

### Beta deployment order

1. Apply `0004_beta_access.sql`.
2. Configure `BETA_ADMIN_EMAILS` with the approved owner/admin email list.
3. Set `BETA_ACCESS_MODE=ALLOWLIST`.
4. Deploy the Worker and verify the landing plus admin override.
5. Approve test/user emails through the server-authorized admin UI.
6. Keep `ENABLE_JOB_OUTREACH_LINKING` independently false or true according to its separate rollout decision.

Do not enable `ALLOWLIST` before migration 0004 exists. During the beta, do not remove/misspell `BETA_ACCESS_MODE`: the intentional compatibility default is `OPEN`.

## Job snapshot ingestion v1

`POST /api/internal/jobs/snapshot`

Required headers:

- `Content-Type: application/json`
- `X-Ingest-Timestamp`: Unix epoch seconds
- `X-Ingest-Signature`: lowercase hex HMAC-SHA256 of `${timestamp}.${rawRequestBody}` using the `JOBS_INGEST_SECRET` Worker secret

The timestamp must be within 300 seconds. A valid signature is single-use within that window. The raw body limit is 2 MiB and a snapshot contains 1-1000 jobs.

```ts
interface JobSnapshotV1 {
  schemaVersion: 1;
  generatedAt: string; // ISO-8601 UTC
  snapshotHash: string; // lowercase SHA-256 hex
  jobs: NormalizedJobV1[];
}

interface NormalizedJobV1 {
  id: string; // 64 lowercase hex
  externalId: string | null;
  source: string;
  company: string;
  title: string;
  location: string;
  region: string;
  categories: string[];
  url: string; // absolute HTTP(S)
  postedAt: string | null; // ISO-8601 UTC when parseable
  postedText: string | null; // provider/relative display value
  description: string | null;
}
```

Objects are strict: unknown keys are rejected. Jobs must be sorted by `id` before hashing. Compute `snapshotHash` as lowercase SHA-256 hex of UTF-8 deterministic compact JSON for the jobs array, with object keys sorted recursively (`json.dumps(jobs, sort_keys=True, separators=(",", ":"), ensure_ascii=False)` in Python).

Job IDs are order-independent:

- with a reliable host/tenant-scoped source ID: `sha256("${source}\n${externalId}")`
- otherwise: `sha256("${source}\n${canonicalUrl}")`
- only when a URL is unavailable: hash normalized source, company, title, and location

The Worker verifies the canonical snapshot hash, stages every row, then atomically activates/upserts the snapshot and marks missing jobs inactive. An exact retry (`snapshotHash` plus `generatedAt`) is idempotent only when that applied run is still the active catalog. The same content at a later `generatedAt` creates a new run and can safely reactivate jobs after an A → B → A catalog sequence. A snapshot older than the active catalog, or different content with the same `generatedAt`, is rejected.

### Production pre-body rate guard

HMAC validation necessarily reads the signed body. The Worker therefore uses the Cloudflare-native `JOBS_INGEST_RATE_LIMITER` binding before reading or hashing the request body. It allows 10 requests per 60 seconds for each Cloudflare-provided `CF-Connecting-IP` key. The binding is declared in `wrangler.jsonc`, so it also covers the current `workers.dev` deployment without requiring a custom-domain WAF rule.

The guard deliberately does not use D1 or a client-supplied forwarding header: doing so would spend database writes before authentication or create a spoofable security control. If the publisher has stable egress, add a Cloudflare allowlist/WAF rule as an additional deployment control.

Successful response:

```json
{
  "importRunId": "uuid",
  "snapshotHash": "64-lowercase-hex",
  "idempotent": false,
  "activeCount": 250,
  "upsertedCount": 250,
  "deactivatedCount": 12
}
```

See [`examples/job-snapshot-v1.json`](examples/job-snapshot-v1.json).

### Source attribution

Job cards normalize source names for display without exposing publisher credentials. For `source === "adzuna"`, every card renders a linked **Jobs by Adzuna** badge using the self-hosted official logo at a minimum 116 × 23 CSS pixels. The link target is `https://www.adzuna.ca/`; the existing CSP remains `img-src 'self'`. Adzuna credentials must remain disabled until the attribution release gate in [`docs/SOURCE_ATTRIBUTION.md`](docs/SOURCE_ATTRIBUTION.md) passes.

## Public and authenticated APIs

- `GET /api/jobs`: public bounded search/filter/pagination plus safe catalog freshness (`never-imported`, `fresh`, or `stale`) and feature flags; authenticated requests also receive their own state and outreach summary.
- `GET /api/jobs/:id`: public active-job detail with the same freshness and feature metadata.
- `GET /api/job-states`: authenticated, bounded private tracking list.
- `GET /api/analytics`: authenticated, bounded current-status and recent-activity summary for the signed-in user.
- `PUT /api/jobs/:id/state`: authenticated/CSRF-protected upsert for `SAVED`, `APPLIED`, `INTERVIEWING`, `REJECTED`, `OFFER`, or `ARCHIVED`.
- `DELETE /api/jobs/:id/state`: authenticated/CSRF-protected removal.
- `POST /api/job-states/import-legacy`: authenticated one-time import.
- `POST|DELETE /api/jobs/:jobId/prospects/:prospectId`: authenticated ownership-checked job/prospect linkage.
- `GET /api/beta/admin/access`: environment-admin-only pending/access list.
- `POST /api/beta/admin/requests/:id/approve|deny`: environment-admin-only request decisions.
- `POST /api/beta/admin/access/approve|revoke`: environment-admin-only invite, re-approve, and revoke actions.

The jobs list preserves Search, Company, Location, Region, and Career Track filters and adds D1-backed Industry, Length, and Term filters with dynamic facets. See [`docs/STRUCTURED_JOB_FILTERS.md`](docs/STRUCTURED_JOB_FILTERS.md) for parsing rules, limitations, API values, and the required post-migration normal snapshot refresh.

Catalog freshness becomes stale when the publisher's latest `generatedAt` is more than two hours old. The SPA warns publicly but keeps browsing available.

### Job-linked outreach preview gate

`ENABLE_JOB_OUTREACH_LINKING` is an explicit normal environment variable, not a secret. It is disabled when absent or set to any value other than `true`. While disabled:

- job cards do not show **Find people at this company**;
- discovery without a `jobId` remains available as the independent Coffee Chat workflow; and
- discovery with a `jobId` plus direct job/prospect link or unlink mutations return `FEATURE_DISABLED`.

Enable it only after the catalog satisfies [`docs/PARALLEL_RUN_CRITERIA.md`](docs/PARALLEL_RUN_CRITERIA.md). For a reviewed rollout, set `ENABLE_JOB_OUTREACH_LINKING` to `true` in the target Worker's environment configuration and redeploy; set it back to `false` (or remove it) to stop new linking without disabling public jobs or core Coffee Chat networking.

### Optional cited people-search fallback

Each user has one disabled-by-default `peopleSearchFallbackProvider` setting: `NONE`, `GEMINI`, `OPENAI`, or `ANTHROPIC`. Job networking always runs Tavily's LinkedIn and approved-domain public-bio searches first. Only when those stages return fewer usable people than requested does the Worker read the selected provider's encrypted user key and make one bounded request with the user's configured model:

- Gemini Interactions API with `google_search`, `store: false`, and a supported configured `gemini-3.8-flash` or `gemini-3.7-flash` model;
- OpenAI Responses API with `web_search`, low search context, and `filters.allowed_domains`; or
- Anthropic Messages API with `web_search_20250305`, `max_uses: 1`, and `allowed_domains`.

There is no provider chain, automatic retry, or silent model substitution. Selected-provider failures are reduced to `RATE_LIMITED`, `AUTH`, `BAD_REQUEST`, `UNSUPPORTED`, `TIMEOUT`, `MALFORMED_RESPONSE`, or `PROVIDER_ERROR`. Audit and API summaries retain only the provider, category, numeric HTTP status when available, configured model, and aggregate counts; raw provider bodies/messages, prompts, results, URLs, and credentials are never stored. Every failure preserves accepted Tavily results.

Every accepted object must be strict JSON whose canonical `sourceUrl` exactly matches a direct provider citation and passes the existing LinkedIn/approved-host, page-type, company, role, location, and STRONG/BROADER quality checks. Google redirect citation URLs are rejected rather than resolved or trusted. The prompt contains only public company aliases, role/topics, location, approved domains, and requested count; it never includes the user's profile, resume, email, drafts, personal context, or credentials.

Provider web search and model tokens may be billable. Gemini can execute multiple billable searches within its one API request; OpenAI bills web-search tool usage and tokens under the selected model; Anthropic documents web search at $10 per 1,000 searches plus token charges. Availability and pricing can change, so users must confirm that their selected model/account supports the required search tool before enabling it.

Legacy import v1 is strict:

```ts
{
  schemaVersion: 1;
  exportedAt: string;
  source: "internship-tracker-toronto";
  savedJobs: Array<{ url: string | null; company: string; title: string }>;
  applications: Array<{
    url: string | null;
    company: string;
    title: string;
    status: "applied" | "interview" | "offer" | "rejected";
  }>;
}
```

Matching uses canonical URL first and normalized company/title second, and is batched within D1 parameter limits. A zero-match request returns `completed: false` with only the caller's unmatched references and does not consume the one-time lock, so it can be retried after the catalog is populated. Once at least one job matches, the request hash and result are stored: an exact retry is idempotent, while a different import is rejected. Existing server-side job states are preserved.

## Validation

```powershell
npm run check
npm audit
```

The Worker test suite covers ingestion authentication, future-boundary replay expiry, strict size/count/schema validation, active-catalog idempotency, A → B → A reactivation, stale replacement, public/private access, cross-user state isolation, status CRUD, zero-match/retry/idempotent legacy import, 500-reference batched matching, and job/prospect ownership.

Production validation, parallel-run, cutover, OAuth, secret, rollback, monitoring, structured-filter, and source-attribution procedures are under [`docs/`](docs/).

Resume uploads are encrypted and limited to 5 MB PDF/DOCX/TXT files, but no malware or file-safety scanner exists. That is acceptable only for the controlled private beta. Broad public launch requires the recorded decision in [`docs/VALIDATION_CHECKLIST.md`](docs/VALIDATION_CHECKLIST.md); do not claim scanning and do not send resumes to VirusTotal without an approved privacy design.
