# Internship & Coffee Chat Cloudflare app

This directory is the deployed Cloudflare Worker, D1 schema, queue consumer, tests, and no-build SPA for the combined internship-tracking and coffee-chat product. The interface uses compact, page-specific layouts and clean decorative crops derived from user-provided Toronto workspace references; every control and data value remains live HTML. The root Google Apps Script fallback is intentionally separate.

## Local development

```powershell
Copy-Item .dev.vars.example .dev.vars
npm install
npm run vendor:three
npm run db:migrate:local
npm run dev
```

Configure the existing Google/encryption values plus `JOBS_INGEST_SECRET` in `.dev.vars`. `BETA_ACCESS_MODE` defaults to `OPEN` when absent for backward compatibility. `ENABLE_JOB_OUTREACH_LINKING` defaults to false when absent; keep it false for preview unless deliberately testing the gated job-link flow. Never commit `.dev.vars`. Apply migrations remotely only as a separately approved deployment step.

## No-build client, reference art, and Career Journey

- The SPA remains plain HTML, CSS, and browser JavaScript served by the Worker assets binding.
- Clean, optimized WebP crops under `public/art/` contain only decorative office/skyline/desk regions from the user's supplied references. Full uploaded screenshots, baked controls, example metrics, profile details, and owner information are not committed.
- `public/art/reference-art-receipt.json` records the source filename and crop rectangle for each committed derivative.
- Three.js is pinned exactly in `package.json` and copied from the official npm package by `npm run vendor:three`; its self-hosted module/core files, MIT license, and receipt live under `public/vendor/`.
- The Home Career Journey scene loads only on Home, mirrors pointer interactions with keyboard/touch controls, lowers quality on mobile, respects reduced motion, pauses offscreen/when hidden, and disposes all renderer resources and listeners on navigation.
- The styled HTML fallback remains available when WebGL is unsupported.
- Shared page containers, intrinsic grid tracks, wrapping controls and component-width queries keep the approved artwork and warm desktop theme intact while reflowing on phones. Every job filter remains available; application/network tables scroll only inside named, keyboard-focusable regions.
- The compact navigation drawer preserves in-progress form values and the current scene, supports Escape and a focus loop, and restores focus on close. Native editors use dynamic-viewport height limits and safe-area spacing; their headings stay sticky except on short screens, where long headings must scroll without covering fields. Touch controls have a 44 CSS-pixel minimum height, with legible form text that avoids iOS focus zoom.
- Career Journey milestones and selected details sit outside the canvas so they cannot obscure each other or the interactive world. Direct touch hits do not depend on prior pointer hover; viewport/reduced-motion changes dispose and rebuild the scene with the appropriate quality settings.

## Account-scoped analytics

`GET /api/analytics` is authenticated and ownership-scoped. It uses bounded queries over existing job state, prospect, job, and audit tables to return current application/networking counts, top companies, a 28-day recorded-activity series, and recent activity. It requires no migration and does not fabricate growth, conversion, coffee-chat, reminder, or future-event data.

## Owner activity and reviewed beta approvals

**Settings > Owner tools** is visible only for the server-reported owner role.
Every owner API independently requires a valid session and the existing
`BETA_ADMIN_EMAILS` guard; an approved beta account is not an owner.
No owner identities or permission settings are added by this feature.

`GET /api/beta/admin/activity` returns non-deleted registered account identifiers,
7- or 28-UTC-day audit counts (28 by default), and 20 account rows per page.
`GET /api/beta/admin/activity/events` returns 25 events per page, optionally
filtered by `userId` and an allowlisted `action`. Keyset cursors are bound to the
period and filters. Continue with the returned `asOf` time; snapshots older than
24 hours require an explicit refresh. Both endpoints use existing tables and
the user/time audit index, without a migration or per-user request loop.

