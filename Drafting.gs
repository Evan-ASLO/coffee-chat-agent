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
  } else if (provider === 'TEMPLATE') {
    result = draftWithTemplate_(prospect, context, settings);
  } else if (provider === 'CUSTOM_WEBHOOK') {
    result = draftWithWebhook_(prospect, context, settings);
  } else {
    throw new Error('Unsupported draft provider: ' + provider);
  }
  return validateDraft_(result, settings);
}

function draftWithGemini_(prospect, context, settings) {
  var model = asText_(settings.GEMINI_MODEL, 150) || 'gemini-2.5-flash';
  var prompt = buildDraftPrompt_(prospect, context, settings);
  var response = fetchJson_(
    'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) +
      ':generateContent?' +
      buildQueryString_({ key: getSecret_('GEMINI_API_KEY', true) }),
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          temperature: 0.45,
          maxOutputTokens: 700,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            required: ['subject', 'body', 'personalizationNotes'],
            properties: {
              subject: { type: 'STRING' },
              body: { type: 'STRING' },
              personalizationNotes: { type: 'STRING' }
            }
          }
        }
      })
    },
    'Gemini'
  );
  var candidates = response.candidates || [];
  assert_(candidates.length > 0, 'Gemini returned no draft candidate.');
  var parts = (((candidates[0] || {}).content || {}).parts || []);
  var text = parts.map(function (part) { return part.text || ''; }).join('');
  assert_(text, 'Gemini returned an empty draft.');
  return parseJson_(text.replace(/^```json\s*|\s*```$/g, ''), 'Gemini draft');
}

function buildDraftPrompt_(prospect, context, settings) {
  var wordLimit = clamp_(asNumber_(settings.EMAIL_WORD_LIMIT, 140), 60, 250);
  return [
    'Write one highly personalized professional coffee-chat email.',
    '',
    'Non-negotiable rules:',
    '- Use only facts present in the PERSON and SENDER_CONTEXT JSON below.',
    '- Never invent a shared connection, achievement, employer fact, or personal experience.',
    '- Do not imply that the sender read content not included below.',
    '- Mention at most one specific sender experience, and only when genuinely relevant.',
    '- Be warm, concise, specific, and low pressure.',
    '- Ask for a 15-20 minute conversation.',
    '- Keep the body at or under ' + wordLimit + ' words.',
    '- Output plain text, not Markdown.',
    '- Do not use placeholders.',
    '- Sign the message with the sender name.',
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
      'personalizationNotes must briefly identify exactly which supplied facts were used.'
  ].join('\n');
}

function draftWithTemplate_(prospect, context, settings) {
  var contextMap = context.reduce(function (result, item) {
    result[item.category.toLowerCase()] = item.content;
    return result;
  }, {});
  var firstName = prospect.firstName || prospect.fullName;
  var roleDescription = [prospect.title, prospect.company ? 'at ' + prospect.company : '']
    .filter(Boolean)
    .join(' ');
  var background = contextMap['background summary'] || '';
  var goal = contextMap['current goal'] || asText_(settings.OUTREACH_GOAL, 1000);
  var experience = contextMap['experience to reference'] || '';
  var interests = contextMap.interests || '';
  var personalSentence = experience || background || interests;
  var lines = [
    'Hi ' + firstName + ',',
    '',
    roleDescription
      ? 'I came across your background as ' + roleDescription + ' and would value learning from your experience.'
      : 'I came across your professional background and would value learning from your experience.',
    personalSentence ? personalSentence : '',
    goal ? 'My current goal is: ' + stripTerminalPunctuation_(goal) + '.' : '',
    'Would you be open to a 15-20 minute coffee chat in the next few weeks? I would be grateful for the chance to hear about your path and perspective.',
    '',
    'Best,',
    asText_(settings.SENDER_NAME, 150)
  ].filter(function (line, index, all) {
    return line || (index > 0 && all[index - 1] !== '');
  });
  return {
    subject: prospect.company
      ? 'Learning about your experience at ' + prospect.company
      : 'Coffee chat request',
    body: lines.join('\n'),
    personalizationNotes:
      'Template used the supplied role/company and the sender context field: ' +
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
