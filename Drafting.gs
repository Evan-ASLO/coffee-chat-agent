function draftOutreach_(prospect, settings) {
  var context = getUsablePersonalContext_();
  var factualContext = context.filter(function (item) {
    return ['tone', 'avoid'].indexOf(item.category.toLowerCase()) === -1;
  });
  assert_(
    factualContext.length > 0,
    'Add at least one real background, goal, experience, interest, or sample email before preparing drafts.'
  );
  var senderName = asText_(settings.SENDER_NAME, 150);
  assert_(senderName, 'Set SENDER_NAME before preparing drafts.');

  var provider = asText_(settings.DRAFT_PROVIDER, 100).toUpperCase();
  var result;
  if (provider === 'GEMINI') {
    result = draftWithGemini_(prospect, context, settings);
  } else if (provider === 'OPENAI') {
    result = draftWithOpenAI_(prospect, context, settings);
  } else if (provider === 'ANTHROPIC') {
    result = draftWithAnthropic_(prospect, context, settings);
  } else if (provider === 'TEMPLATE') {
    result = draftWithTemplate_(prospect, context, settings);
  } else if (provider === 'CUSTOM_WEBHOOK') {
    result = draftWithWebhook_(prospect, context, settings);
  } else {
    throw new Error('Unsupported draft provider: ' + provider);
  }
  return validateDraft_(result, settings);
}

function regenerateProspectDraft(id) {
  var prospectId = asText_(id, 100);
  assert_(prospectId, 'A prospect id is required.');
  var prospect = withScriptLock_(function () {
    var current = findProspect_(prospectId);
    assert_(
      current.status === PROSPECT_STATUS.DRAFT_READY,
      'Only a draft-ready prospect can be regenerated.'
    );
    return patchProspect_(prospectId, {
      status: PROSPECT_STATUS.PREPARING,
      draftApprovedAt: '',
      error: ''
    });
  });

  try {
    var settings = getSettings_();
    var draft = draftOutreach_(prospect, settings);
    var updated = withScriptLock_(function () {
      return patchProspect_(prospectId, {
        status: PROSPECT_STATUS.DRAFT_READY,
        personalizationNotes: draft.personalizationNotes,
        subject: draft.subject,
        draftBody: draft.body,
        error: ''
      });
    });
    logActivity_('DRAFT_REGENERATED', prospectId, {
      draftProvider: settings.DRAFT_PROVIDER,
      model: getConfiguredDraftModel_(settings)
    });
    return serializeForClient_(updated);
  } catch (error) {
    withScriptLock_(function () {
      var current = findProspect_(prospectId);
      if (current.status === PROSPECT_STATUS.PREPARING) {
        patchProspect_(prospectId, {
          status: PROSPECT_STATUS.DRAFT_READY,
          error: asText_(error.message, 3000)
        });
      }
    });
    logActivity_('DRAFT_REGENERATION_FAILED', prospectId, {
      error: error.message
    });
    throw error;
  }
}

function getConfiguredDraftModel_(settings) {
  var provider = asText_(settings.DRAFT_PROVIDER, 100).toUpperCase();
  if (provider === 'OPENAI') {
    return asText_(settings.OPENAI_MODEL, 150);
  }
  if (provider === 'ANTHROPIC') {
    return asText_(settings.ANTHROPIC_MODEL, 150);
  }
  if (provider === 'GEMINI') {
    return asText_(settings.GEMINI_MODEL, 150);
  }
  return '';
}

function draftWithGemini_(prospect, context, settings) {
  var model = asText_(settings.GEMINI_MODEL, 150) || 'gemini-3.8-flash';
  var prompt = buildDraftPrompt_(prospect, context, settings);
  var models = [model];
  if (model === 'gemini-3.8-flash') {
    models.push('gemini-3.7-flash');
  }
  var response;
  var usedModel = model;
  var lastError;
  models.some(function (candidateModel) {
    try {
      response = requestGeminiDraft_(candidateModel, prompt);
      usedModel = candidateModel;
      return true;
    } catch (error) {
      lastError = error;
      if (!isRetryableHttpError_(error) || candidateModel === models[models.length - 1]) {
        throw error;
      }
      return false;
    }
  });
  if (!response) {
    throw lastError || new Error('Gemini returned no response.');
  }
  var draft = parseDraftJsonText_(
    extractGeminiInteractionText_(response),
    'Gemini draft'
  );
  if (usedModel !== model) {
    draft.personalizationNotes =
      'Gemini fallback model used: ' + usedModel + '. ' +
      asText_(draft.personalizationNotes, 2800);
  }
  return draft;
}

function requestGeminiDraft_(model, prompt) {
  return fetchJsonWithRetry_(
    'https://generativelanguage.googleapis.com/v1beta/interactions',
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-goog-api-key': getSecret_('GEMINI_API_KEY', true)
      },
      payload: JSON.stringify({
        model: model,
        input: prompt,
        system_instruction: 'Return only the requested valid JSON object with no Markdown or commentary.',
        store: false,
        generation_config: {
          temperature: 0.45,
          max_output_tokens: 700,
          thinking_level: 'low'
        }
      })
    },
    'Gemini',
    3
  );
}

