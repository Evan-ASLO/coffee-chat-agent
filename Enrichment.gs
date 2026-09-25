function approveAndPrepareProspects(ids) {
  var prospectIds = validateBatchIds_(ids);
  var results = prospectIds.map(function (id) {
    try {
      return prepareProspect_(id);
    } catch (error) {
      return {
        id: id,
        ok: false,
        error: error.message
      };
    }
  });
  return serializeForClient_({
    results: results,
    succeeded: results.filter(function (result) { return result.ok; }).length,
    failed: results.filter(function (result) { return !result.ok; }).length
  });
}

function prepareProspect_(id) {
  var prospect = withScriptLock_(function () {
    var current = findProspect_(id);
    if (current.status === PROSPECT_STATUS.DRAFT_READY) {
      return current;
    }
    if (current.status === PROSPECT_STATUS.DISCOVERED) {
      current = patchProspect_(id, {
        status: PROSPECT_STATUS.CONTACT_APPROVED,
        contactApprovedAt: now_(),
        error: ''
      });
      logActivity_('CONTACT_APPROVED', id, {});
    }
    assert_(
      [PROSPECT_STATUS.CONTACT_APPROVED, PROSPECT_STATUS.ERROR].indexOf(current.status) !== -1,
      'Only discovered, approved, or failed prospects can be prepared.'
    );
    return patchProspect_(id, {
      status: PROSPECT_STATUS.PREPARING,
      contactApprovedAt: current.contactApprovedAt || now_(),
      error: ''
    });
  });

  if (prospect.status === PROSPECT_STATUS.DRAFT_READY) {
    return { id: id, ok: true, prospect: serializeForClient_(prospect), skipped: true };
  }

  try {
    var settings = getSettings_();
    var enriched = enrichProspect_(prospect, settings);
    var draftInput = Object.assign({}, prospect, enriched);
    var draft = draftOutreach_(draftInput, settings);
    var updated = withScriptLock_(function () {
      return patchProspect_(id, {
        status: PROSPECT_STATUS.DRAFT_READY,
        firstName: enriched.firstName || prospect.firstName,
        lastName: enriched.lastName || prospect.lastName,
        fullName: enriched.fullName || prospect.fullName,
        title: enriched.title || prospect.title,
        company: enriched.company || prospect.company,
        companyDomain: enriched.companyDomain || prospect.companyDomain,
        linkedinUrl: enriched.linkedinUrl || prospect.linkedinUrl,
        email: enriched.email || prospect.email,
        emailConfidence:
          enriched.emailConfidence === undefined
            ? prospect.emailConfidence
            : enriched.emailConfidence,
        personalizationNotes: draft.personalizationNotes,
        subject: draft.subject,
        draftBody: draft.body,
        error: ''
      });
    });
    logActivity_('DRAFT_PREPARED', id, {
      enrichmentProvider: asText_(settings.ENRICHMENT_PROVIDER, 100),
      draftProvider: asText_(settings.DRAFT_PROVIDER, 100),
      hasEmail: Boolean(updated.email)
    });
    return { id: id, ok: true, prospect: serializeForClient_(updated) };
  } catch (error) {
    withScriptLock_(function () {
      var current = findProspect_(id);
      if (current.status === PROSPECT_STATUS.PREPARING) {
        patchProspect_(id, {
          status: PROSPECT_STATUS.ERROR,
          error: asText_(error.message, 3000)
        });
      }
    });
    logActivity_('PREPARATION_FAILED', id, { error: error.message });
    throw error;
  }
}

function rejectProspects(ids) {
  var prospectIds = validateBatchIds_(ids);
  var rejected = withScriptLock_(function () {
    return prospectIds.map(function (id) {
      var prospect = findProspect_(id);
      assert_(
        [
          PROSPECT_STATUS.DISCOVERED,
          PROSPECT_STATUS.CONTACT_APPROVED,
          PROSPECT_STATUS.DRAFT_READY,
          PROSPECT_STATUS.ERROR
        ].indexOf(prospect.status) !== -1,
        prospect.fullName + ' cannot be rejected from status ' + prospect.status + '.'
      );
      var updated = patchProspect_(id, {
        status: PROSPECT_STATUS.REJECTED,
        error: ''
      });
      logActivity_('PROSPECT_REJECTED', id, {});
      return updated;
    });
  });
  return serializeForClient_(rejected);
}

