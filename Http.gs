function fetchJson_(url, options, label) {
  var requestOptions = Object.assign(
    {
      method: 'get',
      muteHttpExceptions: true,
      followRedirects: true
    },
    options || {}
  );
  var response = UrlFetchApp.fetch(url, requestOptions);
  var status = response.getResponseCode();
  var body = response.getContentText();

  if (status < 200 || status >= 300) {
    throw new Error(
      (label || 'External service') +
        ' returned HTTP ' +
        status +
        ': ' +
        asText_(body, 800)
    );
  }
  assert_(body, (label || 'External service') + ' returned an empty response.');
  return parseJson_(body, label || 'External service response');
}

function postJson_(url, payload, token, label) {
  var headers = {
    Accept: 'application/json'
  };
  if (token) {
    headers.Authorization = 'Bearer ' + token;
  }
  return fetchJson_(
    url,
    {
      method: 'post',
      contentType: 'application/json',
      headers: headers,
      payload: JSON.stringify(payload)
    },
    label
  );
}

function fetchJsonWithRetry_(url, options, label, maxAttempts) {
  var attempts = clamp_(asNumber_(maxAttempts, 3), 1, 5);
  var lastError;
  for (var attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return fetchJson_(url, options, label);
    } catch (error) {
      lastError = error;
      if (!isRetryableHttpError_(error) || attempt === attempts) {
        throw error;
      }
      Utilities.sleep(700 * Math.pow(2, attempt - 1));
    }
  }
  throw lastError;
}

function isRetryableHttpError_(error) {
  var message = error && error.message ? error.message : String(error || '');
  return /returned HTTP (?:429|500|502|503|504)\b/.test(message);
}

function buildQueryString_(params) {
  return Object.keys(params)
    .filter(function (key) {
      return params[key] !== '' && params[key] !== null && params[key] !== undefined;
    })
    .map(function (key) {
      return encodeURIComponent(key) + '=' + encodeURIComponent(String(params[key]));
    })
    .join('&');
}
