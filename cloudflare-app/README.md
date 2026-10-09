# Internship & Coffee Chat Cloudflare app

This directory is the deployed Cloudflare Worker, D1 schema, queue consumer, tests, and no-build SPA for the combined internship-tracking and coffee-chat product. The warm, job-first interface puts **Find jobs → My jobs → People** in the primary navigation and phone bottom bar. Profile, provider setup, the setup guide and Analytics remain in the account menu; the coffee brand opens Home. Every result, tracking stage, source and draft is live account-scoped HTML, not a prototype record. The root Google Apps Script fallback is intentionally separate.

## Job-first interface and design recovery

`public/job-first.js` supplies navigation aliases, a pauseable lightweight illustration, the honest setup guide and the existing fictional-concept Demo. `public/job-first.css` supplies the warm light/dark theme. The role panel exposes the original source, private notes and explicit stage changes. Save notes to persist them; unsaved notes remain only in account-bound memory until reload/logout. Quick Mark applied/bookmark actions never regress an existing application stage. Browser Back restores routes, role selection and filters. Legacy hashes remain accepted; stable tutorial IDs are unchanged.

Find jobs carries the animated hero and primary keyword/location controls; More filters exposes every secondary filter with an active count. My jobs uses tracked-role rows and horizontal stage filters; People uses review cards and horizontal workflow filters. Role/People/Progress sections use real posting, gated linked-contact and tracking data. Selected-role identity remains visible through People and draft review, with an explicit return path. Summaries, advanced filters, billing/privacy detail and owner controls remain accessible without dominating the core lists.

`public/theme.js` runs before styles on the app, Privacy and Terms. With no explicit preference the default is Light, even on an OS set to Dark. A manual Light/Dark selection persists only the theme string in this browser (`coffee-chat-theme`), never account data, notes or session responses. A saved choice takes precedence over OS settings and the optional `scoutTheme` review parameter. With no saved choice that parameter can select a temporary review theme. Legal pages share the warm typography and readable measure; their legal content is unchanged.

Startup begins the single same-origin session read while the remaining scripts load. The first load consumes it once through the normal API error handling; later session reads always go to the server. No session response is persisted or reused across account changes, and no provider or private activity query is added.

The former live networking design is preserved in the annotated source tag **`archive-live-networking-20261008`** at `4403c5f77d81d7206048550a2d875c86c1c2dab3`. Its Worker version is `f1939c6e-968f-434b-8396-54377c5be54f`. An operator can restore that UI with `wrangler rollback <version> --config wrangler.jsonc --message "Restore archived networking design; preserve database and gates"`, or redeploy the tag from a separate checkout with `--keep-vars --no-autoconfig`. **Do not restore D1, delete records or reverse migration 0009 for a design rollback.** The source archive and release receipt are retained outside the repository; they contain no credentials. Apollo remains OFF.

## Local development

```powershell
Copy-Item .dev.vars.example .dev.vars
npm install
npm run vendor:three
npm run db:migrate:local
npm run dev
```

Configure the existing Google/encryption values plus `JOBS_INGEST_SECRET` in `.dev.vars`. `BETA_ACCESS_MODE` defaults to `OPEN` when absent for backward compatibility. `ENABLE_JOB_OUTREACH_LINKING` defaults to false when absent; keep it false for preview unless deliberately testing the gated job-link flow. Never commit `.dev.vars`. Apply migrations remotely only as a separately approved deployment step.

## Approved contact preparation: optional Apollo and sourced drafts

Discovery remains separate: Tavily-only Search/Retry and explicit one-provider
**Find more with AI** cannot approve, enrich or draft. In either Networking entry,
**Approve & prepare** claims the existing owned prospect once, records contact
approval, and performs bounded stages: selected email lookup, person-specific
Tavily research, then the saved drafting model (or the existing key-free Template).
No stage sends mail or approves a draft.

