'use strict';

// Calls AIKB's POST /api/knowledge/chat/redact once a Slack event reaches
// the terminal delivery_failed state (ADR-007). Best-effort, single
// attempt — by the time this is called, the slack_event_log row has already
// been marked delivery_failed and redacted; a failure here only means the
// AIKB-side chat session/message content for the same idempotency key stays
// un-redacted, which is logged (services/slackDeliveryFailureService.js),
// never thrown back into the Slack request/response flow.
//
// Signs with the same additive HMAC service-request envelope used by
// services/aikbAskClient.js, reused here for the same Relativity -> AIKB
// direction. The payload carries no customer content of its own — only
// clientId/idempotencyKey (via the envelope) identify what to redact.

const axios = require('axios');
const config = require('../config');
const { signServiceRequest } = require('./serviceRequestAuth');

const ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'AIKB_REDACT_NOT_CONFIGURED',
  HTTP_ERROR: 'AIKB_REDACT_HTTP_ERROR',
  TIMEOUT: 'AIKB_REDACT_TIMEOUT',
  INVALID_RESPONSE: 'AIKB_REDACT_INVALID_RESPONSE',
});

function createAikbRedactError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function createAikbRedactClient({ httpClient = axios } = {}) {
  /**
   * @param {object} params
   * @param {string} params.clientId
   * @param {string} params.idempotencyKey - the same "slack:<event_id>" key sent to POST /ask.
   * @returns {Promise<{ redacted: boolean }>}
   */
  async function redact({ clientId, idempotencyKey }) {
    const baseUrl = config.aikb.apiBaseUrl;
    const apiKey = config.aikb.apiKey;
    const signingSecret = config.serviceRequest.signingSecret;

    if (!baseUrl || !apiKey || !signingSecret) {
      throw createAikbRedactError(ERROR_CODES.NOT_CONFIGURED, 'AIKB redact callback is not configured on this server.');
    }

    const payload = {};
    const envelope = signServiceRequest({ clientId, idempotencyKey, payload, secret: signingSecret });

    let response;
    try {
      response = await httpClient.post(
        `${baseUrl.replace(/\/$/, '')}/api/knowledge/chat/redact`,
        { ...envelope, payload },
        {
          headers: {
            'x-api-key': apiKey,
            'Content-Type': 'application/json',
          },
          timeout: config.aikb.redactTimeoutMs,
        }
      );
    } catch (err) {
      if (err.code === 'ECONNABORTED') {
        throw createAikbRedactError(ERROR_CODES.TIMEOUT, 'AIKB redact callback timed out.');
      }
      throw createAikbRedactError(ERROR_CODES.HTTP_ERROR, 'AIKB redact callback failed.');
    }

    if (!response || response.status < 200 || response.status >= 300) {
      throw createAikbRedactError(ERROR_CODES.HTTP_ERROR, `AIKB redact callback returned HTTP ${response ? response.status : 'unknown'}.`);
    }

    const data = response.data;
    if (!data || typeof data !== 'object') {
      throw createAikbRedactError(ERROR_CODES.INVALID_RESPONSE, 'AIKB redact callback returned an invalid response body.');
    }

    return { redacted: !!data.redacted };
  }

  return { redact };
}

const defaultClient = createAikbRedactClient();

module.exports = {
  ...defaultClient,
  createAikbRedactClient,
  ERROR_CODES,
};
