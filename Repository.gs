function getSheet_(name) {
  var sheet = getSpreadsheet_().getSheetByName(name);
  assert_(sheet, 'Required sheet "' + name + '" is missing. Run setupCoffeeChatAgent().');
  return sheet;
}

function readSheetObjects_(name) {
  var sheet = getSheet_(name);
  var values = sheet.getDataRange().getValues();
  if (values.length <= 1) {
    return [];
  }
  var headers = values[0];
  return values.slice(1).map(function (row, index) {
    var item = { _rowNumber: index + 2 };
    headers.forEach(function (header, columnIndex) {
      item[header] = row[columnIndex];
    });
    return item;
  });
}

function appendSheetObjects_(name, headers, items) {
  if (!items.length) {
    return;
  }
  var sheet = getSheet_(name);
  var rows = items.map(function (item) {
    return headers.map(function (header) {
      return sheetSafeValue_(item[header] === undefined ? '' : item[header]);
    });
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
}

function getSettings_() {
  var settings = {};
  var spreadsheetId = PropertiesService.getScriptProperties().getProperty(APP.PROPERTY_SPREADSHEET_ID);
  if (!spreadsheetId) {
    return settings;
  }

  var spreadsheet;
  try {
    spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  } catch (error) {
    return settings;
  }
  var sheet = spreadsheet.getSheetByName(APP.SHEETS.SETTINGS);
  if (!sheet || sheet.getLastRow() <= 1) {
    return settings;
  }

  sheet.getRange(2, 1, sheet.getLastRow() - 1, APP.SETTINGS_HEADERS.length)
    .getValues()
    .forEach(function (row) {
      var key = asText_(row[0], 100);
      if (key) {
        settings[key] = asText_(row[1], 10000);
      }
    });
  return settings;
}

function updateSettings_(updates) {
  assert_(updates && typeof updates === 'object', 'Settings updates must be an object.');
  var allowedKeys = Object.keys(DEFAULT_SETTINGS);
  Object.keys(updates).forEach(function (key) {
    assert_(allowedKeys.indexOf(key) !== -1, 'Unknown setting: ' + key);
  });

  var sheet = getSheet_(APP.SHEETS.SETTINGS);
  var rows = readSheetObjects_(APP.SHEETS.SETTINGS);
  var rowByKey = rows.reduce(function (result, row) {
    result[row.key] = row._rowNumber;
    return result;
  }, {});

  Object.keys(updates).forEach(function (key) {
    var value = normalizeSettingValue_(key, updates[key]);
    var rowNumber = rowByKey[key];
    if (rowNumber) {
      sheet.getRange(rowNumber, 2).setValue(sheetSafeValue_(value));
    } else {
      sheet.appendRow([
        key,
        sheetSafeValue_(value),
        DEFAULT_SETTINGS[key].description
      ]);
    }
  });
  return getSettings_();
}

function normalizeSettingValue_(key, value) {
  var text = asText_(value, 10000);
  var enums = {
    DISCOVERY_PROVIDER: ['TAVILY', 'GOOGLE_CSE', 'CUSTOM_WEBHOOK'],
    ENRICHMENT_PROVIDER: ['NONE', 'HUNTER', 'CUSTOM_WEBHOOK'],
    DRAFT_PROVIDER: ['GEMINI', 'TEMPLATE', 'CUSTOM_WEBHOOK']
  };
  if (enums[key]) {
    text = text.toUpperCase();
    assert_(enums[key].indexOf(text) !== -1, 'Invalid value for ' + key + '.');
    return text;
  }
  if (key === 'GEMINI_MODEL') {
    assert_(/^[a-z0-9._-]+$/i.test(text), 'GEMINI_MODEL contains unsupported characters.');
    return text;
  }
  var numericRanges = {
    MAX_DISCOVERY_RESULTS: [1, APP.MAX_BATCH_SIZE],
    EMAIL_WORD_LIMIT: [60, 250],
    REPLY_LOOKBACK_DAYS: [1, 365]
  };
  if (numericRanges[key]) {
    var number = Number(text);
    assert_(
      Number.isInteger(number) &&
        number >= numericRanges[key][0] &&
        number <= numericRanges[key][1],
      key + ' must be an integer from ' +
        numericRanges[key][0] +
        ' to ' +
        numericRanges[key][1] +
        '.'
    );
    return String(number);
  }
  if (key === 'SYNC_INTERVAL_MINUTES') {
    assert_(
      ['1', '5', '10', '15', '30'].indexOf(text) !== -1,
      'SYNC_INTERVAL_MINUTES must be 1, 5, 10, 15, or 30.'
    );
    return text;
  }
  return text;
}

function getPersonalContext_() {
  return readSheetObjects_(APP.SHEETS.PROFILE)
    .filter(function (row) {
      return asText_(row.category, 200);
    })
    .map(function (row) {
      return {
        category: asText_(row.category, 200),
        content: asText_(row.content, APP.MAX_CELL_TEXT)
      };
    });
}

function replacePersonalContext_(items) {
  assert_(Array.isArray(items) && items.length > 0, 'Personal context cannot be empty.');
  assert_(items.length <= 30, 'Personal context is limited to 30 entries.');
  var normalized = items.map(function (item) {
    var category = asText_(item.category, 200);
    var content = asText_(item.content, APP.MAX_CELL_TEXT);
    assert_(category, 'Every personal context entry needs a category.');
    return [sheetSafeValue_(category), sheetSafeValue_(content)];
  });

  var sheet = getSheet_(APP.SHEETS.PROFILE);
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, APP.PROFILE_HEADERS.length).clearContent();
  }
  sheet.getRange(2, 1, normalized.length, APP.PROFILE_HEADERS.length).setValues(normalized);
  return getPersonalContext_();
}

