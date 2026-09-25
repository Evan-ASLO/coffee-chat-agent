# Coffee Chat Agent

A private, approval-first Google Apps Script application for finding relevant
professionals, preparing personalized outreach, sending through Gmail, and
tracking replies in Google Sheets.

The deployment hosts shared code, but every signed-in Google user receives an
isolated workspace owned by that user's Google account: a private Sheet, Gmail
authorization, scheduled reply trigger, personal context, settings, and API
keys. It does not depend on a Microsoft tenant or this Copilot session.

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
- API keys and webhook tokens are stored in Apps Script **User Properties** for
  the signed-in Google account, not in the spreadsheet, browser, or another
  user's property store.
- The web app runs as **User accessing the web app** and allows **Anyone with a
  Google account**. Each user must authorize their own Drive, Sheets, Gmail, and
  trigger access.
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
| `Drafting.gs` | Gemini, OpenAI, Anthropic, template, and custom drafting adapters |
| `GmailSync.gs` | Draft edits, approved sends, reply synchronization |
| `Http.gs` | Explicit JSON HTTP helpers |
| `Index.html` | Responsive approval dashboard |
| `appsscript.json` | Apps Script manifest and OAuth scopes |

## Deploy for isolated Google users

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

6. Select **Deploy > New deployment > Web app**:

   - Execute as: **User accessing the web app**
   - Who has access: **Anyone with a Google account**

7. Each user opens the deployment URL, authorizes the app, and selects
   **Initialize private workspace**. Initialization creates a Sheet and reply
   trigger in that user's account.

8. Under **Profile & connections**, that user enters their own name, personal
   context, provider choices, and API keys.

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

3. Deploy the web app as **User accessing the web app** with access for
   **Anyone with a Google account**.

4. Open the web app URL and initialize/configure each account separately.

### Option B: copy files manually

1. Open [script.new](https://script.new/) while signed in to the personal Google
   account that should own the agent.
2. Create one Apps Script file for every `.gs` file in this folder and one HTML
   file named `Index`.
3. Enable the manifest in **Project Settings**, then replace it with
   `appsscript.json`.
4. Deploy the web app using the settings above.

The first initialization by each user creates a spreadsheet named **Coffee Chat
Agent CRM** and that user's time-based `syncRepliesTrigger`.

### Upgrade an existing single-user deployment

Before changing an existing deployment from **Execute as me** to **User
accessing the web app**:

1. Upload the new code.
2. In the Apps Script editor, run `migrateLegacyOwnerToUserProperties` while
   signed in as the original owner.
3. Run `setupCoffeeChatAgent` once to seed any new settings.
4. Update the web-app deployment to **User accessing the web app** and
   **Anyone with a Google account**.
5. Run `clearLegacyScriptStorage` in the editor. This removes the old global
   Sheet ID and API keys after the owner copy is safely stored in User
   Properties.

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

- `TEMPLATE`: uses a deterministic personal template and requires no external
  AI provider. It keeps sender context to one short sentence and centers the
  recipient's public role/profile evidence.
- `GEMINI`: add the signed-in user's Gemini API key and model.
- `OPENAI`: add the signed-in user's OpenAI API key and model. The adapter uses
  the Responses API.
- `ANTHROPIC`: add the signed-in user's Anthropic API key and model. The adapter
  uses the Messages API.
- `CUSTOM_WEBHOOK`: configure a URL and optional bearer token.

All AI providers receive only the selected prospect's public evidence, the
signed-in user's supplied personal context, and drafting settings. The shared
prompt requires the opening and majority of the email to focus on the recipient
and limits sender background to one relevant sentence.

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

## Architecture and request flow

1. `doGet()` serves `Index.html`, a client-side dashboard that calls server
   functions through `google.script.run`.
2. `getAppState()` resolves the current Google user's User Properties. If no
   Sheet ID exists, the dashboard asks that user to initialize.
3. `setupCoffeeChatAgent()` creates that user's Sheet tabs, default settings,
   personal-context rows, and scheduled reply trigger.
4. `Discovery.gs` sends criteria to Tavily or a custom provider, normalizes
   public LinkedIn results, scores them, deduplicates them, and writes
   `DISCOVERED` rows.
5. The first approval changes a prospect to `CONTACT_APPROVED`, then
   `Enrichment.gs` asks Hunter or a custom provider for an email. A Hunter miss
   is recorded but does not block drafting.
6. `Drafting.gs` selects the user's configured adapter—template, Gemini,
   OpenAI, Anthropic, or webhook—and applies the same recipient-focused prompt
   and output validation.
7. The resulting `DRAFT_READY` row is editable. `GmailSync.gs` sends only after
   the second explicit confirmation, records Gmail message/thread IDs, and
   moves the row to `SENT`.
8. Each user's installable trigger scans only their sent Gmail threads and
   updates their own Sheet to `REPLIED` when a new incoming message appears.

Prospect statuses and `STATUS_TRANSITIONS` enforce the workflow server-side;
the UI is not trusted to skip approval states. User locks serialize mutations
within one Google account without blocking unrelated users.

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
- AI drafting sends selected public profile evidence and the user's supplied
  personal context to the provider that user selected. Use the built-in
  template if those fields should not leave Google Apps Script.
- A multi-user Apps Script deployment can show Google's unverified-app warning
  until the deployment's OAuth consent screen is verified. Only trusted users
  should proceed while the app remains unverified.
- You are responsible for complying with applicable anti-spam, privacy, and
  professional-conduct requirements.