The explicit response schema excludes raw metadata, entity/recipient details,
credentials and key hints, session hashes, resumes, private profile/draft/email
content and search queries. Only existing allowlisted search-fallback outcomes,
providers and error-reason enums are exposed. Counts mean recorded actions, not
pageviews, current saved-job totals, visits or live presence. Background events
are not evidence that someone was online. No activity in the period is not
"never used"; unrecorded failures are not counted. Owner UI caches and dialogs
are cleared on logout, account changes, owner-role loss and owner-route denial;
aborted, superseded or stale responses cannot repopulate them. No polling,
tracking SDK, export or historical backfill is added. See the privacy policy for
the existing retention limitations: display windows are not deletion schedules.

**Approve all pending** first fetches a fresh, owner-bound, authenticated
snapshot from `GET /api/beta/admin/requests/pending`. A native confirmation lists
the exact emails, including explicit new requests after denial/revocation.
Reviews expire after 10 minutes. Each confirmation is limited to **50 requests**;
larger queues say **Review pending batch (50 of N)** and require separate reviews.
The total count is independent of the existing 500-row administrative lists.

`POST /api/beta/admin/requests/approve-pending` accepts only
`{ snapshot, requestIds }` for that exact reviewed set, with owner, same-origin
and CSRF checks. One D1 transaction conditionally records owner audit receipts,
grants access, and transitions only still-pending, unchanged requests.
Later arrivals are excluded. Repeats and races return explicit approved and
skipped IDs; request identity/version or access status/version changes are
skipped rather than overriding a concurrent decision. A write error rolls back
the transaction; an unconfirmed response can be retried with the same snapshot
without approving future requests. The UI re-queries the pending list after
success and reports skips and refresh failures, not a blanket "all approved."
Single pending approval uses the same safe transition. Already-handled request
IDs cannot restore revoked access; deliberate re-approval remains an explicit
email action. No email, drafting, outreach approval or provider action occurs.

### Local-only owner review

From a fresh isolated checkout (dependencies must already be available):

```powershell
node scripts\prepare-owner-preview.mjs
npm run preview:onboarding
```

The preparation script checks port **8806**, reuses the existing local migration
and fixture harness, and writes only ignored local configuration/D1 state.
Open `http://127.0.0.1:8806/__review/owner#settings` for the fictional owner,
`/__review/member#settings` for a fictional non-owner, or
`/__review/signed-out` for no session. The separate `test/local-owner-preview.ts`
entry is never referenced by production config. It restricts itself to loopback,
blocks external fetch/OAuth/provider/CRM/discovery/enrichment/draft/send actions,
and permits only fictional local beta mutations and logout. No real credentials,
production database IDs or remote migrations are used by the review harness.

Focused checks:

```powershell
npm test -- test/owner-admin.spec.ts
node --test test\owner-admin.cjs test\ui-contract.cjs test\onboarding-contract.cjs
$env:OWNER_EVIDENCE_DIR = "C:\path\to\session\files\owner-review-evidence"
node test\browser\owner-admin.mjs
```

Browser checks use installed Edge, a desktop and a phone viewport, and the
isolated seeded Worker/D1 on 8806. JSON evidence and screenshots go to the
specified session-artifact directory. They make real local beta decisions, not
provider calls; the script creates only named fictional pending review fixtures.

## Optional first-login tutorial

The no-build `public/onboarding.js` / `onboarding.css` guide has two chapters:
**Set up API keys** and **Explore your workspace**. It highlights real controls
across Home, Jobs, Applications, Networking, Analytics, and Settings without
changing the reference artwork or replacing page layouts.

- Genuinely new approved accounts receive an optional invitation. Jobs, saves,
  and application tracking remain available with no provider keys.
- Migration `0008_first_login_tutorial.sql` gives existing users `legacy` state,
  so they are not suddenly enrolled. Settings offers replay to everyone.
- Next/Back save the stable step to the authenticated account. **Continue later**,
  the close button, and Escape save `paused`; Settings resumes that place.
  `in_progress` resumes on reload/sign-in. **Skip tutorial** saves `skipped`,
  and **Finish tutorial** saves `completed`; neither reopens automatically.
- `GET /api/onboarding` and CSRF/same-origin-protected `PUT /api/onboarding`
  expose only version, status, stable step, revision, and last-save time.
  `/api/session` includes that same account-scoped object. Mutations accept
  strict `{version, revision, action, step}` payloads, never a user ID.