function getUsablePersonalContext_() {
  return getPersonalContext_().filter(function (item) {
    return Boolean(item.content);
  });
}

function listProspects_() {
  return readSheetObjects_(APP.SHEETS.PROSPECTS)
    .filter(function (row) { return row.id; })
    .sort(function (left, right) {
      return new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime();
    });
}

function findProspect_(id) {
  var prospect = readSheetObjects_(APP.SHEETS.PROSPECTS).find(function (row) {
    return row.id === id;
  });
  assert_(prospect, 'Prospect not found: ' + id);
  return prospect;
}

function insertProspects_(prospects) {
  var now = now_();
  var existing = listProspects_();
  var dedupeKeys = existing.reduce(function (keys, prospect) {
    candidateDedupeKeys_(prospect).forEach(function (key) { keys[key] = true; });
    return keys;
  }, {});

  var inserted = [];
  prospects.forEach(function (prospect) {
    var normalized = normalizeProspect_(prospect, now);
    var keys = candidateDedupeKeys_(normalized);
    if (keys.some(function (key) { return dedupeKeys[key]; })) {
      return;
    }
    keys.forEach(function (key) { dedupeKeys[key] = true; });
    inserted.push(normalized);
  });

  appendSheetObjects_(APP.SHEETS.PROSPECTS, APP.PROSPECT_HEADERS, inserted);
  inserted.forEach(function (prospect) {
    logActivity_('PROSPECT_DISCOVERED', prospect.id, {
      fullName: prospect.fullName,
      company: prospect.company,
      provider: prospect.discoveryProvider
    });
  });
  return inserted;
}

