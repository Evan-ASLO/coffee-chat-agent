function setupCoffeeChatAgent() {
  return withScriptLock_(function () {
    var properties = PropertiesService.getScriptProperties();
    var spreadsheet = getOrCreateSpreadsheet_(properties);

    ensureSheet_(spreadsheet, APP.SHEETS.PROSPECTS, APP.PROSPECT_HEADERS);
    ensureSheet_(spreadsheet, APP.SHEETS.SETTINGS, APP.SETTINGS_HEADERS);
    ensureSheet_(spreadsheet, APP.SHEETS.PROFILE, APP.PROFILE_HEADERS);
    ensureSheet_(spreadsheet, APP.SHEETS.ACTIVITY, APP.ACTIVITY_HEADERS);

    seedSettings_();
    seedPersonalContext_();
    installReplySyncTrigger_();
    logActivity_('SETUP_COMPLETED', '', {
      version: APP.VERSION,
      spreadsheetId: spreadsheet.getId()
    });

    return {
      spreadsheetId: spreadsheet.getId(),
      spreadsheetUrl: spreadsheet.getUrl(),
      triggerInstalled: true
    };
  });
}

function getOrCreateSpreadsheet_(properties) {
  var configuredId = properties.getProperty(APP.PROPERTY_SPREADSHEET_ID);
  if (configuredId) {
    try {
      return SpreadsheetApp.openById(configuredId);
    } catch (error) {
      throw new Error(
        'The configured spreadsheet is unavailable. Clear ' +
          APP.PROPERTY_SPREADSHEET_ID +
          ' or restore access. ' +
          error.message
      );
    }
  }

  var activeSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var spreadsheet = activeSpreadsheet || SpreadsheetApp.create(APP.NAME + ' CRM');
  properties.setProperty(APP.PROPERTY_SPREADSHEET_ID, spreadsheet.getId());
  return spreadsheet;
}

function getSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty(APP.PROPERTY_SPREADSHEET_ID);
  assert_(id, 'Run setupCoffeeChatAgent() before using the app.');
  try {
    return SpreadsheetApp.openById(id);
  } catch (error) {
    throw new Error('The Coffee Chat Agent spreadsheet cannot be opened: ' + error.message);
  }
}

function ensureSheet_(spreadsheet, name, headers) {
  var sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
  var lastColumn = sheet.getLastColumn();
  var existingHeaders =
    lastColumn > 0 ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0] : [];

  if (existingHeaders.length === 0 || existingHeaders.every(function (value) { return !value; })) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    assert_(
      headers.every(function (header, index) { return existingHeaders[index] === header; }),
      'Sheet "' + name + '" has an incompatible header row.'
    );
  }

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setBackground('#e8f0fe')
    .setWrap(true);

  if (name === APP.SHEETS.PROSPECTS) {
    sheet.setColumnWidth(1, 220);
    sheet.setColumnWidths(2, 3, 155);
    sheet.setColumnWidth(4, 145);
    sheet.setColumnWidths(5, 3, 145);
    sheet.setColumnWidths(8, 6, 170);
    sheet.setColumnWidths(14, 5, 160);
    sheet.setColumnWidths(19, 4, 220);
    sheet.setColumnWidths(23, 9, 165);
  }
  return sheet;
}

function seedSettings_() {
  var existing = getSettings_();
  var missing = Object.keys(DEFAULT_SETTINGS).filter(function (key) {
    return existing[key] === undefined;
  });
  if (!missing.length) {
    return;
  }

  var sheet = getSheet_(APP.SHEETS.SETTINGS);
  var rows = missing.map(function (key) {
    return [
      key,
      DEFAULT_SETTINGS[key].value,
      DEFAULT_SETTINGS[key].description
    ];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, APP.SETTINGS_HEADERS.length).setValues(rows);
}

function seedPersonalContext_() {
  var sheet = getSheet_(APP.SHEETS.PROFILE);
  if (sheet.getLastRow() > 1) {
    return;
  }

  var rows = [
    ['Background summary', ''],
    ['Current goal', ''],
    ['Experience to reference', ''],
    ['Interests', ''],
    ['Tone', 'Warm, concise, curious, and respectful.'],
    ['Avoid', 'Do not exaggerate experience, invent shared connections, or use generic flattery.'],
    ['Sample email', '']
  ];
  sheet.getRange(2, 1, rows.length, APP.PROFILE_HEADERS.length).setValues(rows);
  sheet.setColumnWidth(1, 190);
  sheet.setColumnWidth(2, 700);
  sheet.getRange(2, 2, rows.length, 1).setWrap(true);
}

function installReplySyncTrigger_(force) {
  var handler = 'syncRepliesTrigger';
  var triggers = ScriptApp.getProjectTriggers();
  var matching = triggers.filter(function (trigger) {
    return trigger.getHandlerFunction() === handler;
  });

  if (force) {
    matching.forEach(function (trigger) {
      ScriptApp.deleteTrigger(trigger);
    });
    matching = [];
  } else {
    matching.slice(1).forEach(function (trigger) {
      ScriptApp.deleteTrigger(trigger);
    });
  }
  if (matching.length) {
    return;
  }

  var settings = getSettings_();
  var interval = asNumber_(settings.SYNC_INTERVAL_MINUTES, 15);
  var allowedIntervals = [1, 5, 10, 15, 30];
  if (allowedIntervals.indexOf(interval) === -1) {
    interval = 15;
  }
  ScriptApp.newTrigger(handler).timeBased().everyMinutes(interval).create();
}

function getSecret_(key, required) {
  assert_(SECRET_KEYS.indexOf(key) !== -1, 'Unknown secret key: ' + key);
  var value = PropertiesService.getScriptProperties().getProperty(key) || '';
  if (required) {
    assert_(value, key + ' is not configured.');
  }
  return value;
}

function saveSecrets_(updates) {
  assert_(updates && typeof updates === 'object', 'Secret updates must be an object.');
  var properties = PropertiesService.getScriptProperties();
  Object.keys(updates).forEach(function (key) {
    assert_(SECRET_KEYS.indexOf(key) !== -1, 'Unknown secret key: ' + key);
    var value = asText_(updates[key], 10000);
    if (value) {
      if (/_URL$/.test(key)) {
        value = normalizeHttpUrl_(value);
        assert_(value, key + ' must be a valid HTTPS URL.');
      }
      properties.setProperty(key, value);
    } else {
      properties.deleteProperty(key);
    }
  });
  return getSecretConfiguration_();
}

function clearSecret_(key) {
  assert_(SECRET_KEYS.indexOf(key) !== -1, 'Unknown secret key: ' + key);
  PropertiesService.getScriptProperties().deleteProperty(key);
  return getSecretConfiguration_();
}

function getSecretConfiguration_() {
  var properties = PropertiesService.getScriptProperties();
  return SECRET_KEYS.reduce(function (result, key) {
    result[key] = Boolean(properties.getProperty(key));
    return result;
  }, {});
}
