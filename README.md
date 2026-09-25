# Coffee Chat Agent

A private, approval-first Google Apps Script application for finding relevant
professionals, preparing personalized outreach, sending through Gmail, and
tracking replies in Google Sheets.

The application belongs to the personal Google account that deploys it. It does
not depend on a Microsoft tenant or this Copilot session after installation.

## What it does

1. Searches publicly indexed professional profile pages or calls your own
   discovery webhook.
2. Adds candidates to a Google Sheet and dashboard for approval.
3. After approval, optionally enriches a work email and creates a personalized
   draft using only personal facts you supplied.
4. Requires a second explicit approval before sending the exact email through
   Gmail.
5. Records the sent message and Gmail thread in the spreadsheet.
6. Checks sent threads on a scheduled trigger and updates the spreadsheet when
   a reply arrives.

## Approval and privacy guarantees

- The first approval gate controls which people may be enriched and drafted.
- The second approval gate controls the exact recipient, subject, and body that
  Gmail sends.
- There is no bulk-send action.
- The application does not scrape LinkedIn, log in to LinkedIn, or automate
  LinkedIn messages. Tavily discovery uses only publicly indexed search results.
- API keys and webhook tokens are stored in Apps Script Properties, not in the
  spreadsheet or browser.
- The web app should be deployed with access set to **Only myself**.
- Apps Script's native `GmailApp` service requires the full Gmail OAuth scope.
  This application uses it only to send an explicitly approved message, find
  the resulting thread, and inspect that tracked thread for replies.

## Project files

| File | Purpose |
|---|---|
| `Code.gs` | Web app entry point and client-facing API |
| `Constants.gs` | Data model, settings, status transitions, validation |
| `Setup.gs` | Spreadsheet creation, defaults, credentials, scheduled trigger |
| `Repository.gs` | Sheet reads, writes, deduplication, audit activity |
| `Discovery.gs` | Tavily search, legacy Google search, and custom discovery adapters |
| `Enrichment.gs` | Approval workflow, Hunter, and custom enrichment adapter |
| `Drafting.gs` | Gemini, built-in template, and custom drafting adapter |
| `GmailSync.gs` | Draft edits, approved sends, reply synchronization |
| `Http.gs` | Explicit JSON HTTP helpers |
| `Index.html` | Responsive approval dashboard |
| `appsscript.json` | Apps Script manifest and OAuth scopes |

## Install in a personal Google account

### Fastest setup

1. Clone the private repository:

   ```powershell
   git clone https://github.com/Evan-ASLO/coffee-chat-agent.git
   Set-Location coffee-chat-agent
   ```

2. Install and authorize the Google Apps Script CLI:

   ```powershell
   npm install --global @google/clasp
   clasp login
   ```