- Version 1 validates start, adjacent progress, pause/resume, completion at the
  last step, skip, explicit key-free chapter skipping, and explicit replay.
  An atomic revision guard rejects stale/concurrent writes, including stale
  attempts to undo completion or skipping. Failed saves keep an actionable
  retry instead of claiming progress was persisted.
- Keys use the existing encrypted credential API and password controls. Only
  masked hints return from the server. The tutorial never stores a key, profile,
  or resume in its state, browser storage, links, or audit records. Fields are
  cleared on disposal, cancellation, successful save, account changes, and logout.
- Provider preferences change only through the real explicit Save settings
  workflow. Template/manual paths are available; saving a key never enables
  search fallback. Use your own provider accounts and check their current API
  billing, grounding/model availability, costs, and quotas.
- Tutorial navigation never searches, prepares a person, drafts/regenerates,
  sends, analyzes a resume, starts OAuth, or creates a CRM. User-opened native
  dialogs temporarily replace the non-modal coach rather than stacking modals.

Apply migration 0008 **before** deploying this Worker in a separately approved
release. This change does not migrate or deploy production automatically.

### Fictional local tutorial review

The test-only entry point `test/local-onboarding-preview.ts` is not referenced by
the production Wrangler configuration. It requires a local-preview flag and a
loopback host, uses fictional approved/denied accounts and opportunities, and
blocks external provider, OAuth, CRM-creation, resume-analysis, and send actions.
It does not use real Google identities or credentials.

```powershell
# From cloudflare-app; install only if dependencies are missing.
npm ci
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.test-browsers'
npx playwright install chromium
npm run preview:onboarding:prepare
npm run preview:onboarding
```

Preparation refuses to overwrite an existing `.d1` review database and checks
that the chosen port is free. It applies 0001-0007, seeds a fictional legacy
account, applies 0008, and seeds the local catalog. The short `.d1` path avoids
Windows SQLite WAL filename limits; all data/config remains in this checkout.
`TUTORIAL_PREVIEW_PORT` can choose a distinct port (default 8803).

Open `http://127.0.0.1:8803/__review/new` for the new-account invitation, or
`http://127.0.0.1:8803/__review/existing` for Settings replay. Signing into either
fictional account again preserves its tutorial progress. The test-only
`POST /__review/reset` resets only those named fictional fixtures.

In a second terminal, run `npm run test:onboarding:browser`. The suite intercepts
network requests, uses only fake keys, covers native dialogs and real app actions,
and writes redacted network receipts, desktop/phone screenshots, and scoped WCAG
axe results. Set `TUTORIAL_EVIDENCE_DIR` to choose the output folder. Browser
tooling is development-only; the application has no new runtime dependencies.

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
- `GET /api/analytics`: authenticated, bounded current-status and audit-backed activity summary for the signed-in user.
- `GET|PUT /api/onboarding`: authenticated per-user tutorial state; PUT is CSRF-protected, strictly validated, and revision-guarded.
- `PUT /api/jobs/:id/state`: authenticated/CSRF-protected upsert for `SAVED`, `APPLIED`, `INTERVIEWING`, `REJECTED`, `OFFER`, or `ARCHIVED`.
- `DELETE /api/jobs/:id/state`: authenticated/CSRF-protected removal.
- `POST /api/job-states/import-legacy`: authenticated one-time import.
- `POST|DELETE /api/jobs/:jobId/prospects/:prospectId`: authenticated ownership-checked job/prospect linkage.
- `GET /api/jobs/:id/prospects`: authenticated, feature-gated saved contacts for this job (including inactive tracked jobs), ownership-checked and deterministically ranked using persisted public evidence. Reading never calls a provider.
- `GET /api/beta/admin/access`: environment-admin-only pending/access list.
- `GET /api/beta/admin/activity` and `/api/beta/admin/activity/events`: minimized owner-only operational summaries and paginated events.
- `GET /api/beta/admin/requests/pending`: bounded, authenticated review snapshot of current pending requests.
- `POST /api/beta/admin/requests/approve-pending`: owner/CSRF-authorized transactional approval of that exact snapshot.
- `POST /api/beta/admin/requests/:id/approve|deny`: environment-admin-only request decisions.
- `POST /api/beta/admin/access/approve|revoke`: environment-admin-only invite, re-approve, and revoke actions.

