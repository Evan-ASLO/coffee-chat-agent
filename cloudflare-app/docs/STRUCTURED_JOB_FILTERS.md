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

LinkedIn remains primary. The Tavily request uses native `include_domains: ["linkedin.com"]` in `restrict` mode; query text contains no `site:` operator. A job-linked query ANDs company aliases with one OR group covering all priorities; recruiters need not be junior, and location is not a hard gate. Bio search adds team/bio/profile, not leadership terms. Tiers do not multiply provider invocations.

Job-linked acceptance requires a supported public person-specific source and current-employer evidence (an employment statement or intact indexed headline). Former/aspirational/wrong-employer results are rejected. Rank order is strict: (1) same-function employee with explicit junior evidence, (2) internship/new-grad recruiter with explicit remit, (3) other same-firm junior employee. A lower-tier score cannot outrank a higher tier. Senior/lead/director/VP titles cannot become junior from an analyst/associate keyword. Ambiguous seniority/function stays unconfirmed, apart from the three confident tiers. Ranking uses no age, photos or invented years and makes no claim of vacancy ownership.

In independent Networking, when a company is requested, the existing match-quality rules remain:

- **STRONG:** requested company plus an exact requested professional role/topic, relevance at least 55.
- **BROADER_COMPANY:** requested company plus a real professional title and either requested location evidence or hiring/talent/recruiting evidence, relevance at least 35.

Company-only profiles without role, location, or hiring relevance remain rejected, as do role-only results such as an academic machine-learning profile returned for a Lyft role. Independent searches without a company retain a lower but explicit evidence floor.

Match quality remains stored on the prospect. Job-link priorities/reasons/evidence are recomputed per job from saved source fields, not written as a global prospect rank; no new migration is needed. Existing links lacking current-role evidence remain unconfirmed. Broader company matches display **Broader company match — review role relevance**; no enrichment or drafting occurs until the user explicitly approves that person. Summaries also report qualified and unconfirmed job counts.

If LinkedIn produces too few accepted profiles, a second public-bio search accepts only person-specific pages on reviewed official company domains or `theorg.com`, with company/role/location evidence. Job, search, news, social-feed, and common data-broker pages are rejected.

Prospects deduplicate by LinkedIn URL when present and otherwise by canonical source URL. The UI identifies those links as **LinkedIn profile** or **Public profile**.

If the user explicitly selects one cited search provider (`GEMINI`, `OPENAI`, or `ANTHROPIC`) and has that provider's encrypted key, one bounded request may run only after Tavily returns fewer qualified people than requested (or fewer usable people for independent Networking). Gemini uses Interactions `google_search`; OpenAI uses Responses `web_search` with `filters.allowed_domains`; Anthropic uses Messages `web_search_20250305` with `allowed_domains` and request-scoped `max_uses: 1 | 3`. The server defaults missing authorization to 1 and rejects other values. Up to 3 requires the explicit cost acknowledgment in the search form and a separate Search action; it includes model-token charges to the user's own account and does not guarantee results. The configured provider model is used as-is: no provider chain, retry, or silent model substitution.

API/audit summaries carry a whitelisted `fallbackReason` and the authorized `anthropicSearchMaxUses`. A per-request `max_uses_exceeded` stays `SEARCH_LIMITED`, with the actual cap named in the UI, not quota exhaustion or a bad model/key; only complete JSON profiles passing citation/current-company checks can be retained as partial results. Other tool errors cannot supply fallback profiles. Failed searches are not evidence that no people exist. Search/Retry link official pricing; retry reopens the form without a provider call.

Every returned object must use a direct provider citation that exactly matches its canonical source URL and pass the same provenance and match-quality functions. Output without direct public citations—including Google redirect URLs—is rejected. Summary/audit fields include only selected provider, attempted/status/model, and returned/accepted counts.

Known employers may have a narrow discovery-hint record containing canonical search aliases, approved people/bio domains, and broad professional topics. For BMO, the Tavily fallback sends this native `include_domains` allowlist in `restrict` mode:

- `privatewealth.bmo.com`
- `privatewealth-insights.bmo.com`
- `bmo.com`
- vetted `theorg.com`

Exact subdomains remain explicit. Although a root allowlist entry may let the provider return subdomains, post-response validation accepts only reviewed hosts (plus `www.` for a reviewed root), so unreviewed sibling subdomains remain rejected. Discovery summaries expose aggregate counts and bounded diagnostics, never provider queries, URLs, credentials, or raw provider responses. Contact rows retain their validated public source and supporting evidence.