Discovery is recall-first, not identity verification. Identifiable individuals on public professional sources are retained for review even when role/employer evidence differs or is incomplete. The bounded Tavily bio pass is not restricted to a hardcoded domain list; explicit AI discovery still requires a cited source and one selected-provider request. Strong evidence ranks before possible/uncertain matches. The existing `BROADER_COMPANY` storage value now represents the broader review category, including unconfirmed/different employers; it is not an assertion of a company match. Missing fields stay unknown, and only evidenced job fits enter the three confirmed tiers. Unsafe URLs, non-person pages, unidentified names and non-professional evidence remain excluded, with aggregate rejection categories in the response. No extra lookup, automatic AI fallback, contact approval or send permission follows from retaining a candidate. No schema change is required.

For general searches without an employer, short `VC` and `VC analyst` role terms expand to their venture-capital equivalents in the two existing Tavily queries; the bio query favors person-specific analyst/investor/profile results rather than generic team or leadership directories. This does not increase provider calls, change job-linked priority queries, relax URL safety or guarantee a candidate. Returned-result counts and aggregate rejected-link counts describe the links Tavily supplied, not a judgment that the requested role was too narrow.

General employer-linked bio searches keep the full requested role phrase (for example, RBC + Investment Banking) ahead of fallback employer topics, use RBC Capital Markets as an RBC alias, and seek individual professional biographies rather than generic firm directories. General bio queries honor the supplied roles, keywords and (without an employer) industries; their source cues do not force every profession into analyst/investor searches. Job-linked priority and its separate query structure remain unchanged; the RBC alias also applies there. People shows the saved account or job list, not only the latest Tavily results; after a search it labels the number newly added alongside the saved count so a prior contact is not mistaken for a repeat provider result. Successful role and note saves acknowledge only persisted changes. No search guarantees an identifiable person.

Both Tavily passes can now return public web profiles, including LinkedIn and individual professional biographies. The first pass no longer restricts Tavily to `linkedin.com` and applies the same person-specific bio validation to non-LinkedIn results; if fewer than the requested number are reviewable, the existing second pass uses a more person-focused public-bio query. There is no additional pass, AI call, URL-safety bypass, or automatic background search. Empty outcomes show concise aggregate rejection counts rather than stage-by-stage explanations. Broader sources can improve recall but can also return irrelevant pages; unsafe/non-person results remain excluded and uncertain employer/role fits are labeled for review.

Real, user-authorized basic-search comparisons exposed a query regression: bare employer/role/location Boolean queries favored company or job pages, while the older profile-oriented searches found individuals. The first query now includes `(site:linkedin.com/in OR biography OR profile)` as alternative source clues, with space-separated criteria groups rather than explicit `AND`; it remains a broad-web request without a native domain restriction. Indexed `Current role`, `Headline`, and ongoing employment entries are used when available rather than treating a CFA suffix or an outdated indexed title as the person's current job. Organization names and jobs/careers hosts cannot become people. These changes do not add a provider pass or weaken exact-draft approvals.

Discovery checks validated source URLs against this user's saved contacts before applying the requested-person cap. Existing high-ranked profiles no longer hide new people farther down the same provider response. The existing second Tavily pass can run when the first contains only saved contacts, still within the two-pass bound; a repeat search may therefore use that second pass rather than stop on duplicates. Explicit AI applies the same fresh-before-saved selection within its one selected-provider response, without an additional call. Saved-only outcomes remain honestly reported as duplicates; existing owned contacts may be linked to the selected job without replacing preparation, approval or send state. Saved-source lookups are user-scoped and bounded in batches of 20. Professional bios can establish a person's role through explicit role/employer evidence or indexed employment fields, not only a list of recognized profession words; safe source and identifiable-name checks still apply. Regression coverage spans consulting, software engineering, marketing, accounting, HR, data science, law and design across role/industry/keyword inputs; it does not guarantee results from an external search engine.

