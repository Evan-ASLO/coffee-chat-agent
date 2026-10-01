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

Job cards expose server-derived networking criteria. Known employer display aliases (for example `bmo` → `BMO Financial Group`) and title topics produce a small OR group of team/professional roles, followed by Hiring Manager, Talent Acquisition, and Recruiter. The full noisy job title stays in the outreach objective for personalization and is not used as one hard search keyword.

LinkedIn remains primary. The Tavily request uses native `include_domains: ["linkedin.com"]` in `restrict` mode; the query text contains no `site:` operator. For company-linked searches it ANDs one company-alias OR group, one combined professional-role/topic OR group, and optional location/seniority groups. It does not hard-AND the broad industry label or the full internship title.

Primary LinkedIn acceptance is stricter than retrieval: when a company is requested, evidence must match both the requested company and at least one requested professional role/topic, with a relevance floor. This rejects company-only, role-only, and unrelated profiles such as an academic machine-learning profile returned for a Lyft role. Independent searches without a company retain a lower but explicit evidence floor.

If LinkedIn produces too few accepted profiles, a second public-bio search accepts only person-specific pages on reviewed official company domains or `theorg.com`, with company/role/location evidence. Job, search, news, social-feed, and common data-broker pages are rejected.

Prospects deduplicate by LinkedIn URL when present and otherwise by canonical source URL. The UI identifies those links as **LinkedIn profile** or **Public profile**.

Known employers may have a narrow discovery-hint record containing canonical search aliases, approved people/bio domains, and broad professional topics. For BMO, the Tavily fallback sends this native `include_domains` allowlist in `restrict` mode:

- `privatewealth.bmo.com`
- `privatewealth-insights.bmo.com`
- `bmo.com`
- vetted `theorg.com`

The semantic query contains BMO/Bank of Montreal aliases, Toronto/location terms, investment/portfolio/wealth/talent topics, and team/bio/profile/leadership alternatives; it contains no brittle `site:` operators. Exact subdomains remain explicit. Although the root `bmo.com` allowlist entry may let the provider return subdomains, post-response validation accepts only the exact reviewed hosts (plus `www.` for a reviewed root), so unreviewed sibling subdomains remain rejected. Discovery summaries expose only aggregate primary/fallback candidate and accepted counts plus inserted/duplicate/rejected counts; they never expose provider queries, URLs, credentials, or raw provider responses.
