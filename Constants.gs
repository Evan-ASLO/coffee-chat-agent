var APP = Object.freeze({
  NAME: 'Coffee Chat Agent',
  VERSION: '1.0.0',
  PROPERTY_SPREADSHEET_ID: 'COFFEE_CHAT_SPREADSHEET_ID',
  PROPERTY_LAST_CRITERIA: 'COFFEE_CHAT_LAST_CRITERIA',
  SHEETS: Object.freeze({
    PROSPECTS: 'Prospects',
    SETTINGS: 'Settings',
    PROFILE: 'Personal Context',
    ACTIVITY: 'Activity'
  }),
  PROSPECT_HEADERS: Object.freeze([
    'id',
    'createdAt',
    'updatedAt',
    'status',
    'firstName',
    'lastName',
    'fullName',
    'title',
    'company',
    'companyDomain',
    'location',
    'linkedinUrl',
    'email',
    'emailConfidence',
    'discoveryProvider',
    'sourceUrl',
    'sourceSnippet',
    'whyRelevant',
    'outreachObjective',
    'relevanceScore',
    'personalizationNotes',
    'subject',
    'draftBody',
    'contactApprovedAt',
    'draftApprovedAt',
    'sentAt',
    'lastReplyAt',
    'replyFrom',
    'replySnippet',
    'gmailThreadId',
    'gmailMessageId',
    'error'
  ]),
  SETTINGS_HEADERS: Object.freeze(['key', 'value', 'description']),
  PROFILE_HEADERS: Object.freeze(['category', 'content']),
  ACTIVITY_HEADERS: Object.freeze([
    'timestamp',
    'action',
    'prospectId',
    'actor',
    'details'
  ]),
  MAX_BATCH_SIZE: 20,
  MAX_CELL_TEXT: 45000
});

var PROSPECT_STATUS = Object.freeze({
  DISCOVERED: 'DISCOVERED',
  CONTACT_APPROVED: 'CONTACT_APPROVED',
  PREPARING: 'PREPARING',
  DRAFT_READY: 'DRAFT_READY',
  SENDING: 'SENDING',
  SENT: 'SENT',
  REPLIED: 'REPLIED',
  REJECTED: 'REJECTED',
  ERROR: 'ERROR'
});

var STATUS_TRANSITIONS = Object.freeze({
  DISCOVERED: Object.freeze(['CONTACT_APPROVED', 'REJECTED']),
  CONTACT_APPROVED: Object.freeze(['PREPARING', 'REJECTED', 'ERROR']),
  PREPARING: Object.freeze(['DRAFT_READY', 'ERROR']),
  DRAFT_READY: Object.freeze(['SENDING', 'REJECTED', 'ERROR']),
  SENDING: Object.freeze(['SENT', 'ERROR']),
  SENT: Object.freeze(['REPLIED', 'ERROR']),
  REPLIED: Object.freeze(['REPLIED']),
  REJECTED: Object.freeze([]),
  ERROR: Object.freeze(['CONTACT_APPROVED', 'PREPARING', 'DRAFT_READY', 'REJECTED'])
});

var DEFAULT_SETTINGS = Object.freeze({
  DISCOVERY_PROVIDER: Object.freeze({
    value: 'GOOGLE_CSE',
    description: 'GOOGLE_CSE or CUSTOM_WEBHOOK.'
  }),
  ENRICHMENT_PROVIDER: Object.freeze({
    value: 'HUNTER',
    description: 'NONE, CUSTOM_WEBHOOK, or HUNTER.'
  }),
  DRAFT_PROVIDER: Object.freeze({
    value: 'GEMINI',
    description: 'GEMINI, TEMPLATE, or CUSTOM_WEBHOOK.'
  }),
  GEMINI_MODEL: Object.freeze({
    value: 'gemini-2.5-flash',
    description: 'Gemini model used to draft personalized outreach.'
  }),
  MAX_DISCOVERY_RESULTS: Object.freeze({
    value: '15',
    description: 'Maximum people returned by one discovery run (1-20).'
  }),
  EMAIL_WORD_LIMIT: Object.freeze({
    value: '140',
    description: 'Target maximum word count for an outreach email.'
  }),
  SENDER_NAME: Object.freeze({
    value: '',
    description: 'Name shown on sent outreach emails.'
  }),
  OUTREACH_GOAL: Object.freeze({
    value: "Request a short coffee chat to learn from the person's experience.",
    description: 'Default objective supplied to the drafting model.'
  }),
  REPLY_LOOKBACK_DAYS: Object.freeze({
    value: '60',
    description: 'How long sent threads remain eligible for reply synchronization.'
  }),
  SYNC_INTERVAL_MINUTES: Object.freeze({
    value: '15',
    description: 'Scheduled Gmail reply synchronization interval.'
  })
});