The repeated stale-catalog banner is hidden at the user's request; source/refreshed timestamps and actual fetch errors remain visible, and catalog freshness/feature gates are unchanged. Search notices keep new-versus-saved counts without the earlier-search explanation. The short Tavily credit notice links to official credit documentation; the separate AI action retains its provider-specific cost and authorization disclosure.

- Hunter remains the existing default; saving an Apollo key does not change the
  enrichment preference. There is no automatic Hunter/Apollo fallback.
- **Apollo is NOT enabled for live use.** `ENABLE_APOLLO_ENRICHMENT` must equal
  `"true"` server-side before key storage or an Apollo call is allowed; absent is
  off. The UI has no authorization toggle. [API Terms section 3](https://www.apollo.io/terms/api)
  require Apollo authorization of this product and its authentication model.
  [Partner OAuth registration](https://docs.apollo.io/docs/use-oauth-20-authorization-flow-to-access-apollo-user-information-partners)
  may be required instead of this key adapter. Per-user BYOK is not verified
  permission. Do not enable the gate or collect keys until the arrangement is
  authorized; OAuth implementation would be a separately reviewed requirement.
- The adapter uses one `POST https://api.apollo.io/api/v1/people/match` with
  `x-api-key` and documented query parameters (not API keys in the URL). Only
  approved public identity is sent. `reveal_personal_emails`,
  `reveal_phone_number`, `run_waterfall_email`, and `run_waterfall_phone` are
  explicitly false. It uses `person`, never a nested unrelated `contact`, and
  requires high `person.match_confidence`, matching name/profile/current employer,
  matching employer domain, and a valid `verified` work email. Missing confidence,
  historical employment, placeholders, unverified/personal addresses and
  contradictory identity are not accepted. Categorical match confidence is not a
  deliverability percentage: Apollo leaves the legacy numeric score at 0
  (unknown) and its CRM confidence cell blank, while Hunter's score is preserved.
  No enrichment result approves sending.
- Official [enrichment](https://docs.apollo.io/reference/people-enrichment) and
  [pricing](https://docs.apollo.io/docs/api-pricing) were reviewed October 7, 2026:
  current-plan demographics/email may cost 1 credit even with no email; legacy
  costs and account eligibility vary. A scoped people/match key can suffice;
  this app does not demand a master key.
- Research is one basic Tavily search, max 5 results, for the approved name and
  employer. Only associated public professional snippets/links are retained.
  Irrelevant, wrong-person, unsafe and instruction-bearing results are rejected.
  Existing genuine discovery evidence can support a labelled limited-context
  draft when research is missing, empty or fails; success is never fabricated.
- The existing draft path receives minimal untrusted public evidence plus saved
  factual user experience/profile (including reviewed resume suggestions).
  Recipient email, credentials and private prior drafts are omitted. Each draft
  action uses one selected model request, existing token budgets and no search
  tools, automatic transport retries or Gemini model fallback. The template
  choice remains key-free. Source links stay in review/context UI, not forced
  inline citations in outreach. Template retains its existing profile/discovery
  wording rather than summarizing new research.
- Each stage is persisted before the next. The cache is bound to public person
  identity, not shared between accounts or contacts. Successes AND unsuccessful
  outcomes are reused by ordinary draft retry; regeneration never re-spends on
  enrichment or research. Caches are dated evidence, not a guarantee of current
  employment/deliverability; there is no automatic freshness refresh.
- `POST /api/prospects/:id/preparation/retry` accepts strict
  `{stage: "EMAIL" | "RESEARCH", expectedVersion: number}` after contact approval.
  It retries only that stage and the draft, reusing the other stage. The separate
  cost-disclosed controls are for explicit recovery, not automatic top-up.
- Stage failures are visible; a missing email never becomes a guessed recipient.
  A draft failure retains completed email/research and any previous draft.
  Preparation/regeneration/editing invalidate prior draft approval. Concurrent
  preparation is rejected; draft editing checks the reviewed version. The client
  cannot send unsaved edits or reuse a review across accounts/jobs; the server
  still requires the current version/hash, ownership and existing send lock/
  idempotency protocol. Cancelled/stale responses cannot change a newer context.
- Operational events preserve `DRAFT_PREPARED` / `DRAFT_REGENERATED` and only add
  provider/stage enums and counts. Owner projection remains unchanged: no
  recipient email, research bodies or raw provider errors are exposed.

Migration **0009_approved_preparation.sql** adds `prospects.preparation_json`
(validated versioned email/research state) and rebuilds only the encrypted-key
table to add `APOLLO` to its provider constraint. Ciphertext, IVs, user-bound AAD
inputs, existing IDs, settings/defaults and owner data are preserved. Apply it
locally for review; production migration and release need separate approval.

### Mock-only preparation review

After the existing isolated contacts preview has been stopped, run
`node scripts\prepare-preparation-preview.mjs`, then `npm run preview:onboarding`.
This upgrades only the validated local fixture database and changes its ignored
test entry, not production configuration. Use `http://127.0.0.1:8807/__review/preparation`
for the fictional preparation account; the original `/__review/existing` Tavily
review remains available. All external fetches are replaced with deterministic
fixtures. Keys, OAuth, discovery, CRM and actual sends remain blocked. Browser
review exercises stored D1 approval, email/research, draft edits/regeneration and
final-send cancellation. Existing prospect-sync queue messages are recorded by a
typed local mock and never dispatched to Google. This is not a real-provider or
licensing smoke test.

Focused checks: `npm test -- test\preparation.spec.ts`, `npm run typecheck`,
`node --test test\preparation-client.cjs`, and
`node test\browser\preparation.mjs` (set `PREPARATION_EVIDENCE_DIR` outside the repo).

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

## Home entry, catalog-linked People and bug reporting

Home is a first-class desktop/mobile tab and the default without an explicit route. Explicit role/People links and job-filter URLs retain their destination; normal login returns to Home, while a sealed, same-app return path preserves recognised deep-link context without OAuth tokens. Signed-out users retain the public landing and beta gates rather than a fictional authenticated workspace.

Catalog-reference routes accept bounded URL-safe legacy references as well as canonical SHA IDs; new signed catalog ingestion still requires its original SHA-256 contract. Job-linked People reads only this user's saved contacts until an explicit search. Loads are cancellable/context-bound and time out after 15 seconds with a reload action instead of remaining indefinitely in loading or displaying a false empty success. Invalid, missing, disabled and unauthorised responses do not run a provider search.

Signed-in beta members can choose **Report a bug** in the footer. Reports are stored in the **Owner tools > Bug reports** inbox, not sent by email. Only explicitly written summary/description, a safe view label and server-derived reporter identity are stored; no private outreach, raw errors, complete criteria or URL tokens are auto-attached. Inputs are bounded, origin/CSRF/auth protected, limited to five new reports per hour and idempotent on retry. Owners can read paginated reports and mark open/resolved; ordinary users cannot list/manage reports.

Additive migration **0010_bug_reports.sql** creates only the report table/indexes and account-deletion cleanup trigger. It does not alter existing users, credentials, jobs or report-independent data. Keep the table on code/UI rollback; do not reverse the migration or delete reports for rollback. Account deletion still clears that account's reports through cascade/soft-deletion cleanup, including when older code is temporarily restored.

## Removing unsent people after preparation failures

**Remove** remains available for `DISCOVERED`, `ERROR` and `DRAFT_READY` people, including previously approved contacts whose draft failed, without writing-profile readiness or provider credentials. It uses the existing rejection route, not permanent deletion. Confirmation names the person and explains that their record/history is kept while they leave active approval/outreach queues. General and job-linked active lists/counts exclude `REJECTED`; records, job links, cached preparation and historical drafts remain stored. In-flight `PREPARING`/`SENDING` and completed `SENT`/`REPLIED` states are not removable. State-guarded preparation, edits and send claims cannot revive or send a rejected person. A confirmed removal invalidates client draft review even when a later refresh is stale or fails.

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

`GET /api/beta/admin/activity/access` supplies a separately paginated **current named access** roster: effective normalized approved addresses plus configured owners, deduplicated and joined to current registrations. Its grant, registered-address and no-current-account totals are not the same as registered-user or event totals in the activity snapshot. Unregistered or deleted entries have no user ID/name or Events action; a missing account is not proof of no visits. Deleted identity details are not returned. Registered activity keeps revoked/non-granted accounts and genuine zero-event rows, with access status labelled at the last refresh rather than as historical access. In `OPEN` mode, named grants are explicitly not a total of everyone who can access; configured owners retain their override even if a D1 approval is revoked. This read-only addition does not create users, grant permissions, record visits or change schema.

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
  AI discovery. Only Find more with AI authorizes a supplemental search.
  Use your own provider accounts and check their current API
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

Opening/rendering/navigating/paging/tutorial steps never search, enrich, draft or send. **Find people** opens a form; **Search public profiles** explicitly starts **Tavily-only** discovery after the Tavily plan notice. **Review costs & retry Tavily** returns to that form, not a hidden retry. Full, partial, empty, duplicate-only and unconfirmed results, errors, and missing Tavily keys never trigger AI. Concurrent clicks are disabled; late results cannot replace changed criteria, another job/account, or logout state. **Stop waiting** and navigation cancel the browser request and propagate cancellation where supported, but already-started provider work can still be billed or finish; reload saved contacts before starting again.

### Optional, explicitly requested AI discovery

Each user retains the disabled-by-default `peopleSearchFallbackProvider` setting (`NONE`, `GEMINI`, `OPENAI`, or `ANTHROPIC`), now labelled **Optional AI discovery provider**. Existing preferences are preserved. **Search public profiles** uses Tavily's bounded broad-web pass and, if needed, a more person-focused public-bio pass; neither pass uses a fixed domain allowlist. After reviewing results, **Find more with AI** is a separate, cost-disclosed action. It preserves saved/Tavily contacts and merges new validated contacts with their existing job links and ranking. It may return only duplicates or no new contacts.

`POST /api/discovery` accepts `mode: "TAVILY" | "AI_SUPPLEMENT"`; omitted mode (including legacy clients) safely defaults to **TAVILY**, and invalid modes return `INVALID_REQUEST` before provider calls. `AI_SUPPLEMENT` never calls Tavily or reads its credential. It reads only the selected AI provider's encrypted user key and saved model and makes one bounded request (at most 10 candidate profiles, still capped by the discovery count):

- Gemini Interactions API with `google_search`, `store: false`, and a supported configured `gemini-3.8-flash` or `gemini-3.7-flash` model;
- OpenAI Responses API with `web_search`, low search context, and `filters.allowed_domains`; or
- Anthropic Messages API with `web_search_20250305`, `allowed_domains`, and request-scoped `max_uses: 1` or `3`.

`POST /api/discovery` accepts only numeric `anthropicSearchMaxUses: 1 | 3`, defaulting to **1** for omitted consent. Other values are rejected before provider calls; the adapter also clamps unsupported values to 1. Tavily mode ignores any higher AI budget and reports 1 without making an AI call. Beside the AI action, an unchecked-by-default authorization control permits **up to 3 web searches plus model-token usage**, billed to the user's own API account. Consent resets after each request, criteria change, navigation, dialog opening, or account/context change; it is not a saved preference. **Retry with AI** is another explicit, newly billed action with a fresh default of 1. The cap applies to the entire single AI invocation, never per tier, with one API attempt and a bounded timeout.

There is no automatic top-up, provider chain, AI retry, or silent model substitution. Disabled/missing-key AI actions return the existing safe `DISABLED`/`MISSING_KEY` summary with zero provider calls. Selected-provider failures are reduced to `RATE_LIMITED`, `SEARCH_LIMITED`, `AUTH`, `BAD_REQUEST`, `UNSUPPORTED`, `TIMEOUT`, `MALFORMED_RESPONSE`, or `PROVIDER_ERROR`. `DISCOVERY_COMPLETED` and its existing aggregate fields are retained, with `mode` and `tavilyAttempted` added. Tavily-only summaries use `fallbackStatus: "NOT_REQUESTED"` and no selected AI provider; AI-only summaries have zero Tavily-stage counts and `tavilyAttempted: false`. Audit and API summaries retain only these mode indicators, provider, category, numeric HTTP rejection status when available, configured model, aggregate counts, and `fallbackReason`: a whitelisted Anthropic tool error code (`max_uses_exceeded`, `invalid_tool_input`, `query_too_long`, `request_too_large`, `too_many_requests`, `unavailable`), `unknown_tool_error`, or `null`. Raw provider bodies/messages, prompts, results, URLs, and credentials are never stored in these diagnostics. Every failure preserves existing saved/Tavily results.

Anthropic tool errors arrive inside HTTP 200 responses, so their `fallbackHttpStatus` remains `null`; actual HTTP 400/422 rejections retain their numeric status. `max_uses_exceeded` means this request hit its authorized cap, not API quota exhaustion or an invalid key/model. API/audit summaries include `anthropicSearchMaxUses`; the UI names the actual 1- or 3-search limit with a visibly separated status heading and message. Only for that error, a complete valid result object may still supply profiles through the same citation and acceptance checks below; the status stays `SEARCH_LIMITED`, even when profiles are retained. Missing/malformed output retains no fallback profiles, and any other tool error prevents salvage. The UI distinguishes partial results, failed searches, and completed searches with no qualified/new profiles. For a provider-reported unsupported/disabled search capability, an organization admin can check [Claude Console capabilities](https://platform.claude.com/settings/capabilities); a generic request/tool error does not establish a model or credential problem.

Every accepted object must be strict JSON whose canonical `sourceUrl` exactly matches a direct provider citation and passes the existing LinkedIn/approved-host, page-type, company, role, location, and STRONG/BROADER quality checks. Google redirect citation URLs are rejected rather than resolved or trusted. The prompt contains only public company aliases, role/topics, location, approved domains, and requested count; it never includes the user's profile, resume, email, drafts, personal context, or credentials.

Provider web search and model tokens may be billable. Gemini can execute multiple billable searches within its one API request; OpenAI bills web-search tool usage and tokens under the selected model. AI-action costs are adjacent to that action, including [official Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing#web-search-tool) when selected. Tavily-only Search/Retry show only the user's [Tavily API plan](https://docs.tavily.com/documentation/api-credits), without suggesting an AI charge. Availability and pricing can change, so users must confirm their selected model/account's capabilities and costs.

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

Set `$env:CONTACTS_PREVIEW_PORT = "8807"` in both preparation and browser-test
terminals to use a separate unused port instead of the default **8805**.
This reuses the tutorial's local-only preparation/serving patterns,
refuses an existing `.d1` database or occupied port, and never touches other
previews. Open `http://127.0.0.1:8805/__review/existing` for five fictional linked
contacts, or `/__review/second` for a separate account without keys or contacts.
The test-only `local-contacts-preview.ts` is not in production configuration:
it requires the loopback origin and review flag, blocks network egress,
provider/search/Google/CRM/draft/send/key actions at entry, and only permits
authenticated tutorial-progress writes. The browser test intercepts explicitly
requested Tavily/AI actions with fake results, checks desktop/phone priorities,
separate costs, consent reset, partial/error/duplicate merges, explicit retries,
refresh, account isolation and final-send cancellation.
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