function enrichProspect_(prospect, settings) {
  var provider = asText_(settings.ENRICHMENT_PROVIDER, 100).toUpperCase();
  if (!provider || provider === 'NONE') {
    return {};
  }
  if (provider === 'HUNTER') {
    return enrichWithHunter_(prospect);
  }
  if (provider === 'CUSTOM_WEBHOOK') {
    return enrichWithWebhook_(prospect);
  }
  throw new Error('Unsupported enrichment provider: ' + provider);
}

function enrichWithHunter_(prospect) {
  var params = buildHunterEmailFinderParams_(
    prospect,
    getSecret_('HUNTER_API_KEY', true)
  );
  var response;
  try {
    response = fetchJson_(
      'https://api.hunter.io/v2/email-finder?' +
        buildQueryString_(params),
      null,
      'Hunter Email Finder'
    );
  } catch (error) {
    if (isHunterNotFoundError_(error)) {
      logActivity_('EMAIL_NOT_FOUND', prospect.id, {
        provider: 'HUNTER',
        linkedinUrl: prospect.linkedinUrl
      });
      return {};
    }
    throw error;
  }
  var data = response.data || {};
  return normalizeEnrichmentResult_({
    email: data.email,
    emailConfidence: data.score,
    firstName: data.first_name,
    lastName: data.last_name,
    fullName: [data.first_name, data.last_name].filter(Boolean).join(' '),
    companyDomain: data.domain,
    company: data.company
  });
}

function buildHunterEmailFinderParams_(prospect, apiKey) {
  var params = { api_key: apiKey };
  if (
    prospect.firstName &&
    prospect.lastName &&
    (prospect.companyDomain || prospect.company)
  ) {
    params.domain = prospect.companyDomain;
    params.company = prospect.companyDomain ? '' : prospect.company;
    params.first_name = prospect.firstName;
    params.last_name = prospect.lastName;
    return params;
  }
  var linkedinHandle = extractLinkedInHandle_(prospect.linkedinUrl);
  if (prospect.firstName && prospect.lastName && linkedinHandle) {
    params.first_name = prospect.firstName;
    params.last_name = prospect.lastName;
    params.linkedin_handle = linkedinHandle;
    return params;
  }
  throw new Error(
    'Hunter requires a first and last name plus either a company or LinkedIn profile.'
  );
}

function extractLinkedInHandle_(linkedinUrl) {
  var match = normalizeLinkedInUrl_(linkedinUrl).match(
    /linkedin\.com\/in\/([^/?#]+)/i
  );
  return match ? decodeURIComponent(match[1]) : '';
}

function isHunterNotFoundError_(error) {
  var message = error && error.message ? error.message : String(error || '');
  return (
    message.indexOf('Hunter Email Finder returned HTTP 404') !== -1 &&
    message.indexOf('"not_found"') !== -1
  );
}

function enrichWithWebhook_(prospect) {
  var response = postJson_(
    getSecret_('ENRICHMENT_WEBHOOK_URL', true),
    {
      action: 'enrich',
      person: serializeForClient_(prospect)
    },
    getSecret_('ENRICHMENT_WEBHOOK_TOKEN', false),
    'Enrichment webhook'
  );
  return normalizeEnrichmentResult_(response.person || response);
}

function normalizeEnrichmentResult_(result) {
  var email = normalizeEmail_(result.email);
  if (email) {
    assertValidEmail_(email);
  }
  return {
    email: email,
    emailConfidence: clamp_(asNumber_(result.emailConfidence, 0), 0, 100),
    firstName: asText_(result.firstName, 120),
    lastName: asText_(result.lastName, 120),
    fullName: asText_(result.fullName, 250),
    title: asText_(result.title, 300),
    company: asText_(result.company, 250),
    companyDomain: normalizeDomain_(result.companyDomain),
    linkedinUrl: normalizeLinkedInUrl_(result.linkedinUrl)
  };
}
