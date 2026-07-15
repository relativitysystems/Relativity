'use strict';

// Slack chat.postMessage delivery (Architecture Review Phase 4, Milestone 4,
// §4.13). Kept separate from services/slackService.js (OAuth-only, per its
// own file comment) and from anything AIKB-facing. This service only
// performs delivery — it never calls AIKB and never implements retrieval
// logic.
//
// The bot token is decrypted server-side, in memory, immediately before
// use, and is NEVER logged, returned, or included in a thrown error
// message. It never crosses into AIKB or into any Slack-facing response.

const axios = require('axios');

const SLACK_API_URL = 'https://slack.com/api/chat.postMessage';
const DEFAULT_TIMEOUT_MS = 8000;

const ERROR_CODES = Object.freeze({
  NO_ACTIVE_CONNECTION: 'SLACK_NO_ACTIVE_CONNECTION',
  HTTP_ERROR: 'SLACK_DELIVERY_HTTP_ERROR',
  INVALID_RESPONSE: 'SLACK_DELIVERY_INVALID_RESPONSE',
  NOT_OK: 'SLACK_DELIVERY_NOT_OK',
  TIMEOUT: 'SLACK_DELIVERY_TIMEOUT',
});

function createSlackDeliveryError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * @param {object} [deps]
 * @param {object} [deps.httpClient] - DI'd for tests; defaults to axios.
 */
function createSlackDeliveryService({ httpClient = axios } = {}) {
  /**
   * @param {object} params
   * @param {string} params.botToken - decrypted xoxb- token. Never logged.
   * @param {string} params.channel - Slack channel_id.
   * @param {string} params.threadTs - thread_ts to reply into.
   * @param {string} params.text - pre-formatted mrkdwn text (services/slackAnswerFormatter.js).
   */
  async function postMessage({ botToken, channel, threadTs, text }) {
    if (!botToken) throw createSlackDeliveryError(ERROR_CODES.NO_ACTIVE_CONNECTION, 'No active Slack bot token available for delivery.');
    if (!channel) throw new Error('postMessage requires channel');
    if (!threadTs) throw new Error('postMessage requires threadTs');
    if (typeof text !== 'string' || !text) throw new Error('postMessage requires non-empty text');

    let response;
    try {
      response = await httpClient.post(
        SLACK_API_URL,
        { channel, thread_ts: threadTs, text, unfurl_links: false, unfurl_media: false },
        {
          headers: {
            Authorization: `Bearer ${botToken}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          timeout: DEFAULT_TIMEOUT_MS,
        }
      );
    } catch (err) {
      // axios error objects can retain request config (including the
      // Authorization header) — never rethrow err or err.message verbatim.
      if (err.code === 'ECONNABORTED') {
        throw createSlackDeliveryError(ERROR_CODES.TIMEOUT, 'Slack delivery timed out.');
      }
      throw createSlackDeliveryError(ERROR_CODES.HTTP_ERROR, 'Slack delivery request failed.');
    }

    if (!response || response.status < 200 || response.status >= 300) {
      throw createSlackDeliveryError(ERROR_CODES.HTTP_ERROR, `Slack delivery returned HTTP ${response ? response.status : 'unknown'}.`);
    }

    const data = response.data;
    if (!data || typeof data !== 'object') {
      throw createSlackDeliveryError(ERROR_CODES.INVALID_RESPONSE, 'Slack delivery returned an invalid response body.');
    }
    if (data.ok !== true) {
      throw createSlackDeliveryError(ERROR_CODES.NOT_OK, 'Slack delivery was rejected by the Slack API.');
    }

    return { ts: data.ts || null, channel: data.channel || channel };
  }

  return { postMessage };
}

const defaultService = createSlackDeliveryService();

module.exports = {
  ...defaultService,
  createSlackDeliveryService,
  ERROR_CODES,
};
