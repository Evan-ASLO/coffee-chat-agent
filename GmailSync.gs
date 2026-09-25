function saveProspectEdits(input) {
  assert_(input && input.id, 'A prospect id is required.');
  var suppliedLinkedInUrl =
    input.linkedinUrl === undefined ? '' : asText_(input.linkedinUrl, 2048);
  var allowedFields = [
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
    'personalizationNotes',
    'subject',
    'draftBody'
  ];
  var patch = {};
  allowedFields.forEach(function (field) {
    if (input[field] !== undefined) {
      patch[field] = input[field];
    }
  });

  patch.firstName = patch.firstName === undefined ? undefined : asText_(patch.firstName, 120);
  patch.lastName = patch.lastName === undefined ? undefined : asText_(patch.lastName, 120);
  patch.fullName = patch.fullName === undefined ? undefined : asText_(patch.fullName, 250);
  patch.title = patch.title === undefined ? undefined : asText_(patch.title, 300);
  patch.company = patch.company === undefined ? undefined : asText_(patch.company, 250);
  patch.companyDomain =
    patch.companyDomain === undefined ? undefined : normalizeDomain_(patch.companyDomain);
  patch.location = patch.location === undefined ? undefined : asText_(patch.location, 250);
  patch.linkedinUrl =
    patch.linkedinUrl === undefined ? undefined : normalizeLinkedInUrl_(patch.linkedinUrl);
  patch.email = patch.email === undefined ? undefined : normalizeEmail_(patch.email);
  patch.emailConfidence =
    patch.emailConfidence === undefined
      ? undefined
      : clamp_(asNumber_(patch.emailConfidence, 0), 0, 100);
  patch.personalizationNotes =
    patch.personalizationNotes === undefined
      ? undefined
      : asText_(patch.personalizationNotes, 3000);
  patch.subject =
    patch.subject === undefined
      ? undefined
      : asText_(patch.subject, 200).replace(/[\r\n]+/g, ' ');
  patch.draftBody =
    patch.draftBody === undefined ? undefined : asText_(patch.draftBody, APP.MAX_CELL_TEXT);

  Object.keys(patch).forEach(function (key) {
    if (patch[key] === undefined) {
      delete patch[key];
    }
  });
  if (patch.email) {
    assertValidEmail_(patch.email);
  }
  assert_(
    !suppliedLinkedInUrl || patch.linkedinUrl,
    'Enter a valid LinkedIn profile URL.'
  );

  var updated = withScriptLock_(function () {
    var current = findProspect_(input.id);
    assert_(
      [PROSPECT_STATUS.DRAFT_READY, PROSPECT_STATUS.ERROR].indexOf(current.status) !== -1,
      'Only draft-ready or failed prospects can be edited.'
    );
    return patchProspect_(input.id, patch);
  });
  logActivity_('PROSPECT_EDITED', input.id, { fields: Object.keys(patch) });
  return serializeForClient_(updated);
}

function sendProspectEmail(input) {
  assert_(input && input.id, 'A prospect id is required.');
  return serializeForClient_(withScriptLock_(function () {
    var prospect = findProspect_(input.id);
    assert_(
      prospect.status === PROSPECT_STATUS.DRAFT_READY,
      'Only a draft-ready email can be sent.'
    );
    var recipient = normalizeEmail_(input.email || prospect.email);
    var subject = asText_(input.subject || prospect.subject, 200).replace(/[\r\n]+/g, ' ');
    var body = asText_(input.body || prospect.draftBody, APP.MAX_CELL_TEXT);
    assertValidEmail_(recipient);
    assert_(subject, 'Enter an email subject.');
    assert_(body, 'Enter an email body.');

    patchProspect_(prospect.id, {
      status: PROSPECT_STATUS.SENDING,
      email: recipient,
      subject: subject,
      draftBody: body,
      draftApprovedAt: now_(),
      error: ''
    });

    var sentMessage = null;
    try {
      var settings = getSettings_();
      var options = {};
      var senderName = asText_(settings.SENDER_NAME, 150);
      if (senderName) {
        options.name = senderName;
      }
      var draft = GmailApp.createDraft(recipient, subject, body, options);
      sentMessage = draft.send();
      var thread = null;
      try {
        thread = sentMessage.getThread();
      } catch (threadError) {
        console.error(threadError);
      }
      var updated = patchProspect_(prospect.id, {
        status: PROSPECT_STATUS.SENT,
        sentAt: sentMessage.getDate() || now_(),
        gmailThreadId: thread ? thread.getId() : '',
        gmailMessageId: sentMessage.getId(),
        error: ''
      });
      logActivity_('EMAIL_SENT', prospect.id, {
        recipient: recipient,
        gmailMessageId: updated.gmailMessageId,
        gmailThreadId: updated.gmailThreadId
      });
      return updated;
    } catch (error) {
      if (sentMessage) {
        try {
          var recovered = patchProspect_(prospect.id, {
            status: PROSPECT_STATUS.SENT,
            sentAt: sentMessage.getDate() || now_(),
            gmailMessageId: sentMessage.getId(),
            error: 'Email sent, but post-send tracking needed recovery: ' + asText_(error.message, 1200)
          });
          logActivity_('EMAIL_SENT_TRACKING_RECOVERED', prospect.id, {
            recipient: recipient,
            gmailMessageId: recovered.gmailMessageId,
            error: error.message
          });
          return recovered;
        } catch (recoveryError) {
          throw new Error(
            'Gmail sent the message, but the spreadsheet could not be updated. Do not resend. ' +
              'Check Gmail Sent and repair the row manually. Tracking error: ' +
              recoveryError.message
          );
        }
      }
      var current = findProspect_(prospect.id);
      if (current.status === PROSPECT_STATUS.SENDING) {
        patchProspect_(prospect.id, {
          status: PROSPECT_STATUS.ERROR,
          error: asText_(error.message, 3000)
        });
      }
      logActivity_('EMAIL_SEND_FAILED', prospect.id, { error: error.message });
      throw error;
    }
  }));
}