The jobs list preserves Search, Company, Location, Region, and Career Track filters and adds D1-backed Industry, Length, and Term filters with dynamic facets. See [`docs/STRUCTURED_JOB_FILTERS.md`](docs/STRUCTURED_JOB_FILTERS.md) for parsing rules, limitations, API values, and the required post-migration normal snapshot refresh.

Catalog freshness becomes stale when the publisher's latest `generatedAt` is more than two hours old. The SPA warns publicly but keeps browsing available.

### Job-linked outreach preview gate

`ENABLE_JOB_OUTREACH_LINKING` is an explicit normal environment variable, not a secret. It is disabled when absent or set to any value other than `true`. While disabled:

- job cards do not show **People to contact**;
- discovery without a `jobId` remains available as the independent Coffee Chat workflow; and
- discovery with a `jobId` plus direct job/prospect link or unlink mutations return `FEATURE_DISABLED`.

Enable it only after the catalog satisfies [`docs/PARALLEL_RUN_CRITERIA.md`](docs/PARALLEL_RUN_CRITERIA.md). For a reviewed rollout, set `ENABLE_JOB_OUTREACH_LINKING` to `true` in the target Worker's environment configuration and redeploy; set it back to `false` (or remove it) to stop new linking without disabling public jobs or core Coffee Chat networking.

When enabled, **People to contact** is visible on Jobs grid/list, Saved, Home recent roles, and Applications rows/details even without a discovery key. It opens only the user's saved, linked contacts. A missing Tavily key offers Settings instead of hiding the action. The job context survives refresh via a job ID in the URL; no private contact data or API budget is stored in browser storage.

The server fixes the employer and function from the selected job, targets junior peers and early-career recruiters rather than managers, and ranks lexicographically:

1. A current employee with explicit junior/entry-level evidence in this job's role/function.
2. A current recruiter with explicit campus, internship or new-graduate recruiting evidence (not recruiter age/juniority and not a confirmed owner of the vacancy).
3. Another current entry-level employee at the same firm.

Employer aliases and cited current-employment statements/headlines are required. Analyst/associate titles alone, age, photos and invented experience are not seniority evidence. Senior/lead/director/VP indicators prevent entry-level qualification. Ambiguous profiles appear separately as **Unconfirmed fit**; former/wrong-firm candidates are rejected from new job-linked discovery. Each job link gets its own reason, supporting public evidence and source link, computed from existing persisted fields without a new migration. Existing `BROADER_COMPANY` warnings and both outreach approvals remain. Results and links deduplicate; no contact is promised for every job.

Opening/rendering/navigating/paging/tutorial steps never search, enrich, draft or send. **Find people** opens a form; **Search public profiles** explicitly starts discovery after the visible cost notice. **Review costs & retry** returns to that form, not a hidden retry. Concurrent clicks are disabled; late results cannot replace another job/account. **Stop waiting** cancels the browser request and propagates cancellation where supported, but already-started provider work can still be billed or finish; reload saved contacts before starting again.

### Optional cited people-search fallback

Each user has one disabled-by-default `peopleSearchFallbackProvider` setting: `NONE`, `GEMINI`, `OPENAI`, or `ANTHROPIC`. Job networking always runs Tavily's LinkedIn and approved-domain public-bio searches first. Only when those stages return fewer usable people than requested does the Worker read the selected provider's encrypted user key and make one bounded request with the user's configured model:

- Gemini Interactions API with `google_search`, `store: false`, and a supported configured `gemini-3.8-flash` or `gemini-3.7-flash` model;
- OpenAI Responses API with `web_search`, low search context, and `filters.allowed_domains`; or
- Anthropic Messages API with `web_search_20250305`, `allowed_domains`, and request-scoped `max_uses: 1` or `3`.