function extractGeminiInteractionText_(response) {
  if (typeof response.output_text === 'string' && response.output_text) {
    return response.output_text;
  }
  return (response.steps || []).reduce(function (parts, step) {
    if (step.type !== 'model_output') {
      return parts;
    }
    (step.content || []).forEach(function (block) {
      if (block.type === 'text' && block.text) {
        parts.push(block.text);
      }
    });
    return parts;
  }, []).join('');
}

function draftWithOpenAI_(prospect, context, settings) {
  var model = asText_(settings.OPENAI_MODEL, 150) || 'gpt-5-mini';
  var response = fetchJsonWithRetry_(
    'https://api.openai.com/v1/responses',
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: 'Bearer ' + getSecret_('OPENAI_API_KEY', true)
      },
      payload: JSON.stringify({
        model: model,
        input: buildDraftPrompt_(prospect, context, settings),
        max_output_tokens: 700
      })
    },
    'OpenAI',
    3
  );
  return parseDraftJsonText_(extractOpenAIText_(response), 'OpenAI draft');
}

function draftWithAnthropic_(prospect, context, settings) {
  var model = asText_(settings.ANTHROPIC_MODEL, 150) || 'claude-haiku-4-5';
  var response = fetchJsonWithRetry_(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': getSecret_('ANTHROPIC_API_KEY', true),
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify({
        model: model,
        max_tokens: 700,
        system: 'Return only the requested valid JSON object with no Markdown or commentary.',
        messages: [{
          role: 'user',
          content: buildDraftPrompt_(prospect, context, settings)
        }]
      })
    },
    'Anthropic',
    3
  );
  var text = (response.content || [])
    .filter(function (block) { return block.type === 'text'; })
    .map(function (block) { return block.text || ''; })
    .join('');
  return parseDraftJsonText_(text, 'Anthropic draft');
}

function buildDraftPrompt_(prospect, context, settings) {
  var wordLimit = clamp_(asNumber_(settings.EMAIL_WORD_LIMIT, 140), 60, 250);
  return [
    'Write one recipient-focused professional coffee-chat email.',
    '',
    'Non-negotiable rules:',
    '- Use only facts present in the PERSON and SENDER_CONTEXT JSON below.',
    '- Never invent a shared connection, achievement, employer fact, or personal experience.',
    '- Do not imply that the sender read content not included below.',
    '- The opening and the majority of the email must focus on the recipient.',
    '- Use the recipient role, company, public snippet, or relevance evidence to explain why this specific person was selected.',
    '- Include at most one short sentence about the sender, and only to establish genuine relevance.',
    '- Ask about one concrete recipient-specific topic, decision, transition, or area of experience supported by the supplied evidence.',
    '- Do not use generic praise or make the sender the main subject.',
    '- Do not open with the sender background or goals.',
    '- Be warm, concise, specific, and low pressure.',
    '- Ask for a 15-minute conversation.',
    '- Keep the body at or under ' + wordLimit + ' words.',
    '- Output plain text, not Markdown.',
    '- Do not use placeholders.',
    '- Sign the message with the sender name.',
    '- Return only JSON.',
    '',
    'OUTREACH_GOAL:',
    asText_(prospect.outreachObjective, 1000) || asText_(settings.OUTREACH_GOAL, 1000),
    '',
    'SENDER_NAME:',
    asText_(settings.SENDER_NAME, 150),
    '',
    'PERSON:',
    JSON.stringify({
      firstName: prospect.firstName,
      fullName: prospect.fullName,
      title: prospect.title,
      company: prospect.company,
      location: prospect.location,
      linkedinUrl: prospect.linkedinUrl,
      publicProfileSnippet: prospect.sourceSnippet,
      whyRelevant: prospect.whyRelevant
    }),
    '',
    'SENDER_CONTEXT:',
    JSON.stringify(context),
    '',
    'Return JSON with subject, body, and personalizationNotes. ' +
      'The subject must focus on the recipient. personalizationNotes must identify the exact recipient facts and sender fact used.'
  ].join('\n');
}

function draftWithTemplate_(prospect, context, settings) {
  var contextMap = context.reduce(function (result, item) {
    result[item.category.toLowerCase()] = item.content;
    return result;
  }, {});
  var firstName = prospect.firstName || prospect.fullName;
  var background = contextMap['background summary'] || '';
  var goal = contextMap['current goal'] || asText_(settings.OUTREACH_GOAL, 1000);
  var experience = contextMap['experience to reference'] || '';
  var interests = contextMap.interests || '';
  var personalSource = experience || background || interests;
  var personalSentence = ensureSentence_(truncateWords_(personalSource, 18));
  var goalTopic = toTopicPhrase_(truncateWords_(goal, 18));
  var recipientObservation = buildRecipientObservation_(prospect);
  var lines = [
    'Hi ' + firstName + ',',
    '',
    recipientObservation,
    personalSentence,
    goalTopic ? 'I would especially value your perspective on ' + goalTopic + '.' : '',
    'Would you be open to a 15-minute coffee chat in the next few weeks?',
    '',
    'Best,',
    asText_(settings.SENDER_NAME, 150)
  ].filter(function (line, index, all) {
    return line || (index > 0 && all[index - 1] !== '');
  });
  return {
    subject: prospect.company
      ? 'A question about your work at ' + prospect.company
      : prospect.title
        ? 'Learning from your ' + prospect.title + ' experience'
        : 'Learning from your experience',
    body: lines.join('\n'),
    personalizationNotes:
      'Template centered the recipient role, company, or public profile evidence and used one sender context field: ' +
      (
        experience
          ? 'Experience to reference'
          : background
            ? 'Background summary'
            : interests
              ? 'Interests'
              : 'Current goal'
      ) +
      '.'
  };
}

