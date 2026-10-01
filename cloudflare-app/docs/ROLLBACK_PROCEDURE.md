# Rollback procedure

## Roles and authority

- Release Lead declares rollback.
- Cloudflare Operator handles Worker, D1, domain/DNS, and feature flags.
- Tracker Operator pauses or redirects publishing.
- OAuth Owner maintains callback continuity.
- Support Observer validates the fallback and communicates status.

## Immediate containment

1. Set or keep `ENABLE_JOB_OUTREACH_LINKING=false`.
2. Keep `BETA_ACCESS_MODE=ALLOWLIST` and the approved `BETA_ADMIN_EMAILS` while the beta is active. Removing or misspelling the mode intentionally falls back to `OPEN`.
3. Pause scheduled tracker publishing if ingestion/catalog correctness is in doubt.
4. Preserve logs, current Worker version ID, current hash/count, D1 bookmark, and incident timestamps.
5. Do not rotate secrets unless compromise is suspected; unnecessary rotation can complicate recovery.

## Application/traffic rollback

1. Roll back to the exact approved **gated** Worker version when the fault is Worker code and D1 data is sound. A pre-beta-gate Worker does not understand `BETA_ACCESS_MODE` and would expose the open public experience.
2. For public routing failure, restore the recorded domain/DNS route to the still-deployed Vercel fallback.
3. Keep both old and new Google OAuth callbacks registered so either route can complete login during the rollback window.
4. Verify Vercel browsing, old callback login, and any supported legacy state behavior before declaring traffic restored.
5. Keep the Cloudflare Worker available on its direct URL for diagnosis unless security requires disabling it.

If only a pre-gate Worker is available, route traffic to the approved Vercel/private fallback or add a Cloudflare Access/edge restriction before deploying it.

## D1 rollback

Use D1 restore only for confirmed data corruption, not ordinary code bugs.

1. Stop writes: pause publisher, disable job linking, and if necessary route users to Vercel.
2. Compare current data with the pre-cutover manual export and Time Travel bookmark.
3. Release Lead and Cloudflare Operator approve the restore point.
4. Preview bookmark information:

   ```powershell
   npx wrangler d1 time-travel info coffee-chat-agent --timestamp "<RFC3339-UTC>" --json
   ```

5. Restore only after approval:

   ```powershell
   npx wrangler d1 time-travel restore coffee-chat-agent --bookmark "<APPROVED_BOOKMARK>" --json
   ```

6. If Time Travel is unavailable or inappropriate, restore the approved manual export using the documented D1 import process after a non-production rehearsal.
7. Re-run user counts, active job count/hash, state counts, cross-user isolation, encrypted credential metadata, resume metadata, and prospect/link integrity checks.

## Reconciliation and reopen

- Republish one known-good current snapshot and compare hash/count.
- Reconcile any application-state writes made after the restore point from audit evidence; never copy another user's data.
- Validate OAuth, Gmail send/read, Sheets, resume, and public jobs.
- Resume dual publishing before another cutover attempt.
- Restart the seven-day clock for data, auth, schema, or routing failures listed in [PARALLEL_RUN_CRITERIA.md](PARALLEL_RUN_CRITERIA.md).