function normalizeProspect_(prospect, timestamp) {
  var firstName = asText_(prospect.firstName, 120);
  var lastName = asText_(prospect.lastName, 120);
  var fullName = asText_(prospect.fullName, 250) || [firstName, lastName].filter(Boolean).join(' ');
  assert_(fullName, 'A discovered prospect is missing a name.');

  return {
    id: makeId_(),
    createdAt: prospect.createdAt || timestamp,
    updatedAt: timestamp,
    status: PROSPECT_STATUS.DISCOVERED,
    firstName: firstName || fullName.split(/\s+/)[0],
    lastName: lastName || fullName.split(/\s+/).slice(1).join(' '),
    fullName: fullName,
    title: asText_(prospect.title, 300),
    company: asText_(prospect.company, 250),
    companyDomain: normalizeDomain_(prospect.companyDomain),
    location: asText_(prospect.location, 250),
    linkedinUrl: normalizeLinkedInUrl_(prospect.linkedinUrl),
    email: normalizeEmail_(prospect.email),
    emailConfidence: clamp_(asNumber_(prospect.emailConfidence, 0), 0, 100),
    discoveryProvider: asText_(prospect.discoveryProvider, 100),
    sourceUrl: normalizeHttpUrl_(prospect.sourceUrl),
    sourceSnippet: asText_(prospect.sourceSnippet, 3000),
    whyRelevant: asText_(prospect.whyRelevant, 3000),
    outreachObjective: asText_(prospect.outreachObjective, 1000),
    relevanceScore: clamp_(asNumber_(prospect.relevanceScore, 0), 0, 100),
    personalizationNotes: '',
    subject: '',
    draftBody: '',
    contactApprovedAt: '',
    draftApprovedAt: '',
    sentAt: '',
    lastReplyAt: '',
    replyFrom: '',
    replySnippet: '',
    gmailThreadId: '',
    gmailMessageId: '',
    error: ''
  };
}

function candidateDedupeKeys_(prospect) {
  var keys = [];
  var linkedinUrl = normalizeLinkedInUrl_(prospect.linkedinUrl);
  var email = normalizeEmail_(prospect.email);
  var nameCompany = [asText_(prospect.fullName, 250).toLowerCase(), asText_(prospect.company, 250).toLowerCase()]
    .filter(Boolean)
    .join('|');
  if (linkedinUrl) {
    keys.push('linkedin:' + linkedinUrl.toLowerCase());
  }
  if (email) {
    keys.push('email:' + email);
  }
  if (nameCompany) {
    keys.push('name-company:' + nameCompany);
  }
  return keys;
}

function patchProspect_(id, patch, options) {
  var prospect = findProspect_(id);
  var sheet = getSheet_(APP.SHEETS.PROSPECTS);
  var currentStatus = asText_(prospect.status, 100);
  var nextStatus = patch.status ? asText_(patch.status, 100) : currentStatus;
  if (nextStatus !== currentStatus && !(options && options.skipTransitionValidation)) {
    assertStatusTransition_(currentStatus, nextStatus);
  }

  var allowed = APP.PROSPECT_HEADERS.filter(function (header) {
    return ['id', 'createdAt'].indexOf(header) === -1;
  });
  Object.keys(patch).forEach(function (key) {
    assert_(allowed.indexOf(key) !== -1, 'Cannot update prospect field: ' + key);
  });

  var updated = Object.assign({}, prospect, patch, { updatedAt: now_() });
  var values = APP.PROSPECT_HEADERS.map(function (header) {
    return sheetSafeValue_(updated[header] === undefined ? '' : updated[header]);
  });
  sheet.getRange(prospect._rowNumber, 1, 1, values.length).setValues([values]);
  delete updated._rowNumber;
  return updated;
}

function saveLastCriteria_(criteria) {
  PropertiesService.getScriptProperties().setProperty(
    APP.PROPERTY_LAST_CRITERIA,
    JSON.stringify(criteria)
  );
}

function getLastCriteria_() {
  var value = PropertiesService.getScriptProperties().getProperty(APP.PROPERTY_LAST_CRITERIA);
  return value ? parseJson_(value, 'Saved search criteria') : {};
}

function logActivity_(action, prospectId, details) {
  appendSheetObjects_(APP.SHEETS.ACTIVITY, APP.ACTIVITY_HEADERS, [{
    timestamp: now_(),
    action: asText_(action, 150),
    prospectId: asText_(prospectId, 100),
    actor: getActorEmail_(),
    details: asText_(JSON.stringify(details || {}), APP.MAX_CELL_TEXT)
  }]);
}

function sheetSafeValue_(value) {
  if (
    typeof value === 'string' &&
    /^[=+\-@]/.test(value) &&
    value.charAt(0) !== '\''
  ) {
    return '\'' + value;
  }
  return value;
}