function draftWithWebhook_(prospect, context, settings) {
  var response = postJson_(
    getSecret_('DRAFT_WEBHOOK_URL', true),
    {
      action: 'draft',
      person: serializeForClient_(prospect),
      senderContext: context,
      settings: {
        senderName: settings.SENDER_NAME,
        outreachGoal: prospect.outreachObjective || settings.OUTREACH_GOAL,
        emailWordLimit: settings.EMAIL_WORD_LIMIT
      }
    },
    getSecret_('DRAFT_WEBHOOK_TOKEN', false),
    'Draft webhook'
  );
  return response.draft || response;
}

function extractOpenAIText_(response) {
  if (typeof response.output_text === 'string' && response.output_text) {
    return response.output_text;
  }
  return (response.output || []).reduce(function (parts, outputItem) {
    (outputItem.content || []).forEach(function (block) {
      if (
        (block.type === 'output_text' || block.type === 'text') &&
        block.text
      ) {
        parts.push(block.text);
      }
    });
    return parts;
  }, []).join('');
}

function parseDraftJsonText_(text, label) {
  var clean = asText_(text, APP.MAX_CELL_TEXT)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  var firstBrace = clean.indexOf('{');
  var lastBrace = clean.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    clean = clean.substring(firstBrace, lastBrace + 1);
  }
  assert_(clean, (label || 'Model draft') + ' was empty.');
  return parseJson_(clean, label || 'Model draft');
}

function buildRecipientObservation_(prospect) {
  var roleDescription = [
    asText_(prospect.title, 300),
    prospect.company ? 'at ' + asText_(prospect.company, 250) : ''
  ].filter(Boolean).join(' ');
  var evidence = truncateWords_(
    prospect.sourceSnippet || prospect.whyRelevant,
    26
  );
  if (roleDescription && evidence) {
    return ensureSentence_(
      'Your work as ' + roleDescription + ' caught my attention, particularly ' +
        lowerFirst_(stripTerminalPunctuation_(evidence))
    );
  }
  if (roleDescription) {
    return 'Your work as ' + roleDescription + ' caught my attention.';
  }
  if (evidence) {
    return ensureSentence_(
      'Your experience caught my attention, particularly ' +
        lowerFirst_(stripTerminalPunctuation_(evidence))
    );
  }
  return 'Your professional experience caught my attention, and I would value learning from your perspective.';
}

function toTopicPhrase_(value) {
  return stripTerminalPunctuation_(asText_(value, 2000))
    .replace(/^(?:i am |i'm )?(?:currently )?(?:hoping|trying|looking) to /i, '')
    .replace(/^(?:to )?(?:learn|learning) about /i, '')
    .replace(/^(?:to )?(?:understand|explore) /i, '')
    .replace(/^request a short coffee chat to /i, '');
}

function lowerFirst_(value) {
  var text = asText_(value, 3000);
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : '';
}

function validateDraft_(draft, settings) {
  var subject = asText_(draft.subject, 200).replace(/[\r\n]+/g, ' ');
  var body = asText_(draft.body, APP.MAX_CELL_TEXT);
  var notes = asText_(draft.personalizationNotes, 3000);
  assert_(subject, 'The generated subject is empty.');
  assert_(body, 'The generated email body is empty.');
  assert_(!/\[[^\]]{1,80}\]/.test(body), 'The draft contains an unresolved placeholder.');

  var wordLimit = clamp_(asNumber_(settings.EMAIL_WORD_LIMIT, 140), 60, 250);
  var wordCount = body.split(/\s+/).filter(Boolean).length;
  assert_(
    wordCount <= wordLimit + 15,
    'The generated email is ' + wordCount + ' words; the limit is ' + wordLimit + '.'
  );
  return {
    subject: subject,
    body: body,
    personalizationNotes: notes,
    wordCount: wordCount
  };
}

function stripTerminalPunctuation_(value) {
  return asText_(value, 2000).replace(/[.!?]+$/, '');
}

function truncateWords_(value, maximumWords) {
  var words = asText_(value, APP.MAX_CELL_TEXT).split(/\s+/).filter(Boolean);
  if (words.length <= maximumWords) {
    return words.join(' ');
  }
  return words.slice(0, maximumWords).join(' ') + '...';
}

function ensureSentence_(value) {
  var text = asText_(value, 3000);
  if (!text || /\.\.\.$/.test(text) || /[.!?]$/.test(text)) {
    return text;
  }
  return text + '.';
}
