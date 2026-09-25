const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(__dirname, 'preview.generated.html');
const source = fs.readFileSync(path.join(root, 'Index.html'), 'utf8');

const now = new Date();
const minutesAgo = (minutes) => new Date(now.getTime() - minutes * 60 * 1000).toISOString();
const daysAgo = (days) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

const state = {
  appName: 'Coffee Chat Agent',
  version: '1.0.0',
  setupRequired: false,
  accountEmail: 'you@gmail.com',
  spreadsheetUrl: 'https://docs.google.com/spreadsheets/',
  settings: {
    DISCOVERY_PROVIDER: 'GOOGLE_CSE',
    ENRICHMENT_PROVIDER: 'NONE',
    DRAFT_PROVIDER: 'GEMINI',
    GEMINI_MODEL: 'gemini-2.5-flash',
    MAX_DISCOVERY_RESULTS: '15',
    EMAIL_WORD_LIMIT: '140',
    SENDER_NAME: 'Evan',
    OUTREACH_GOAL: 'Learn about career transitions into product and strategy.',
    REPLY_LOOKBACK_DAYS: '60',
    SYNC_INTERVAL_MINUTES: '15'
  },
  personalContext: [
    {
      category: 'Background summary',
      content: 'I am a business student interested in technology, finance, and product strategy.'
    },
    {
      category: 'Experience to reference',
      content: 'I recently worked on a student project evaluating a fintech product launch.'
    },
    {
      category: 'Tone',
      content: 'Warm, concise, curious, and respectful.'
    }
  ],
  lastCriteria: {
    roles: ['Product Manager', 'Corporate Strategy'],
    industries: ['Fintech'],
    companies: [],
    locations: ['Toronto'],
    keywords: ['marketplace'],
    seniority: ['Director'],
    objective: 'Learn how leaders moved from finance into product.',
    count: 10
  },
  secretConfiguration: {
    GOOGLE_CSE_API_KEY: true,
    GOOGLE_CSE_ID: true,
    GEMINI_API_KEY: true,
    DISCOVERY_WEBHOOK_URL: false,
    DISCOVERY_WEBHOOK_TOKEN: false,
    ENRICHMENT_WEBHOOK_URL: false,
    ENRICHMENT_WEBHOOK_TOKEN: false,
    DRAFT_WEBHOOK_URL: false,
    DRAFT_WEBHOOK_TOKEN: false,
    HUNTER_API_KEY: false
  },
  prospects: [
    {
      id: 'preview-discovered',
      status: 'DISCOVERED',
      fullName: 'Maya Patel',
      firstName: 'Maya',
      title: 'Director, Product Strategy',
      company: 'Northstar Financial',
      location: 'Toronto',
      linkedinUrl: 'https://www.linkedin.com/in/maya-patel',
      sourceUrl: 'https://www.linkedin.com/in/maya-patel',
      sourceSnippet: 'Director focused on fintech product strategy and marketplace growth.',
      whyRelevant: 'Matched role: Product Manager; Matched industry: Fintech',
      relevanceScore: 90,
      updatedAt: minutesAgo(8)
    },
    {
      id: 'preview-draft',
      status: 'DRAFT_READY',
      fullName: 'Daniel Kim',
      firstName: 'Daniel',
      title: 'VP, Corporate Strategy',
      company: 'Example Labs',
      linkedinUrl: 'https://www.linkedin.com/in/daniel-kim',
      email: 'daniel@example.com',
      emailConfidence: 94,
      subject: 'Learning about your path into strategy',
      draftBody:
        'Hi Daniel,\n\nI am a business student interested in technology and strategy, and I recently worked on a fintech product launch project. Your path into corporate strategy stood out to me. Would you be open to a 15-20 minute coffee chat in the next few weeks?\n\nBest,\nEvan',
      personalizationNotes:
        'Used the supplied fintech project and Daniel\'s public role in corporate strategy.',
      updatedAt: minutesAgo(22)
    },
    {
      id: 'preview-sent',
      status: 'SENT',
      fullName: 'Avery Singh',
      title: 'Senior Product Manager',
      company: 'Orbit',
      linkedinUrl: 'https://www.linkedin.com/in/avery-singh',
      email: 'avery@example.com',
      subject: 'Learning about product at Orbit',
      sentAt: daysAgo(2),
      updatedAt: daysAgo(2)
    },
    {
      id: 'preview-replied',
      status: 'REPLIED',
      fullName: 'Jordan Lee',
      title: 'Partner',
      company: 'Harbour Ventures',
      linkedinUrl: 'https://www.linkedin.com/in/jordan-lee',
      email: 'jordan@example.com',
      subject: 'Coffee chat request',
      sentAt: daysAgo(5),
      lastReplyAt: minutesAgo(75),
      replySnippet: 'Happy to chat. Tuesday afternoon could work for me.',
      updatedAt: minutesAgo(75)
    }
  ],
  summary: {
    total: 4,
    awaitingDraftApproval: 1,
    awaitingReply: 1,
    replied: 1,
    byStatus: {
      DISCOVERED: 1,
      DRAFT_READY: 1,
      SENT: 1,
      REPLIED: 1
    }
  }
};

const mock = `
  <script>
    (() => {
      const previewState = ${JSON.stringify(state)};
      const methods = {
        getAppState: () => previewState,
        syncRepliesNow: () => ({ checked: 2, updated: 0, errors: [] }),
        saveProspectEdits: () => ({}),
        sendProspectEmail: () => ({}),
        saveConfiguration: () => previewState,
        clearConfiguredSecret: () => previewState,
        discoverProspects: () => ({ inserted: 1, duplicatesSkipped: 0 }),
        addManualProspect: () => ({}),
        approveAndPrepareProspects: () => ({ succeeded: 1, failed: 0 }),
        rejectProspects: () => [],
        initializeAgent: () => previewState
      };
      let successHandler = () => {};
      let failureHandler = () => {};
      const runner = new Proxy({}, {
        get(_target, property) {
          if (property === 'withSuccessHandler') {
            return (handler) => {
              successHandler = handler;
              return runner;
            };
          }
          if (property === 'withFailureHandler') {
            return (handler) => {
              failureHandler = handler;
              return runner;
            };
          }
          return (payload) => {
            const onSuccess = successHandler;
            const onFailure = failureHandler;
            successHandler = () => {};
            failureHandler = () => {};
            Promise.resolve()
              .then(() => {
                if (!methods[property]) throw new Error('Preview method unavailable: ' + String(property));
                return methods[property](payload);
              })
              .then(onSuccess)
              .catch(onFailure);
          };
        }
      });
      window.google = { script: { run: runner } };
    })();
  </script>
`;

const marker = /    <script>\r?\n      const ui = \{/;
if (!marker.test(source)) {
  throw new Error('Could not find the dashboard script marker.');
}
fs.writeFileSync(
  output,
  source.replace(marker, (match) => mock + '\n' + match)
);
console.log(output);
