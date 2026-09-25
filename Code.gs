function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(APP.NAME)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function getAppState() {
  return serializeForClient_(getAppState_());
}

function initializeAgent() {
  setupCoffeeChatAgent();
  return getAppState();
}

function saveConfiguration(payload) {
  assert_(payload && typeof payload === 'object', 'Configuration is required.');
  var syncIntervalChanged = Boolean(
    payload.settings &&
      Object.prototype.hasOwnProperty.call(payload.settings, 'SYNC_INTERVAL_MINUTES')
  );

  withScriptLock_(function () {
    if (payload.settings) {
      updateSettings_(payload.settings);
    }
    if (payload.personalContext) {
      replacePersonalContext_(payload.personalContext);
    }
    if (payload.secrets && Object.keys(payload.secrets).length) {
      saveSecrets_(payload.secrets);
    }
    logActivity_('CONFIGURATION_UPDATED', '', {
      settings: payload.settings ? Object.keys(payload.settings) : [],
      personalContextUpdated: Boolean(payload.personalContext),
      secretsUpdated: payload.secrets ? Object.keys(payload.secrets) : []
    });
  });

  if (syncIntervalChanged) {
    installReplySyncTrigger_(true);
  }
  return getAppState();
}

function clearConfiguredSecret(key) {
  clearSecret_(key);
  logActivity_('SECRET_CLEARED', '', { key: key });
  return getAppState();
}

function getAppState_() {
  var spreadsheetId = PropertiesService.getScriptProperties()
    .getProperty(APP.PROPERTY_SPREADSHEET_ID);
  if (!spreadsheetId) {
    return {
      appName: APP.NAME,
      version: APP.VERSION,
      setupRequired: true,
      accountEmail: getActorEmail_(),
      settings: defaultSettingsForClient_(),
      personalContext: [],
      prospects: [],
      lastCriteria: {},
      secretConfiguration: getSecretConfiguration_(),
      summary: emptySummary_()
    };
  }

  var spreadsheet = getSpreadsheet_();
  var prospects = listProspects_();
  return {
    appName: APP.NAME,
    version: APP.VERSION,
    setupRequired: false,
    accountEmail: getActorEmail_(),
    spreadsheetId: spreadsheet.getId(),
    spreadsheetUrl: spreadsheet.getUrl(),
    settings: Object.assign(defaultSettingsForClient_(), getSettings_()),
    personalContext: getPersonalContext_(),
    prospects: prospects,
    lastCriteria: getLastCriteria_(),
    secretConfiguration: getSecretConfiguration_(),
    summary: summarizeProspects_(prospects)
  };
}

function defaultSettingsForClient_() {
  return Object.keys(DEFAULT_SETTINGS).reduce(function (result, key) {
    result[key] = DEFAULT_SETTINGS[key].value;
    return result;
  }, {});
}

function summarizeProspects_(prospects) {
  var summary = emptySummary_();
  summary.total = prospects.length;
  prospects.forEach(function (prospect) {
    var status = prospect.status;
    if (Object.prototype.hasOwnProperty.call(summary.byStatus, status)) {
      summary.byStatus[status] += 1;
    } else {
      summary.byStatus[status] = 1;
    }
    if (status === PROSPECT_STATUS.DRAFT_READY) {
      summary.awaitingDraftApproval += 1;
    }
    if (status === PROSPECT_STATUS.SENT) {
      summary.awaitingReply += 1;
    }
    if (status === PROSPECT_STATUS.REPLIED) {
      summary.replied += 1;
    }
  });
  return summary;
}

function emptySummary_() {
  return {
    total: 0,
    awaitingDraftApproval: 0,
    awaitingReply: 0,
    replied: 0,
    byStatus: {
      DISCOVERED: 0,
      CONTACT_APPROVED: 0,
      PREPARING: 0,
      DRAFT_READY: 0,
      SENDING: 0,
      SENT: 0,
      REPLIED: 0,
      REJECTED: 0,
      ERROR: 0
    }
  };
}
