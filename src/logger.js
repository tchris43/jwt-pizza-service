const { AsyncLocalStorage } = require('node:async_hooks');
const config = require('./config.js');

const confidentialField = /(password|token|jwt|secret|api.?key|authorization|cookie|email|name|stack)/i;
const requestContext = new AsyncLocalStorage();

function getCurrentUserId() {
  return requestContext.getStore()?.userId ?? null;
}

function sanitize(value) {
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, confidentialField.test(key) ? '[REDACTED]' : sanitize(child)])
    );
  }

  if (typeof value === 'string') {
    return value
      .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
      .replace(/\bglc_[A-Za-z0-9_-]+\b/g, '[REDACTED]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]');
  }

  return value;
}

function sanitizeSql(sql) {
  return sql.replace(/'(?:''|\\.|[^'])*'/g, "'[REDACTED]'");
}

async function sendLogToGrafana(event, eventType) {
  const { accountId, apiKey, endpointUrl, source } = config.logging || {};
  if (!accountId || !apiKey || !endpointUrl || !source) {
    return;
  }

  const timestamp = `${Date.now()}000000`;
  const payload = {
    streams: [
      {
        stream: { source, event: eventType },
        values: [[timestamp, JSON.stringify(sanitize(event))]],
      },
    ],
  };

  try {
    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${accountId}:${apiKey}`).toString('base64')}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(`Failed to send log to Grafana (HTTP ${response.status})`);
    }
  } catch {
    console.error('Failed to send log to Grafana');
  }
}

function httpLogger(req, res, next) {
  const requestBody = sanitize(req.body);
  let responseBody;

  const sendJson = res.json.bind(res);
  const sendBody = res.send.bind(res);

  res.json = (body) => {
    responseBody = sanitize(body);
    return sendJson(body);
  };

  res.send = (body) => {
    if (responseBody === undefined) {
      responseBody = sanitize(body);
    }
    return sendBody(body);
  };

  res.once('finish', () => {
    const event = {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      authorizationHeaderPresent: Boolean(req.get('authorization')),
      userId: req.user?.id ?? null,
      requestBody,
      responseBody,
    };

    void sendLogToGrafana(event, 'http');
  });

  requestContext.run({ userId: req.user?.id ?? null }, next);
}

module.exports = { httpLogger, sanitize, sanitizeSql, sendLogToGrafana, getCurrentUserId };
