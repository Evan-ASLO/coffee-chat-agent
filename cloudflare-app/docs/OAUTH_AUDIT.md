# Google OAuth audit

## Current flows

### Basic login

Requested scopes:

- `openid`
- `email`
- `profile`

This flow creates the application session. It must not request Gmail, Drive, or Sheets permissions.

In allowlist mode, the verified Google identity is checked before the normal user record and session are created. An unapproved login creates/refreshes a pending beta request and receives the same neutral confirmation as the explicit **Request access** flow.

### Request access

`/auth/google/request` uses the same basic identity scopes, PKCE, state, and nonce validation. It records only normalized verified email, Google subject, status, and timestamps. It does not accept an unverified email form and does not issue a normal session.

### Incremental Google connect

Requested scopes:

- `openid`
- `email`
- `profile`
- `https://www.googleapis.com/auth/gmail.send`
- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/drive.file`
- `https://www.googleapis.com/auth/spreadsheets`

The application uses PKCE, nonce/state validation, `include_granted_scopes=true`, `access_type=offline`, and explicit consent for connect.

## Redirect URI transition

Audit the Google OAuth client and record the exact values for:

- the existing Vercel/fallback callback; and
- `${APP_ORIGIN}/auth/google/callback` for the Cloudflare deployment.

Keep both authorized during the parallel run, cutover, and rollback window. Adding a redirect URI does **not** inherently invalidate existing refresh tokens. Refresh tokens may stop working after user revocation, OAuth client/grant changes, provider policy/security actions, or other Google token lifecycle events. If the Cloudflare deployment uses a different OAuth client ID, old-client refresh tokens are not portable and users must connect under the new client.

## Audit checks

- [ ] Production and preview origins use HTTPS.
- [ ] Redirect URIs are exact; no wildcard or unowned origin is present.
- [ ] Basic login and incremental connect use the intended scopes above.
- [ ] The connected Google identity must equal the signed-in session identity.
- [ ] Allowlist/admin authorization occurs only after verified Google identity and before user/session creation.
- [ ] Refresh tokens remain encrypted and are never returned to the browser or logs.
- [ ] Gmail sends require exact-draft approval and idempotency.
- [ ] Drive access remains `drive.file`, not broad Drive access.
- [ ] Reply sync is limited to sent/replied prospects and the configured time window.
- [ ] Old and new callbacks are tested before DNS changes and retained through rollback acceptance.
- [ ] Consent-screen branding, privacy URL, terms URL, support email, and verified domains match the launch domain.

## Evidence

The OAuth Owner records client ID (not secret), callback list, consent-screen status, scope list, test-account results, and token continuity result. Never record the client secret, authorization codes, access tokens, or refresh tokens.
