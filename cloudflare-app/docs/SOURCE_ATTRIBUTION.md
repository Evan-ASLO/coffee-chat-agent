# Job source attribution

## Adzuna

Any normalized job with `source === "adzuna"` must render a visible **Jobs by Adzuna** attribution on the same job card.

Implementation requirements:

- link target: `https://www.adzuna.ca/`;
- visible linked word: `Jobs`;
- linked official Adzuna logo;
- accessible link label: `Jobs by Adzuna`;
- logo alt text: `Adzuna`;
- minimum visible badge size: 116 × 23 CSS pixels; and
- attribution remains visible in public, saved, and application card views because they share the same card renderer.

The official first-party logo is self-hosted as `public/adzuna_logo.png` so the existing `img-src 'self'` Content Security Policy remains unchanged. Source receipt:

- origin: `https://developer.adzuna.com/images/adzuna_logo.png`
- original dimensions: 256 × 68
- file size: 2,117 bytes
- SHA-256: `8c9922fed56c285a1879be628c285f311164ca1af299a4ae95927c2c7ec7a8af`

The UI displays the normalized source label `Adzuna`; it never receives or renders an Adzuna application ID, API key, request signature, or other credential.

## Release gate

Do not enable Adzuna publishing credentials until:

1. the Cloudflare version containing this attribution is deployed;
2. an Adzuna fixture is visible in every job-card context;
3. the linked word and logo are at least 116 × 23 and keyboard accessible;
4. the Canadian target opens successfully in a normal user browser; and
5. the automated UI contract test passes.

If attribution cannot render, suppress Adzuna-sourced cards rather than displaying the advert without attribution.