`POST /api/discovery` accepts only numeric `anthropicSearchMaxUses: 1 | 3`, defaulting to **1** for old clients or omitted consent. Other values are rejected before provider calls; the adapter also clamps unsupported values to 1. The UI's unchecked-by-default authorization control permits **up to 3 web searches plus model-token usage**, billed to the user's own API account. The cap applies to the entire single fallback invocation, never per tier, with one API attempt and a bounded timeout. No automatic provider/model change or recursive retry is added.

There is no provider chain, automatic retry, or silent model substitution. Selected-provider failures are reduced to `RATE_LIMITED`, `SEARCH_LIMITED`, `AUTH`, `BAD_REQUEST`, `UNSUPPORTED`, `TIMEOUT`, `MALFORMED_RESPONSE`, or `PROVIDER_ERROR`. Audit and API summaries retain only the provider, category, numeric HTTP rejection status when available, configured model, aggregate counts, and `fallbackReason`: a whitelisted Anthropic tool error code (`max_uses_exceeded`, `invalid_tool_input`, `query_too_long`, `request_too_large`, `too_many_requests`, `unavailable`), `unknown_tool_error`, or `null`. Raw provider bodies/messages, prompts, results, URLs, and credentials are never stored in these diagnostics. Every failure preserves accepted Tavily results.

