const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const sourceFiles = fs
  .readdirSync(root)
  .filter((file) => file.endsWith('.gs'))
  .sort();

for (const file of sourceFiles) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  new vm.Script(source, { filename: file });
}

const html = fs.readFileSync(path.join(root, 'Index.html'), 'utf8');
const scriptBlocks = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/gi));
assert.equal(scriptBlocks.length, 1, 'Index.html should contain one executable script block.');
new vm.Script(scriptBlocks[0][1], { filename: 'Index.inline.js' });

const context = vm.createContext({
  console,
  Date,
  JSON,
  Math,
  Number,
  Object,
  Array,
  Set,
  String,
  RegExp,
  Error
});

for (const file of [
  'Constants.gs',
  'Repository.gs',
  'Discovery.gs',
  'Enrichment.gs',
  'Drafting.gs',
  'GmailSync.gs'
]) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, {
    filename: file
  });
}

const criteria = context.normalizeCriteria_({
  roles: 'Product Manager, Strategy',
  industries: 'Fintech',
  locations: 'Toronto',
  keywords: 'marketplace',
  count: 50
});
assert.equal(criteria.count, 20);
assert.deepEqual(Array.from(criteria.roles), ['Product Manager', 'Strategy']);

const parsed = context.parseLinkedInSearchTitle_(
  'Alex Chen - Director, Corporate Strategy - Example Co | LinkedIn'
);
assert.equal(parsed.fullName, 'Alex Chen');
assert.equal(parsed.title, 'Director, Corporate Strategy');
assert.equal(parsed.company, 'Example Co');

const score = context.scoreCandidate_(
  'Alex Chen is a Director in fintech strategy based in Toronto with marketplace experience.',
  criteria
);
assert.ok(score.score >= 75);
assert.ok(score.reasons.length >= 3);

assert.doesNotThrow(() => context.assertValidEmail_('alex@example.com'));
assert.throws(() => context.assertValidEmail_('not-an-email'));
assert.equal(
  context.normalizeLinkedInUrl_('http://ca.linkedin.com/in/alex-chen?trk=test'),
  'https://ca.linkedin.com/in/alex-chen'
);
assert.equal(context.normalizeLinkedInUrl_('javascript:alert(1)'), '');
assert.equal(context.normalizeHttpUrl_('https://example.com/profile'), 'https://example.com/profile');
assert.equal(context.sheetSafeValue_('=IMPORTXML("https://example.com")'), '\'=IMPORTXML("https://example.com")');
assert.equal(context.sheetSafeValue_('Normal text'), 'Normal text');
assert.equal(context.normalizeSettingValue_('DRAFT_PROVIDER', 'template'), 'TEMPLATE');
assert.equal(context.normalizeSettingValue_('DISCOVERY_PROVIDER', 'tavily'), 'TAVILY');
assert.throws(() => context.normalizeSettingValue_('EMAIL_WORD_LIMIT', '999'));

const hunterByCompany = context.buildHunterEmailFinderParams_(
  {
    firstName: 'Alex',
    lastName: 'Chen',
    company: 'Example Co',
    companyDomain: ''
  },
  'test-key'
);
assert.equal(hunterByCompany.company, 'Example Co');
assert.equal(hunterByCompany.first_name, 'Alex');

const hunterByLinkedIn = context.buildHunterEmailFinderParams_(
  {
    firstName: 'Alex',
    lastName: 'Chen',
    linkedinUrl: 'https://www.linkedin.com/in/alex-chen'
  },
  'test-key'
);
assert.equal(
  hunterByLinkedIn.linkedin_handle,
  'alex-chen'
);
assert.equal(hunterByLinkedIn.first_name, 'Alex');
assert.equal(hunterByLinkedIn.last_name, 'Chen');
assert.equal(
  context.extractLinkedInHandle_(
    'https://ca.linkedin.com/in/alex-chen?trk=profile'
  ),
  'alex-chen'
);
assert.equal(
  context.isHunterNotFoundError_(
    new Error(
      'Hunter Email Finder returned HTTP 404: {"errors":[{"id":"not_found"}]}'
    )
  ),
  true
);

const longContext = [
  {
    category: 'Experience to reference',
    content: Array.from({ length: 120 }, (_, index) => `experience${index}`).join(' ')
  },
  {
    category: 'Current goal',
    content: Array.from({ length: 80 }, (_, index) => `goal${index}`).join(' ')
  }
];
const templateDraft = context.draftWithTemplate_(
  {
    firstName: 'Alex',
    fullName: 'Alex Chen',
    title: 'Investor',
    company: 'Example Ventures'
  },
  longContext,
  {
    SENDER_NAME: 'Evan',
    OUTREACH_GOAL: 'Learn about venture capital.',
    EMAIL_WORD_LIMIT: '140'
  }
);
assert.ok(templateDraft.body.split(/\s+/).filter(Boolean).length <= 140);

const snippet = context.makeReplySnippet_(
  'Happy to chat next week.\n\nOn Friday, Person wrote:\n> Original message'
);
assert.equal(snippet, 'Happy to chat next week.');

const draft = context.validateDraft_(
  {
    subject: 'Coffee chat',
    body: 'Hi Alex,\n\nI would value learning about your path. Would you be open to a 15-minute conversation?\n\nBest,\nEvan',
    personalizationNotes: 'Used only supplied details.'
  },
  { EMAIL_WORD_LIMIT: '140' }
);
assert.equal(draft.subject, 'Coffee chat');
assert.ok(draft.wordCount > 0);

assert.ok(
  Array.from(context.APP.PROSPECT_HEADERS).includes('outreachObjective'),
  'Prospects must preserve the search-specific outreach objective.'
);

console.log(
  `Validated ${sourceFiles.length} Apps Script files, Index.html, and core normalization logic.`
);