3. Create a blank standalone project at
   [script.google.com](https://script.google.com/), open **Project Settings**,
   and copy its Script ID.

4. Create a local `.clasp.json` file:

   ```json
   {
     "scriptId": "PASTE_YOUR_SCRIPT_ID",
     "rootDir": "."
   }
   ```

5. Upload and open the application:

   ```powershell
   clasp push
   clasp open
   ```

6. Run `setupCoffeeChatAgent` once in the Apps Script editor and approve the
   Google permissions.

7. Select **Deploy > New deployment > Web app**:

   - Execute as: **Me**
   - Who has access: **Only myself**

8. Open the deployment URL. Under **Profile & connections**, enter your name,
   personal context, Tavily API key, and Hunter API key.

### Option A: `clasp`

1. Install or invoke the Google Apps Script CLI:

   ```powershell
   npm install --global @google/clasp
   clasp login
   ```

2. From this directory, create a standalone Apps Script project:

   ```powershell
   clasp create --type standalone --title "Coffee Chat Agent"
   clasp push
   clasp open
   ```

3. In the Apps Script editor, run `setupCoffeeChatAgent` once and approve the
   requested Google permissions.

4. Select **Deploy > New deployment > Web app**:

   - Execute as: **Me**
   - Who has access: **Only myself**

5. Open the web app URL and complete **Profile & connections**.

### Option B: copy files manually

1. Open [script.new](https://script.new/) while signed in to the personal Google
   account that should own the agent.
2. Create one Apps Script file for every `.gs` file in this folder and one HTML
   file named `Index`.
3. Enable the manifest in **Project Settings**, then replace it with
   `appsscript.json`.
4. Run `setupCoffeeChatAgent`, approve permissions, and deploy the web app using
   the settings above.

The first setup run creates a spreadsheet named **Coffee Chat Agent CRM** and a
time-based trigger for `syncRepliesTrigger`.

## Configure your workflow

Open **Profile & connections** in the web app.

### Personal context

Enter factual details the drafting provider may use:

- background summary;
- current learning or career goal;
- specific projects, jobs, courses, or experiences;
- genuine interests;
- preferred tone;
- one sample email that sounds like you.

Drafting is blocked until at least one factual context field is present. The
prompt prohibits invented experiences, shared connections, achievements, and
claims about content that was not supplied.

### Discovery providers

#### Tavily

Tavily is the default because Google no longer accepts new Custom Search JSON
API customers. Create a free account at [Tavily](https://app.tavily.com), then
paste its API key into **Profile & connections**. Tavily currently includes
1,000 free API credits each month without requiring a credit card.

Searches use the basic one-credit mode and add a LinkedIn profile restriction
to the query. The application then rejects every result that is not a valid
public `linkedin.com/in/` URL and reads only the returned title, URL, and public
content snippet.

#### Custom webhook

Set `DISCOVERY_PROVIDER` to `CUSTOM_WEBHOOK` and configure its URL and optional
bearer token.

Request:

```json
{
  "action": "discover",
  "criteria": {
    "roles": ["Product Manager"],
    "industries": ["Fintech"],
    "companies": [],
    "locations": ["Toronto"],
    "keywords": ["marketplace"],
    "seniority": ["Director"],
    "objective": "Learn how leaders moved from finance into product.",
    "count": 10
  },
  "requestedCount": 10
}
```

Return either an array or `{ "people": [...] }`. Supported person fields:

```json
{
  "firstName": "Alex",
  "lastName": "Chen",
  "fullName": "Alex Chen",
  "title": "Director, Product",
  "company": "Example Co",
  "companyDomain": "example.com",
  "location": "Toronto",
  "linkedinUrl": "https://www.linkedin.com/in/example",
  "email": "",
  "emailConfidence": 0,
  "sourceUrl": "https://www.linkedin.com/in/example",
  "sourceSnippet": "Public search snippet",
  "whyRelevant": "Relevant product and fintech background",
  "relevanceScore": 90
}
```

### Email enrichment providers

- `NONE`: enter an email manually during draft review.
- `HUNTER`: the default. Create a
  [free Hunter account](https://hunter.io/users/sign_up), copy the key from
  [Hunter API Keys](https://hunter.io/api-keys), and paste it into **Profile &
  connections**. The adapter calls Hunter Email Finder using the approved name
  and company domain/name when available, otherwise it uses the approved public
  LinkedIn profile handle with the person's first and last name. Free-plan
  quotas are controlled by Hunter and may change.
- When Hunter has no matching profile, preparation continues without an email;
  the draft review screen displays **Email needed** so you can add a verified
  address manually. The agent never guesses an email address.
- `CUSTOM_WEBHOOK`: configure a URL and optional bearer token.

Custom enrichment request:

```json
{
  "action": "enrich",
  "person": {
    "id": "uuid",
    "firstName": "Alex",
    "lastName": "Chen",
    "company": "Example Co",
    "companyDomain": "example.com",
    "linkedinUrl": "https://www.linkedin.com/in/example"
  }
}
```

Return the enriched object directly or under a `person` property:

```json
{
  "email": "alex@example.com",
  "emailConfidence": 95,
  "companyDomain": "example.com",
  "linkedinUrl": "https://www.linkedin.com/in/example"
}
```

### Draft providers

- `GEMINI`: add a Gemini API key and select a compatible model.
- `TEMPLATE`: uses a deterministic personal template and requires no external
  AI provider.
- `CUSTOM_WEBHOOK`: configure a URL and optional bearer token.

Custom draft request:

```json
{
  "action": "draft",
  "person": {
    "fullName": "Alex Chen",
    "title": "Director, Product",
    "company": "Example Co",
    "sourceSnippet": "Public search snippet",
    "whyRelevant": "Relevant product and fintech background"
  },
  "senderContext": [
    {
      "category": "Experience to reference",
      "content": "I worked on a student fintech product..."
    }
  ],
  "settings": {
    "senderName": "Evan",
    "outreachGoal": "Learn about product leadership",
    "emailWordLimit": "140"
  }
}
```

Return the draft directly or under a `draft` property:

```json
{
  "subject": "Learning about your product path",
  "body": "Hi Alex, ...",
  "personalizationNotes": "Used the supplied fintech project and Alex's role."
}
```

## Spreadsheet data

- **Prospects** is the CRM and includes approval timestamps, source evidence,
  draft content, sent timestamps, Gmail IDs, and the latest reply.
- **Personal Context** stores the factual inputs used for personalization.
- **Settings** stores non-secret configuration.
- **Activity** is an append-only audit trail of important workflow actions.

Reply synchronization checks only messages sent by this application within the
configured lookback window. It updates `status`, `lastReplyAt`, `replyFrom`, and
`replySnippet`; it does not automatically respond.

## Validation

Run the dependency-free checks locally:

```powershell
npm test
```

They parse every Apps Script file and the dashboard JavaScript, then exercise
criteria normalization, public-result parsing, relevance scoring, email
validation, reply extraction, and draft validation.

## Operational limits

- Public search snippets can be incomplete or stale; review the linked profile
  before approval.
- Automatic email discovery requires Hunter or a custom enrichment provider.
- Gmail and Apps Script quotas apply.
- Gemini drafting sends the selected public profile evidence and your supplied
  personal context to the Gemini API. Use the built-in template if you do not
  want those fields sent to an AI provider.
- You are responsible for complying with applicable anti-spam, privacy, and
  professional-conduct requirements.
