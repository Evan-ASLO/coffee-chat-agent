# Structured job filters

Migration `0005_structured_job_filters.sql` adds nullable derived fields to `jobs` and `job_import_stage` for industry, explicit duration options/min/max, and internship season/year. The tracker wire contract is unchanged.

## Deterministic derivation

The Worker derives values during signed snapshot ingestion without AI or external classification services.

### Industry

Supported display labels:

- Banking & Financial Services
- Insurance
- Technology
- Consulting & Professional Services
- Consumer & Retail
- Industrial & Manufacturing
- Healthcare & Life Sciences
- Government & Nonprofit
- Other

Classification uses a narrow normalized alias map for known employers, followed by conservative company and strong context keywords. A clearly insurance-specific title (for example actuarial, underwriting, claims, or insurance) may override a bank's broader sector. Generic titles such as `Finance Intern` do not make an unknown employer a financial-services company.

Limitations: this is an operational browsing aid, not an authoritative corporate taxonomy. Acquisitions, conglomerates, and ambiguous employers may remain `Other` until a reviewed alias is added.

### Length

The parser reads the title first, then the description only when the title has no explicit numeric month expression. It supports forms such as:

- `4 months`
- `8-month`
- `4 or 8 months`
- `12-16 Months`

It stores exact parsed options plus min/max. It does not infer from calendar dates, season names, word-only numbers, or vague phrases. More than four conflicting explicit values are treated as unknown. API filtering uses the exact options array, so a `4-8 month` expression matches 4 and 8, not every integer between them.

### Term

The parser reads title first and description second for one unambiguous season/year pair:

- Winter, Spring, Summer, Fall, or Autumn
- two- or four-digit years, normalized into 2000-2099

Autumn normalizes to Fall. It never infers a term from the posting date. Multiple different season/year pairs in the same higher-priority text are left unknown.

## API

`GET /api/jobs` retains `q`, `company`, `location`, `region`, and `category` (Career Track) and adds:

- `industry=<display label>`
- `length=<1..24|UNSPECIFIED>`
- `term=<WINTER|SPRING|SUMMER|FALL>-<20xx>|UNSPECIFIED`

All filters are parameterized and applied in D1 before count, pagination, and row retrieval. Facet counts apply the other active filters while omitting their own dimension.

Responses expose:

- `industry`
- `lengthMonths`
- `lengthLabel`
- `term: { season, year, label }`
- safe `facets.industries`, `facets.lengths`, and `facets.terms`

Storage JSON/min/max columns are not exposed.

## Migration and production refresh

Migration 0005 leaves existing rows nullable/empty for backward compatibility. After applying it and deploying the matching Worker:

1. trigger the normal tracker snapshot workflow;
2. do not drop the catalog or use an override;
3. the publisher supplies a later `generatedAt`, even when canonical job content/hash repeats;
4. active-catalog semantics create a new import run and repopulate every derived field; and
5. verify active count, facets, null counts, and combination filters.

Do not treat the migration alone as a backfill.

## Job-linked discovery

**People to contact** opens saved, user-owned job contacts without paid provider activity. The separate cost-disclosed search form uses server-derived job criteria: employer aliases (for example `bmo` → `BMO Financial Group`), junior role peers, campus/university/early-career recruiters, and other junior employees. It does not target hiring managers or senior staff. The server ignores submitted employer/role overrides for a linked search. General Networking without `jobId` retains its independent criteria.

The first Tavily pass searches the broader public web, including LinkedIn and individual professional biographies; it does not set `include_domains`. It combines the alternative source clues `(site:linkedin.com/in OR biography OR profile)` with space-separated criterion groups, rather than imposing a LinkedIn-only site restriction. If fewer than the requested number of reviewable candidates are found, the second Tavily pass uses a distinct, person-focused public-bio query. A job-linked first query combines company aliases with one OR group covering all priorities; recruiters need not be junior, and location is not a hard gate. Bio search adds team/bio/profile, not leadership terms. Tiers do not multiply provider invocations.

