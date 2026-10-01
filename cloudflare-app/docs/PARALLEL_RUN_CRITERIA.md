# Seven-day parallel-run criteria

Run the tracker against the existing Vercel experience and the Cloudflare ingestion endpoint for seven consecutive 24-hour periods before cutover. Keep `ENABLE_JOB_OUTREACH_LINKING=false` throughout. Keep the Cloudflare site in `BETA_ACCESS_MODE=ALLOWLIST` with only approved test/beta accounts.

## Evidence collected for every scheduled publisher run

The Tracker Operator records:

- canonical `snapshotHash`;
- normalized job count;
- `generatedAt`;
- result and duration for the existing/Vercel publish;
- Cloudflare HTTP status, `importRunId`, `idempotent`, active/upserted/deactivated counts; and
- `/api/jobs` catalog state, generated time, import time, and age.

## Required pass criteria

1. **Exact content agreement:** every paired publish uses the same canonical hash and count. Any unexplained mismatch fails the run.
2. **Ingestion reliability:** every Cloudflare publish succeeds on the first request or one bounded retry. Any failure not cleared within 15 minutes fails the day.
3. **Freshness:** the public catalog never reaches two hours old. A warning at 90 minutes requires investigation; a two-hour stale state fails the day.
4. **Identity stability:** job ID changes correspond only to documented normalization/source identity changes. No order-derived IDs are allowed.
5. **Catalog recovery:** at least once in non-production validation, A → B → A reactivates A-only jobs.
6. **Isolation:** automated cross-user tests pass daily in CI; one manual two-account check passes at the start and end of the seven-day period.
7. **Application tracking:** save, apply, interview, offer/reject, archive, delete, and one-time import flows preserve ownership and existing states.
8. **Coffee Chat:** basic login, incremental Google connect, Sheet creation/update, one approved test send, reply sync, and encrypted resume smoke tests pass at the start and end.
9. **Beta gate:** request, approve, deny, revoke, re-approve, admin override, neutral confirmation, and active-session revocation checks pass at the start and end; jobs never leak to a signed-out allowlist-mode request.
10. **Operations:** no dead-letter queue messages, unexplained D1 errors, secret/body logging, or repeated ingest rate-limit events.
11. **Rollback readiness:** a non-production restore drill and DNS/Vercel rollback walkthrough are completed before day seven closes.

## Clock reset rules

Restart the seven-day clock after:

- a schema or canonicalization change;
- unexplained hash/count divergence;
- catalog staleness of two hours or more;
- cross-user isolation failure;
- data loss/corruption;
- OAuth callback or token regression affecting existing users; or
- a production-path change to ingestion, auth, persistence, or rollback.

A short provider outage does not automatically reset the clock only when both paths fail for the same external reason, no data diverges, and service recovers inside the 15-minute ingestion objective.

## Exit decision

The Release Lead may approve cutover only when all seven daily evidence sets pass and the Tracker Operator, Cloudflare Operator, OAuth Owner, and Privacy/Security Reviewer sign off by role. Job-linked outreach remains disabled until the stable catalog criteria pass; enabling it is a separate recorded decision.
