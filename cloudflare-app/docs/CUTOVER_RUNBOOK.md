# Cutover runbook

## Preconditions

- Seven-day criteria pass.
- The target Worker version, tracker commit, current hash/count, D1 migration list, Vercel fallback URL, old/new OAuth callback URLs, and DNS values are recorded.
- `ENABLE_JOB_OUTREACH_LINKING=false`.
- Monitoring and rollback owners are online.
- The broad-launch resume decision is recorded; private-beta acceptance alone is not approval for unrestricted public uploads.

## T-24 hours: backup and restore evidence

Cloudflare Operator:

1. Capture a D1 Time Travel bookmark:

   ```powershell
   npx wrangler d1 time-travel info coffee-chat-agent --timestamp "<RFC3339-UTC>" --json
   ```

2. Create a restricted manual export:

   ```powershell
   npx wrangler d1 export coffee-chat-agent --remote --output ".\backups\coffee-chat-agent-pre-cutover-<UTC>.sql"
   ```

3. Store the export in approved encrypted storage; do not commit it.
4. Restore the export into a new disposable local persistence directory:

   ```powershell
   npx wrangler d1 execute coffee-chat-agent --local --persist-to "<DISPOSABLE_DIRECTORY>" --file ".\backups\coffee-chat-agent-pre-cutover-<UTC>.sql"
   ```

   Verify users, job counts, states, prospects, links, encrypted credential metadata, and resume metadata.
5. Rehearse the Time Travel restore approval path. Do not run a production restore during rehearsal.

## T-2 hours

- Tracker Operator confirms dual publishing and exact hash/count equality.
- Cloudflare Operator confirms catalog age below 90 minutes, no DLQ messages, normal 2xx/4xx/5xx rates, and no sustained ingest 429s.
- OAuth Owner confirms both the old/Vercel and new Cloudflare callback URLs remain registered.
- Support Observer completes signed-out browsing and signed-in save/application smoke tests.
- Release Lead freezes unrelated changes.

## Cutover sequence

1. Deploy the approved Worker version and apply only the reviewed D1 migrations.
2. Confirm Worker health, public jobs, freshness metadata, login, and private APIs before changing traffic.
3. Keep dual publishing active.
4. Update the public domain/DNS or routing from Vercel to Cloudflare using the recorded values.
5. Keep the Vercel fallback deployed and reachable; do not delete its project or OAuth callback.
6. Run public browsing, login, save/application, Gmail/Sheets, and support smoke tests.
7. Observe the thresholds in [MONITORING_CONFIG.md](MONITORING_CONFIG.md) continuously for the first hour and at least hourly for the next 24 hours.
8. Enable job-linked outreach only as a separate change after catalog stability is accepted:

   ```text
   ENABLE_JOB_OUTREACH_LINKING=true
   ```

## OAuth transition rule

Registering an additional authorized redirect URI does not inherently invalidate existing refresh tokens. Keep both old and new callback URIs during transition. Existing tokens remain tied to their OAuth client/user grant; switching to a different client ID requires users to connect under that client.

## Stop conditions

Pause cutover and follow [ROLLBACK_PROCEDURE.md](ROLLBACK_PROCEDURE.md) for:

- hash/count divergence;
- catalog age of two hours;
- cross-user access;
- OAuth callback/login failure for existing users;
- send/Sheet corruption;
- D1 corruption or missing state;
- sustained 5xx above the monitoring threshold; or
- an unapproved broad-launch resume exposure.
