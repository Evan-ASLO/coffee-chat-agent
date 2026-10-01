# Internship & Coffee Chat Cloudflare app

This directory is the deployed Cloudflare Worker, D1 schema, queue consumer, tests, and no-build SPA for the combined internship-tracking and coffee-chat product. The root Google Apps Script fallback is intentionally separate.

## Local development

```powershell
Copy-Item .dev.vars.example .dev.vars
npm install
npm run db:migrate:local
npm run dev
```

Configure the existing Google/encryption values plus `JOBS_INGEST_SECRET` in `.dev.vars`. Never commit `.dev.vars`. Apply migrations remotely only as a separately approved deployment step.

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

## Public and authenticated APIs

- `GET /api/jobs`: public bounded search/filter/pagination; authenticated requests also receive their own state and outreach summary.
- `GET /api/jobs/:id`: public active-job detail.
- `GET /api/job-states`: authenticated, bounded private tracking list.
- `PUT /api/jobs/:id/state`: authenticated/CSRF-protected upsert for `SAVED`, `APPLIED`, `INTERVIEWING`, `REJECTED`, `OFFER`, or `ARCHIVED`.
- `DELETE /api/jobs/:id/state`: authenticated/CSRF-protected removal.
- `POST /api/job-states/import-legacy`: authenticated one-time import.
- `POST|DELETE /api/jobs/:jobId/prospects/:prospectId`: authenticated ownership-checked job/prospect linkage.

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
