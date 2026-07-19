'use strict';

// Shared terminal-state handling for ADR-007's bounded Slack delivery
// retries. Used by both the /deliver callback (services/slackDeliverService.js)
// and the initial Slack /events flow (services/slackEventsService.js, for
// the fast accept-and-enqueue call to AIKB and the empty-question direct
// reply) so "reaching delivery_failed always redacts customer content" is
// implemented exactly once, not duplicated per call site.

const defaultSlackEventLogService = require('./slackEventLogService');
const defaultAikbRedactClient = require('./aikbRedactClient');

function createSlackDeliveryFailureService({
  slackEventLogService = defaultSlackEventLogService,
  aikbRedactClient = defaultAikbRedactClient,
} = {}) {
  /**
   * Marks a slack_event_log row delivery_failed — which redacts the row's
   * own `question` column in the same UPDATE, see
   * slackEventLogService.markDeliveryFailed — and best-effort redacts any
   * AIKB-side chat session/message content tied to the same idempotency
   * key.
   *
   * AIKB-side redaction is best-effort: a failure to reach AIKB is logged,
   * never thrown. The row's own terminal status and redaction is the one
   * guarantee this function makes; ADR-007 already accepts that this design
   * favors simplicity over an absolute guarantee (no scheduled retry exists
   * to revisit a failed redaction call either) — see ADR-007's Consequences
   * section.
   *
   * @param {object} params
   * @param {object} params.row - the slack_event_log row (needs id, client_id, idempotency_key).
   * @param {string} params.errorCode - safe, non-raw error code.
   * @param {number} [params.attemptCount] - total delivery attempts made.
   * @param {boolean} [params.skipAikbRedact] - true when no AIKB-side content could exist for this row (e.g. the empty-question reply, which never called AIKB).
   */
  async function finalizeDeliveryFailure({ row, errorCode, attemptCount, skipAikbRedact = false }) {
    await slackEventLogService.markDeliveryFailed(row.id, { errorCode, attemptCount });

    if (skipAikbRedact) return;

    try {
      await aikbRedactClient.redact({ clientId: row.client_id, idempotencyKey: row.idempotency_key });
    } catch (err) {
      console.error('[slack delivery] AIKB redact callback failed:', err.code || 'AIKB_REDACT_FAILED');
    }
  }

  return { finalizeDeliveryFailure };
}

const defaultService = createSlackDeliveryFailureService();

module.exports = {
  ...defaultService,
  createSlackDeliveryFailureService,
};