function syncRepliesNow() {
  return serializeForClient_(withScriptLock_(syncReplies_));
}

function syncRepliesTrigger() {
  try {
    withScriptLock_(syncReplies_);
  } catch (error) {
    console.error(error);
    try {
      logActivity_('REPLY_SYNC_FAILED', '', { error: error.message });
    } catch (logError) {
      console.error(logError);
    }
    throw error;
  }
}

function syncReplies_() {
  var settings = getSettings_();
  var lookbackDays = clamp_(asNumber_(settings.REPLY_LOOKBACK_DAYS, 60), 1, 365);
  var cutoff = new Date(now_().getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  var ownEmails = getOwnEmailSet_();
  var eligible = listProspects_().filter(function (prospect) {
    return (
      [PROSPECT_STATUS.SENT, PROSPECT_STATUS.REPLIED].indexOf(prospect.status) !== -1 &&
      prospect.sentAt &&
      new Date(prospect.sentAt).getTime() >= cutoff.getTime()
    );
  });
  var updated = [];
  var errors = [];

  eligible.forEach(function (prospect) {
    try {
      var thread = findProspectThread_(prospect);
      if (!thread) {
        return;
      }
      var latestIncoming = thread.getMessages()
        .filter(function (message) {
          var from = extractEmailAddress_(message.getFrom());
          return (
            from &&
            !ownEmails[from] &&
            message.getDate().getTime() > new Date(prospect.sentAt).getTime()
          );
        })
        .sort(function (left, right) {
          return right.getDate().getTime() - left.getDate().getTime();
        })[0];

      if (!latestIncoming) {
        return;
      }
      var previousReplyTime = prospect.lastReplyAt
        ? new Date(prospect.lastReplyAt).getTime()
        : 0;
      if (latestIncoming.getDate().getTime() <= previousReplyTime) {
        return;
      }

      var changed = patchProspect_(prospect.id, {
        status: PROSPECT_STATUS.REPLIED,
        lastReplyAt: latestIncoming.getDate(),
        replyFrom: extractEmailAddress_(latestIncoming.getFrom()),
        replySnippet: makeReplySnippet_(latestIncoming.getPlainBody()),
        gmailThreadId: thread.getId(),
        error: ''
      });
      logActivity_('REPLY_RECEIVED', prospect.id, {
        from: changed.replyFrom,
        receivedAt: toIsoString_(changed.lastReplyAt)
      });
      updated.push(changed);
    } catch (error) {
      errors.push({
        id: prospect.id,
        name: prospect.fullName,
        error: error.message
      });
    }
  });

  logActivity_('REPLY_SYNC_COMPLETED', '', {
    checked: eligible.length,
    updated: updated.length,
    errors: errors.length
  });
  return {
    checked: eligible.length,
    updated: updated.length,
    prospects: updated,
    errors: errors
  };
}

function findProspectThread_(prospect) {
  if (prospect.gmailThreadId) {
    try {
      var direct = GmailApp.getThreadById(prospect.gmailThreadId);
      if (direct) {
        return direct;
      }
    } catch (error) {
      console.error(error);
    }
  }
  if (!prospect.email || !prospect.sentAt) {
    return null;
  }
  var date = Utilities.formatDate(
    new Date(prospect.sentAt),
    Session.getScriptTimeZone(),
    'yyyy/MM/dd'
  );
  var subject = asText_(prospect.subject, 200).replace(/"/g, '');
  var query =
    'in:anywhere from:' +
    prospect.email +
    ' after:' +
    date +
    (subject ? ' subject:"' + subject + '"' : '');
  var threads = GmailApp.search(query, 0, 5);
  return threads.length ? threads[0] : null;
}

function getOwnEmailSet_() {
  var values = []
    .concat(GmailApp.getAliases() || [])
    .concat([
      Session.getEffectiveUser().getEmail(),
      Session.getActiveUser().getEmail()
    ]);
  return values.reduce(function (result, value) {
    var email = normalizeEmail_(value);
    if (email) {
      result[email] = true;
    }
    return result;
  }, {});
}

function extractEmailAddress_(fromHeader) {
  var value = asText_(fromHeader, 500);
  var bracketMatch = value.match(/<([^>]+)>/);
  var email = bracketMatch ? bracketMatch[1] : value;
  return normalizeEmail_(email.replace(/^mailto:/i, ''));
}

function makeReplySnippet_(body) {
  var text = asText_(body, 10000)
    .split(/\nOn .+wrote:\s*$/im)[0]
    .split(/\nFrom:\s.+$/im)[0]
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return asText_(text, 1000);
}

function assertValidEmail_(email) {
  assert_(
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizeEmail_(email)),
    'Enter a valid email address.'
  );
}