Anthropic tool errors arrive inside HTTP 200 responses, so their `fallbackHttpStatus` remains `null`; actual HTTP 400/422 rejections retain their numeric status. `max_uses_exceeded` means this request hit its authorized cap, not API quota exhaustion or an invalid key/model. API/audit summaries include `anthropicSearchMaxUses`; the UI names the actual 1- or 3-search limit with a visibly separated status heading and message. Only for that error, a complete valid result object may still supply profiles through the same citation and acceptance checks below; the status stays `SEARCH_LIMITED`, even when profiles are retained. Missing/malformed output retains no fallback profiles, and any other tool error prevents salvage. The UI distinguishes partial results, failed searches, and completed searches with no qualified/new profiles. For a provider-reported unsupported/disabled search capability, an organization admin can check [Claude Console capabilities](https://platform.claude.com/settings/capabilities); a generic request/tool error does not establish a model or credential problem.

Every accepted object must be strict JSON whose canonical `sourceUrl` exactly matches a direct provider citation and passes the existing LinkedIn/approved-host, page-type, company, role, location, and STRONG/BROADER quality checks. Google redirect citation URLs are rejected rather than resolved or trusted. The prompt contains only public company aliases, role/topics, location, approved domains, and requested count; it never includes the user's profile, resume, email, drafts, personal context, or credentials.

Provider web search and model tokens may be billable. Gemini can execute multiple billable searches within its one API request; OpenAI bills web-search tool usage and tokens under the selected model. Search/retry and onboarding link [official Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing#web-search-tool) and explain the user's [Tavily API plan](https://docs.tavily.com/documentation/api-credits), without promising free usage or guaranteed results. Availability and pricing can change, so users must confirm their selected model/account's capabilities and costs.

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

### Fictional ranked-contacts review

In a fresh isolated checkout with dependencies already available:

```powershell
node scripts\prepare-contacts-preview.mjs
npm run preview:onboarding
# In another terminal:
node test\browser\contacts.mjs
```

This reuses the tutorial's local-only preparation/serving patterns on **8805**,
refuses an existing `.d1` database or occupied port, and never touches other
previews. Open `http://127.0.0.1:8805/__review/existing` for five fictional linked
contacts, or `/__review/second` for a separate account without keys or contacts.
The test-only `local-contacts-preview.ts` is not in production configuration:
it requires the loopback origin and review flag, blocks network egress,
provider/search/Google/CRM/draft/send/key actions at entry, and only permits
authenticated tutorial-progress writes. The browser test intercepts explicitly
requested searches with fake results, checks desktop/phone priorities, costs,
partial/error/retry, refresh, account isolation and final-send cancellation.
`CONTACTS_EVIDENCE_DIR` selects a screenshot/network-receipt folder.

### Isolated, read-only layout review

Use only a clean local checkout/worktree, never production D1. The fixture configuration has a distinct fake database ID, synthetic approved accounts and encrypted fake provider credentials, no queue/cron handlers, and disabled network egress. The normal/empty/long layout accounts cannot mutate application data. OAuth, discovery, resume analysis, drafting, CRM creation and sending always return an explicit `REVIEW_ONLY` error. Only the separate fictional tutorial accounts may save progress, encrypted fake keys, preferences and key-free job tracking through the real authenticated/CSRF-protected routes. Do not deploy this fixture or enter real credentials.

```powershell
$env:WRANGLER_SEND_METRICS = "false"
npx wrangler d1 migrations apply layout-review --config test\layout\wrangler.jsonc --local --persist-to ..\.d1
node test\layout\seed.mjs ..\.d1\seed.sql
npx wrangler d1 execute layout-review --config test\layout\wrangler.jsonc --local --persist-to ..\.d1 --file ..\.d1\seed.sql
node test\layout\seed-tutorial.mjs ..\.d1\tutorial-seed.sql
npx wrangler d1 execute layout-review --config test\layout\wrangler.jsonc --local --persist-to ..\.d1 --file ..\.d1\tutorial-seed.sql
npx wrangler dev --config test\layout\wrangler.jsonc --local --ip 127.0.0.1 --port 8804 --persist-to ..\.d1
```

Open `http://127.0.0.1:8804/__review/login?scenario=normal` (or `empty` / `long`) for synthetic account states; `/__review/logout` shows the signed-out private-beta landing. Keep `.d1` inside the checkout to avoid Windows SQLite path-length problems.

In a second terminal, run `npm run test:responsive` against that local fixture. The browser harness uses installed Microsoft Edge by default (`LAYOUT_BROWSER_CHANNEL` can select a separately installed Playwright browser), closes its automation browser on exit, and records screenshots plus overflow, control-collision, icon-alignment, hero-clipping, console and request measurements. Set `LAYOUT_EVIDENCE_DIR` to a session-artifact directory to preserve review evidence outside Git. `--quick` selects the smallest representative matrix; the full matrix includes 320/360/390/430/768/1024/1280/1440/1536/1920 widths, phone landscape, long content, empty tracking and the signed-out landing.

Run `npm run test:interactions` for keyboard/touch navigation, all job filters, bounded table scrolling, native editors at 200%/400%-equivalent reflow, and actual WebGL hit testing, motion/visibility changes, orientation, disposal and stale-mount races. This suite also verifies the fixture's explicit OAuth and mutation denials. `--only=controls`, `--only=dialogs`, or `--only=journey` selects a targeted group.

The combined fixture also provides `/__review/new` for an optional first-login invitation and `/__review/existing` for legacy-account replay. Its reset/revocation controls affect only fictional tutorial accounts, never the three layout accounts. To run the tutorial browser regressions here rather than against another session's preview, set `TUTORIAL_PREVIEW_URL=http://127.0.0.1:8804` and `TUTORIAL_EVIDENCE_DIR` to your session-artifact directory, then run `npm run test:onboarding:browser`. The suite uses installed Edge by default and covers short-screen scrollable tutorial chrome, 44px touch controls, drawer/modal handoff, keyboard focus and keyboard-sized visual-viewport/safe-inset bounds. It never runs provider tests or real Google/email actions.

The Worker test suite covers ingestion authentication, future-boundary replay expiry, strict size/count/schema validation, active-catalog idempotency, A → B → A reactivation, stale replacement, public/private access, cross-user state isolation, status CRUD, zero-match/retry/idempotent legacy import, 500-reference batched matching, and job/prospect ownership.

Production validation, parallel-run, cutover, OAuth, secret, rollback, monitoring, structured-filter, and source-attribution procedures are under [`docs/`](docs/).

Resume uploads are encrypted and limited to 5 MB PDF/DOCX/TXT files, but no malware or file-safety scanner exists. That is acceptable only for the controlled private beta. Broad public launch requires the recorded decision in [`docs/VALIDATION_CHECKLIST.md`](docs/VALIDATION_CHECKLIST.md); do not claim scanning and do not send resumes to VirusTotal without an approved privacy design.