Job-linked candidates need an identifiable individual and safe public professional source. Confirmed tiers require evidence of current employment (an employment statement or intact indexed headline); former/aspirational/wrong-employer results can remain visible for review but never fill a confirmed tier. Rank order is strict: (1) same-function employee with explicit junior evidence, (2) internship/new-grad recruiter with explicit remit, (3) other same-firm junior employee. A lower-tier score cannot outrank a higher tier. Senior/lead/director/VP titles cannot become junior from an analyst/associate keyword. Ambiguous seniority/function stays unconfirmed. Ranking uses no age, photos or invented years and makes no claim of vacancy ownership.

In independent Networking, a requested company influences evidence-based ranking, not whether a plausible public professional can be shown:

- **STRONG:** evidenced requested employer and role with a sufficient relevance score; public bios additionally require an official employer or The Org source.
- **BROADER_COMPANY:** the stored name for possible/uncertain people, even if employer or role is unconfirmed or different; the name is not proof they work at that company.

Unsafe or non-person pages and results without an identifiable person or professional evidence remain rejected. Missing employer, title and location are never invented.

Match quality remains stored on the prospect. Job-link priorities/reasons/evidence are recomputed per job from saved source fields, not written as a global prospect rank; no new migration is needed. Existing links lacking current-role evidence remain unconfirmed. Possible matches require identity, employer and role review; no enrichment or drafting occurs until the user explicitly approves that person. Summaries also report qualified and unconfirmed job counts.

The optional second public-bio pass is not restricted to official employer domains or `theorg.com`. Both passes apply the same safe URL normalization and person-specific validation to non-LinkedIn results. Job, search, news, social-feed and common data-broker pages are rejected.

Prospects deduplicate by LinkedIn URL when present and otherwise by canonical source URL. The UI identifies those links as **LinkedIn profile** or **Public profile**.

Search and ordinary Retry are Tavily-only regardless of result count or error. `POST /api/discovery` defaults missing `mode` to `TAVILY`; invalid modes are rejected. Only the separate **Find more with AI** action sends `mode: "AI_SUPPLEMENT"`. It uses the selected cited search provider (`GEMINI`, `OPENAI`, or `ANTHROPIC`), its encrypted key and saved model, without calling Tavily or reading its credential. Selecting a provider alone never authorizes a call. The stored preference is preserved.

Gemini uses Interactions `google_search`; OpenAI uses Responses `web_search` with `filters.allowed_domains`; Anthropic uses Messages `web_search_20250305` with `allowed_domains` and request-scoped `max_uses: 1 | 3`. The server defaults missing authorization to 1 and rejects other values. Up to 3 requires fresh, unchecked-by-default cost acknowledgment beside the AI action; it includes model-token charges to the user's own account and does not guarantee new people. Each AI click makes at most one selected-provider invocation for all tiers, accepting at most 10 candidates and no more than the requested count. AI failure, empty and duplicate results preserve saved/Tavily contacts; new results merge and retain job-specific ranking and links. No provider chain, automatic AI retry/top-up, or silent model substitution occurs.

API/audit summaries retain the existing `DISCOVERY_COMPLETED` event, aggregate counts, whitelisted `fallbackReason` and authorized `anthropicSearchMaxUses`, adding `mode` and `tavilyAttempted`. Tavily-only reports `NOT_REQUESTED` for AI; AI-only reports zero Tavily-stage counts. A per-request `max_uses_exceeded` stays `SEARCH_LIMITED`, with the actual cap named in the UI, not quota exhaustion or a bad model/key; only complete JSON profiles passing citation/current-company checks can be retained as partial results. Other tool errors cannot supply AI profiles. Failed searches are not evidence that no people exist. Tavily Retry reopens its form without a provider call; Retry with AI requires a new explicit action and defaults consent back to 1.

Every returned object must use a direct provider citation that exactly matches its canonical source URL and pass the same provenance and match-quality functions. Output without direct public citations—including Google redirect URLs—is rejected. Summary/audit fields include only selected provider, attempted/status/model, and returned/accepted counts.

Known employers may have discovery hints containing canonical search aliases, official people/bio domains and broad professional topics. BMO's known profile domains include:

- `privatewealth.bmo.com`
- `privatewealth-insights.bmo.com`
- `bmo.com`
- vetted `theorg.com`

These domains can strengthen a match; they do not restrict Tavily's search or constitute an acceptance allowlist. Discovery summaries expose aggregate counts and bounded diagnostics, never provider queries, URLs, credentials, or raw provider responses. Contact rows retain their validated public source and supporting evidence.
