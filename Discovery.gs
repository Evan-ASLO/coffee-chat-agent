function discoverProspects(criteria) {
  var normalizedCriteria = normalizeCriteria_(criteria || {});
  var settings = getSettings_();
  normalizedCriteria.count = Math.min(
    normalizedCriteria.count,
    clamp_(asNumber_(settings.MAX_DISCOVERY_RESULTS, 15), 1, APP.MAX_BATCH_SIZE)
  );
  var provider = asText_(settings.DISCOVERY_PROVIDER, 100).toUpperCase();
  var prospects;

  if (provider === 'GOOGLE_CSE') {
    prospects = discoverWithGoogleCse_(normalizedCriteria, settings);
  } else if (provider === 'CUSTOM_WEBHOOK') {
    prospects = discoverWithWebhook_(normalizedCriteria);
  } else {
    throw new Error('Unsupported discovery provider: ' + provider);
  }

  saveLastCriteria_(normalizedCriteria);
  var inserted = withScriptLock_(function () {
    return insertProspects_(prospects);
  });
  logActivity_('DISCOVERY_COMPLETED', '', {
    provider: provider,
    requested: normalizedCriteria.count,
    returned: prospects.length,
    inserted: inserted.length
  });
  return serializeForClient_({
    discovered: prospects.length,
    inserted: inserted.length,
    duplicatesSkipped: prospects.length - inserted.length,
    prospects: inserted
  });
}

function addManualProspect(input) {
  var suppliedLinkedInUrl = asText_(input && input.linkedinUrl, 2048);
  var candidate = {
    firstName: asText_(input && input.firstName, 120),
    lastName: asText_(input && input.lastName, 120),
    fullName: asText_(input && input.fullName, 250),
    title: asText_(input && input.title, 300),
    company: asText_(input && input.company, 250),
    companyDomain: normalizeDomain_(input && input.companyDomain),
    location: asText_(input && input.location, 250),
    linkedinUrl: normalizeLinkedInUrl_(input && input.linkedinUrl),
    email: normalizeEmail_(input && input.email),
    emailConfidence: input && input.email ? 100 : 0,
    discoveryProvider: 'MANUAL',
    sourceUrl: normalizeLinkedInUrl_(input && input.linkedinUrl),
    sourceSnippet: '',
    whyRelevant: asText_(input && input.whyRelevant, 3000),
    outreachObjective: asText_(input && input.outreachObjective, 1000),
    relevanceScore: clamp_(asNumber_(input && input.relevanceScore, 75), 0, 100)
  };
  assert_(candidate.fullName || candidate.firstName, 'Enter the person\'s name.');
  assert_(
    !suppliedLinkedInUrl || candidate.linkedinUrl,
    'Enter a valid LinkedIn profile URL.'
  );
  if (candidate.email) {
    assertValidEmail_(candidate.email);
  }
  var inserted = withScriptLock_(function () {
    return insertProspects_([candidate]);
  });
  assert_(inserted.length === 1, 'This person already exists in the spreadsheet.');
  return serializeForClient_(inserted[0]);
}

function normalizeCriteria_(criteria) {
  var normalized = {
    roles: parseList_(criteria.roles, 12, 120),
    industries: parseList_(criteria.industries, 12, 120),
    companies: parseList_(criteria.companies, 20, 180),
    locations: parseList_(criteria.locations, 12, 120),
    keywords: parseList_(criteria.keywords, 20, 120),
    seniority: parseList_(criteria.seniority, 10, 80),
    objective: asText_(criteria.objective, 1000),
    count: clamp_(Math.round(asNumber_(criteria.count, 10)), 1, APP.MAX_BATCH_SIZE)
  };
  assert_(
    normalized.roles.length ||
      normalized.industries.length ||
      normalized.companies.length ||
      normalized.keywords.length,
    'Enter at least one role, industry, company, or keyword.'
  );
  return normalized;
}

function parseList_(value, maxItems, maxItemLength) {
  var items = Array.isArray(value)
    ? value
    : asText_(value, 10000).split(/[\n,;]+/);
  var seen = {};
  return items
    .map(function (item) { return asText_(item, maxItemLength); })
    .filter(function (item) {
      var key = item.toLowerCase();
      if (!item || seen[key]) {
        return false;
      }
      seen[key] = true;
      return true;
    })
    .slice(0, maxItems);
}

function discoverWithGoogleCse_(criteria, settings) {
  var apiKey = getSecret_('GOOGLE_CSE_API_KEY', true);
  var searchEngineId = getSecret_('GOOGLE_CSE_ID', true);
  var queries = buildDiscoveryQueries_(criteria);
  var candidates = [];
  var seen = {};

  queries.some(function (query) {
    var remaining = criteria.count - candidates.length;
    if (remaining <= 0) {
      return true;
    }
    var result = fetchJson_(
      'https://www.googleapis.com/customsearch/v1?' +
        buildQueryString_({
          key: apiKey,
          cx: searchEngineId,
          q: query,
          num: Math.min(10, remaining)
        }),
      null,
      'Google Programmable Search'
    );
    (result.items || []).forEach(function (item) {
      if (candidates.length >= criteria.count) {
        return;
      }
      var candidate = candidateFromSearchResult_(item, criteria);
      if (candidate) {
        var keys = candidateDedupeKeys_(candidate);
        if (keys.some(function (key) { return seen[key]; })) {
          return;
        }
        keys.forEach(function (key) { seen[key] = true; });
        candidates.push(candidate);
      }
    });
    return candidates.length >= criteria.count;
  });

  return dedupeCandidates_(candidates).slice(0, criteria.count);
}

