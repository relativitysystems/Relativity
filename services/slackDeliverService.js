'use strict';

// Orchestrates POST /api/integrations/slack/deliver — AIKB's callback once
// it has an answer (or has given up) for a previously-enqueued Slack
// question (Architecture Review Phase 4, Milestone 4, §4.3, §4.8, §4.13).
// The service-request envelope itself is verified by Express middleware
// (services/serviceRequestAuth.js via requireServiceRequestMiddleware in
// the route) before this module runs — clientId/idempotencyKey here are
// already trusted.

const defaultOauthConnectionsService = require('./oauthConnectionsService');
const defaultSlackEventLogService = require('./slackEventLogService');
const defaultSlackDeliveryService = require('./slackDeliveryService');
const { formatSlackMessage, FALLBACK } = require('./slackAnswerFormatter');

const RESULT = Object.freeze({
  DELIVERED: 'delivered',
  ALREADY_PROCESSED: 'already_processed',
  UNKNOWN_EVENT: 'unknown_event',
  CLIENT_MISMATCH: 'client_mismatch',
  CONNECTION_REVOKED: 'connection_revoked',
  DELIVERY_FAILED: 'delivery_failed',
});

function createSlackDeliverService({
  oauthConnectionsService = defaultOauthConnectionsService,
  slackEventLogService = defaultSlackEventLogService,
  slackDeliveryService = defaultSlackDeliveryService,
} = {}) {
  /**
   * @param {object} params
   * @param {string} params.clientId - from the verified envelope, never the payload.
   * @param {string} params.idempotencyKey - from the verified envelope.
   * @param {object} params.payload - { error: true, errorCode } OR { answer, sources, isKnowledgeGap, gapReason, sessionId }.
   */
  async function handleDeliverCallback({ clientId, idempotencyKey, payload }) {
    const row = await slackEventLogService.getByIdempotencyKey(idempotencyKey);
    if (!row) {
      return { result: RESULT.UNKNOWN_EVENT };
    }
    if (row.client_id !== clientId) {
      // Envelope's clientId must match the event's own resolved clientId —
      // never trust a callback to deliver into a different organization's
      // Slack workspace than the one that originated the question.
      return { result: RESULT.CLIENT_MISMATCH };
    }

    const claimed = await slackEventLogService.claimForDelivery(row.id);
    if (!claimed) {
      // Not in 'enqueued' state — either already answered/delivered/failed,
      // or a concurrent callback already won the claim. Safe no-op.
      return { result: RESULT.ALREADY_PROCESSED };
    }

    const connection = await oauthConnectionsService.getConnectionById(row.connection_id);
    if (!connection || connection.status !== 'active') {
      await slackEventLogService.markFailed(row.id, { errorCode: 'CONNECTION_REVOKED' });
      return { result: RESULT.CONNECTION_REVOKED };
    }

    const text = payload && payload.error === true
      ? FALLBACK.TEMPORARY_FAILURE
      : formatSlackMessage({
        answer: payload && payload.answer,
        sources: payload && payload.sources,
        isKnowledgeGap: !!(payload && payload.isKnowledgeGap),
      });

    try {
      const credential = await oauthConnectionsService.getDecryptedCredentialForConnection(connection.id);
      if (!credential) throw new Error('no credential');

      await slackDeliveryService.postMessage({
        botToken: credential.accessToken,
        channel: row.channel_id,
        threadTs: row.thread_ts || row.event_ts,
        text,
      });

      await slackEventLogService.markDelivered(row.id, {
        responseMetadata: { isKnowledgeGap: !!(payload && payload.isKnowledgeGap) },
      });
      return { result: RESULT.DELIVERED };
    } catch (err) {
      await slackEventLogService.markFailed(row.id, { errorCode: err.code || 'SLACK_DELIVERY_FAILED' });
      return { result: RESULT.DELIVERY_FAILED, errorCode: err.code || 'SLACK_DELIVERY_FAILED' };
    }
  }

  return { handleDeliverCallback };
}

const defaultService = createSlackDeliverService();

module.exports = {
  ...defaultService,
  createSlackDeliverService,
  RESULT,
};