var SECRET_KEYS = Object.freeze([
  'GOOGLE_CSE_API_KEY',
  'GOOGLE_CSE_ID',
  'GEMINI_API_KEY',
  'DISCOVERY_WEBHOOK_URL',
  'DISCOVERY_WEBHOOK_TOKEN',
  'ENRICHMENT_WEBHOOK_URL',
  'ENRICHMENT_WEBHOOK_TOKEN',
  'DRAFT_WEBHOOK_URL',
  'DRAFT_WEBHOOK_TOKEN',
  'HUNTER_API_KEY'
]);

function assert_(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function asText_(value, maxLength) {
  var text = value === null || value === undefined ? '' : String(value).trim();
  var limit = maxLength || APP.MAX_CELL_TEXT;
  return text.length > limit ? text.substring(0, limit) : text;
}

function asNumber_(value, fallback) {
  var number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp_(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function now_() {
  return new Date();
}

function makeId_() {
  return Utilities.getUuid();
}

function parseJson_(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error((label || 'Response') + ' was not valid JSON: ' + error.message);
  }
}

function normalizeEmail_(value) {
  return asText_(value, 320).toLowerCase();
}

function normalizeLinkedInUrl_(value) {
  var url = normalizeHttpUrl_(value);
  if (!url) {
    return '';
  }
  if (!/^https:\/\/(?:[a-z0-9-]+\.)*linkedin\.com\/in\/[^/?#]+/i.test(url)) {
    return '';
  }
  url = url.split('?')[0].replace(/\/+$/, '');
  return url;
}

function normalizeHttpUrl_(value) {
  var url = asText_(value, 2048);
  if (!url) {
    return '';
  }
  if (/^www\./i.test(url)) {
    url = 'https://' + url;
  }
  url = url.replace(/^http:\/\//i, 'https://');
  if (
    !/^https:\/\/[a-z0-9.-]+(?::\d+)?(?:[/?#]|$)/i.test(url) ||
    /[\s<>"'`]/.test(url)
  ) {
    return '';
  }
  return url;
}

function normalizeDomain_(value) {
  return asText_(value, 255)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
}

function getActorEmail_() {
  return Session.getEffectiveUser().getEmail() || Session.getActiveUser().getEmail() || 'unknown';
}

function withScriptLock_(callback) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function validateBatchIds_(ids) {
  assert_(Array.isArray(ids) && ids.length > 0, 'Select at least one person.');
  assert_(ids.length <= APP.MAX_BATCH_SIZE, 'A batch cannot exceed ' + APP.MAX_BATCH_SIZE + ' people.');
  return ids.map(function (id) {
    var clean = asText_(id, 100);
    assert_(clean, 'Every selected person must have an id.');
    return clean;
  });
}

function assertStatusTransition_(currentStatus, nextStatus) {
  var allowed = STATUS_TRANSITIONS[currentStatus] || [];
  assert_(
    allowed.indexOf(nextStatus) !== -1,
    'Invalid status transition from ' + currentStatus + ' to ' + nextStatus + '.'
  );
}

function toIsoString_(value) {
  if (!value) {
    return '';
  }
  var date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function serializeForClient_(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(serializeForClient_);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).reduce(function (result, key) {
      result[key] = serializeForClient_(value[key]);
      return result;
    }, {});
  }
  return value;
}