function buildDiscoveryQueries_(criteria) {
  var roleTerms = criteria.roles.concat(criteria.seniority).slice(0, 5);
  var organizationTerms = criteria.companies.length
    ? criteria.companies
    : criteria.industries;
  var locationTerms = criteria.locations.slice(0, 3);
  var keywordTerms = criteria.keywords.slice(0, 4);
  var baseParts = ['site:linkedin.com/in'];

  if (roleTerms.length) {
    baseParts.push('(' + roleTerms.map(quoteSearchTerm_).join(' OR ') + ')');
  }
  if (organizationTerms.length) {
    baseParts.push('(' + organizationTerms.slice(0, 6).map(quoteSearchTerm_).join(' OR ') + ')');
  }
  if (locationTerms.length) {
    baseParts.push('(' + locationTerms.map(quoteSearchTerm_).join(' OR ') + ')');
  }
  if (keywordTerms.length) {
    baseParts.push('(' + keywordTerms.map(quoteSearchTerm_).join(' OR ') + ')');
  }

  var queries = [baseParts.join(' ')];
  criteria.roles.slice(0, 3).forEach(function (role) {
    var parts = ['site:linkedin.com/in', quoteSearchTerm_(role)];
    if (organizationTerms.length) {
      parts.push('(' + organizationTerms.slice(0, 4).map(quoteSearchTerm_).join(' OR ') + ')');
    }
    if (locationTerms.length) {
      parts.push('(' + locationTerms.map(quoteSearchTerm_).join(' OR ') + ')');
    }
    queries.push(parts.join(' '));
  });
  return Array.from(new Set(queries)).slice(0, 4);
}

function quoteSearchTerm_(term) {
  return '"' + asText_(term, 150).replace(/"/g, '') + '"';
}

function candidateFromSearchResult_(item, criteria) {
  var link = normalizeLinkedInUrl_(item.link);
  if (!/linkedin\.com\/in\//i.test(link)) {
    return null;
  }
  var parsed = parseLinkedInSearchTitle_(item.title);
  if (!parsed.fullName) {
    return null;
  }
  var sourceText = [item.title, item.snippet].filter(Boolean).join(' ');
  var score = scoreCandidate_(sourceText, criteria);
  return {
    fullName: parsed.fullName,
    firstName: parsed.firstName,
    lastName: parsed.lastName,
    title: parsed.title,
    company: parsed.company,
    location: '',
    linkedinUrl: link,
    discoveryProvider: 'GOOGLE_CSE',
    sourceUrl: link,
    sourceSnippet: asText_(item.snippet, 3000),
    whyRelevant: score.reasons.join('; ') || 'Matched the public profile search criteria.',
    outreachObjective: criteria.objective,
    relevanceScore: score.score
  };
}

function parseLinkedInSearchTitle_(title) {
  var clean = asText_(title, 500)
    .replace(/\s*[|–-]\s*LinkedIn\s*$/i, '')
    .replace(/\s+/g, ' ');
  var parts = clean.split(/\s+(?:-|–|\|)\s+/).map(function (part) {
    return asText_(part, 250);
  }).filter(Boolean);
  var fullName = parts[0] || '';
  var nameParts = fullName.split(/\s+/);
  return {
    fullName: fullName,
    firstName: nameParts[0] || '',
    lastName: nameParts.slice(1).join(' '),
    title: parts[1] || '',
    company: parts[2] || ''
  };
}

function scoreCandidate_(sourceText, criteria) {
  var haystack = asText_(sourceText, 10000).toLowerCase();
  var score = 20;
  var reasons = [];
  var groups = [
    { label: 'role', values: criteria.roles, points: 25 },
    { label: 'seniority', values: criteria.seniority, points: 10 },
    { label: 'company', values: criteria.companies, points: 20 },
    { label: 'industry', values: criteria.industries, points: 15 },
    { label: 'location', values: criteria.locations, points: 10 },
    { label: 'keyword', values: criteria.keywords, points: 5 }
  ];

  groups.forEach(function (group) {
    var matched = group.values.find(function (value) {
      return haystack.indexOf(value.toLowerCase()) !== -1;
    });
    if (matched) {
      score += group.points;
      reasons.push('Matched ' + group.label + ': ' + matched);
    }
  });
  return { score: clamp_(score, 0, 100), reasons: reasons };
}

function discoverWithWebhook_(criteria) {
  var url = getSecret_('DISCOVERY_WEBHOOK_URL', true);
  var response = postJson_(
    url,
    {
      action: 'discover',
      criteria: criteria,
      requestedCount: criteria.count
    },
    getSecret_('DISCOVERY_WEBHOOK_TOKEN', false),
    'Discovery webhook'
  );
  var people = Array.isArray(response) ? response : response.people;
  assert_(Array.isArray(people), 'Discovery webhook must return an array or {"people": [...]}.');
  return people.slice(0, criteria.count).map(function (person) {
    return Object.assign({}, person, {
      discoveryProvider: asText_(person.discoveryProvider, 100) || 'CUSTOM_WEBHOOK',
      outreachObjective: asText_(person.outreachObjective, 1000) || criteria.objective
    });
  });
}

function dedupeCandidates_(candidates) {
  var seen = {};
  return candidates.filter(function (candidate) {
    var keys = candidateDedupeKeys_(candidate);
    if (keys.some(function (key) { return seen[key]; })) {
      return false;
    }
    keys.forEach(function (key) { seen[key] = true; });
    return true;
  });
}
