'use strict';

// Orchestrates POST /api/integrations/slack/events end-to-end (Architecture
// Review Phase 4, Milestone 4, §4.3-§4.9). Signature verification itself
// happens in Express middleware (services/slackSignatureService.js) before
// this module ever runs — everything here operates on an ALREADY-VERIFIED
// event. Composes the smaller focused services, matching this repo's
// existing convention (services/slackIntegrationService.js).
//
// Never trusts team_id/channel_id/user_id/client_id from anywhere but a
// verified event + a database lookup. Never logs message or answer text.

const defaultOauthConnectionsService = require('./oauthConnectionsService');
const defaultSupabaseService = require('./supabaseService');
const defaultSlackEventLogService = require('./slackEventLogService');
const defaultSlackDeliveryService = require('./slackDeliveryService');
const defaultAikbAskClient = require('./aikbAskClient');
const defaultSlackCollectionAccessService = require('./slackCollectionAccessService');
const { extractQuestion, EMPTY_QUESTION_REPLY } = require('./slackQuestionService');
const { FALLBACK } = require('./slackAnswerFormatter');

const PROVIDER = 'slack';

// Sweep tuning (§4.8) — a stuck row is retried after this many ms with no
// progress, capped at this many total attempts before being marked failed.
const SWEEP_STALE_AFTER_MS = 30_000;
const SWEEP_MAX_ATTEMPTS = 3;

// Safe, structured outcome codes for §4.16 metadata-only logging — never a
// message/answer body, never a raw error string.
const OUTCOME = Object.freeze({
  DUPLICATE: 'duplicate',
  UNSUPPORTED_EVENT_TYPE: 'unsupported_event_type',
  BOT_EVENT: 'bot_event',
  SELF_EVENT: 'self_event',
  EDITED_OR_DELETED: 'edited_or_deleted',
  MALFORMED: 'malformed',
  UNKNOWN_WORKSPACE: 'unknown_workspace',
  INACTIVE_ORG: 'inactive_org',
  EMPTY_QUESTION: 'empty_question',
  ENQUEUED: 'enqueued',
  ASK_FAILED: 'ask_failed',
});

function createSlackEventsService({
  oauthConnectionsService = defaultOauthConnectionsService,
  supabaseService = defaultSupabaseService,
  slackEventLogService = defaultSlackEventLogService,
  slackDeliveryService = defaultSlackDeliveryService,
  aikbAskClient = defaultAikbAskClient,
  slackCollectionAccessService = defaultSlackCollectionAccessService,
} = {}) {
  /**
   * Slack's url_verification handshake. Verified by the same signature
   * middleware as event_callback — no special-cased bypass.
   */
  function handleUrlVerification(body) {
    if (!body || body.type !== 'url_verification') return null;
    return { challenge: typeof body.challenge === 'string' ? body.challenge : '' };
  }

  /**
   * Resolves team_id -> exactly one active organization + connection, per
   * §4.6. Any ambiguity, revoked/expired status, or inactive organization is
   * treated as a safe rejection (no throw), since Slack should never see or
   * retry on the details of an internal mapping failure.
   */
  async function resolveWorkspace(teamId) {
    let connection;
    try {
      connection = await oauthConnectionsService.getActiveConnectionByExternalAccount(PROVIDER, teamId);
    } catch (err) {
      // Includes the "more than one active row" case, which the database's
      // partial unique index should already prevent — treated the same as
      // "no mapping" rather than ever surfacing the underlying error.
      return { ok: false, reason: OUTCOME.UNKNOWN_WORKSPACE };
    }
    if (!connection) {
      return { ok: false, reason: OUTCOME.UNKNOWN_WORKSPACE };
    }

    let client;
    try {
      client = await supabaseService.getClientById(connection.client_id);
    } catch (err) {
      return { ok: false, reason: OUTCOME.INACTIVE_ORG };
    }
    if (!client || !client.is_active) {
      return { ok: false, reason: OUTCOME.INACTIVE_ORG };
    }

    return { ok: true, connection, client };
  }

  /**
   * Full event_callback processing. Always resolves (never throws) — every
   * path is a decision about whether/how to safely ack Slack, never an
   * uncaught error that would surface Slack-facing 500s.
   *
   * @returns {{ status: 200, outcome: string, duplicate?: boolean }}
   */
  async function processEventCallback(body) {
    const teamId = body && typeof body.team_id === 'string' ? body.team_id : null;
    const event = body && typeof body.event === 'object' ? body.event : null;
    const eventId = body && typeof body.event_id === 'string' ? body.event_id : null;

    if (!teamId || !event || !eventId) {
      return { status: 200, outcome: OUTCOME.MALFORMED };
    }
    if (event.bot_id) {
      return { status: 200, outcome: OUTCOME.BOT_EVENT };
    }
    if (event.type !== 'app_mention') {
      return { status: 200, outcome: OUTCOME.UNSUPPORTED_EVENT_TYPE };
    }
    if (event.subtype) {
      // message_changed / message_deleted / any other subtype — edits and
      // deletes are never processed, per §4.4.
      return { status: 200, outcome: OUTCOME.EDITED_OR_DELETED };
    }
    if (!event.channel || !event.ts) {
      return { status: 200, outcome: OUTCOME.MALFORMED };
    }

    const workspace = await resolveWorkspace(teamId);
    if (!workspace.ok) {
      return { status: 200, outcome: workspace.reason };
    }
    const { connection, client } = workspace;

    const botUserId = connection.provider_metadata && typeof connection.provider_metadata === 'object'
      ? connection.provider_metadata.bot_user_id
      : null;

    if (botUserId && event.user === botUserId) {
      return { status: 200, outcome: OUTCOME.SELF_EVENT };
    }

    const threadTs = event.thread_ts || event.ts;
    const idempotencyKey = `slack:${eventId}`;
    const extraction = extractQuestion(event.text, botUserId);

    const { inserted, row } = await slackEventLogService.insertReceived({
      externalEventId: eventId,
      clientId: client.id,
      connectionId: connection.id,
      eventType: event.type,
      channelId: event.channel,
      eventTs: event.ts,
      threadTs: event.thread_ts || null,
      question: extraction.ok ? extraction.question : null,
      idempotencyKey,
    });

    if (!inserted) {
      return { status: 200, outcome: OUTCOME.DUPLICATE, duplicate: true };
    }

    if (!extraction.ok) {
      await replyDirectly({ connection, channel: event.channel, threadTs, text: EMPTY_QUESTION_REPLY, row, slackEventLogService, slackDeliveryService, oauthConnectionsService });
      return { status: 200, outcome: OUTCOME.EMPTY_QUESTION };
    }

    try {
      // Milestone 5: look up which collections this org currently allows
      // Slack to search, fresh at request time (not a snapshot), and pass
      // them into the signed envelope AIKB enforces retrieval against.
      const allowedCollectionIds = await slackCollectionAccessService.getAllowedCollectionIds(client.id);
      const { eventId: aikbEventId } = await aikbAskClient.ask({
        clientId: client.id,
        question: extraction.question,
        idempotencyKey,
        originMetadata: {
          teamId,
          channelId: event.channel,
          threadTs,
          eventId,
        },
        allowedCollectionIds,
      });
      await slackEventLogService.markEnqueued(row.id);
      return { status: 200, outcome: OUTCOME.ENQUEUED, aikbEventId };
    } catch (err) {
      // The fast accept-and-enqueue call failed (AIKB down/slow/timeout).
      // Leave the row at 'received' — the sweep will retry it. Slack still
      // gets a prompt 200; nothing about a downstream outage is Slack's to
      // retry, since redelivery would just hit the same dedup row anyway.
      return { status: 200, outcome: OUTCOME.ASK_FAILED, errorCode: err.code || 'ASK_FAILED' };
    }
  }

  /**
   * Retry backstop (§4.8): finds slack_event_log rows stuck in
   * received/enqueued past a timeout and retries them, bounded by
   * SWEEP_MAX_ATTEMPTS. A row that reaches the cap is marked 'failed' and
   * gets a best-effort "temporary failure" Slack reply so the user isn't
   * left with silence — never re-attempted after that. A 'delivered' row is
   * never touched, and this function never calls AIKB or Slack for one.
   */
  async function runDeliverySweep({ staleAfterMs = SWEEP_STALE_AFTER_MS, maxAttempts = SWEEP_MAX_ATTEMPTS } = {}) {
    const stuckRows = await slackEventLogService.listStuckForRetry({ staleAfterMs, maxAttempts });
    const results = [];

    for (const row of stuckRows) {
      results.push(await retryStuckRow(row, maxAttempts));
    }

    return { processed: results.length, results };
  }

  async function retryStuckRow(row, maxAttempts) {
    const nextAttempt = (row.attempt_count || 0) + 1;

    if (nextAttempt >= maxAttempts) {
      await bestEffortFailureReply(row);
      await slackEventLogService.markFailed(row.id, { errorCode: 'RETRY_ATTEMPTS_EXHAUSTED', attemptCount: nextAttempt });
      return { id: row.id, outcome: 'failed' };
    }

    let connection;
    try {
      connection = await oauthConnectionsService.getConnectionById(row.connection_id);
    } catch (err) {
      await slackEventLogService.incrementAttempt(row.id);
      return { id: row.id, outcome: 'retry_lookup_failed' };
    }
    if (!connection || connection.status !== 'active') {
      await slackEventLogService.markFailed(row.id, { errorCode: 'CONNECTION_REVOKED', attemptCount: nextAttempt });
      return { id: row.id, outcome: 'connection_revoked' };
    }

    try {
      // Re-fetched fresh at retry time rather than snapshotted on the
      // slack_event_log row — a settings change becoming visible on the
      // next retry is an acceptable trade-off for this milestone's "keep it
      // simple" scope, and avoids a schema change to slack_event_log.
      const allowedCollectionIds = await slackCollectionAccessService.getAllowedCollectionIds(row.client_id);
      await aikbAskClient.ask({
        clientId: row.client_id,
        question: row.question,
        idempotencyKey: row.idempotency_key,
        originMetadata: {
          teamId: connection.external_account_id,
          channelId: row.channel_id,
          threadTs: row.thread_ts || row.event_ts,
          eventId: row.external_event_id,
        },
        allowedCollectionIds,
      });
      await slackEventLogService.markEnqueued(row.id);
      await slackEventLogService.incrementAttempt(row.id);
      return { id: row.id, outcome: 'reenqueued' };
    } catch (err) {
      await slackEventLogService.incrementAttempt(row.id);
      return { id: row.id, outcome: 'ask_retry_failed' };
    }
  }

  async function bestEffortFailureReply(row) {
    try {
      const connection = await oauthConnectionsService.getConnectionById(row.connection_id);
      if (!connection || connection.status !== 'active') return;
      const credential = await oauthConnectionsService.getDecryptedCredentialForConnection(connection.id);
      if (!credential) return;
      await slackDeliveryService.postMessage({
        botToken: credential.accessToken,
        channel: row.channel_id,
        threadTs: row.thread_ts || row.event_ts,
        text: FALLBACK.TEMPORARY_FAILURE,
      });
    } catch (err) {
      // Best-effort only — the row is marked 'failed' by the caller
      // regardless of whether this reply succeeded.
    }
  }

  return {
    handleUrlVerification,
    resolveWorkspace,
    processEventCallback,
    runDeliverySweep,
    OUTCOME,
  };
}

/**
 * Shared helper: posts a direct, static reply (used only for the empty-
 * question fallback, which needs no AIKB round trip) and records the
 * outcome on the slack_event_log row. Failures here are logged but never
 * thrown — Slack has already been (or is about to be) ack'd regardless.
 */
async function replyDirectly({ connection, channel, threadTs, text, row, slackEventLogService, slackDeliveryService, oauthConnectionsService }) {
  try {
    const credential = await oauthConnectionsService.getDecryptedCredentialForConnection(connection.id);
    if (!credential) throw new Error('no credential');
    await slackDeliveryService.postMessage({ botToken: credential.accessToken, channel, threadTs, text });
    await slackEventLogService.markDelivered(row.id);
  } catch (err) {
    await slackEventLogService.markFailed(row.id, { errorCode: 'EMPTY_QUESTION_REPLY_FAILED', attemptCount: 1 }).catch(() => {});
  }
}

const defaultService = createSlackEventsService();

module.exports = {
  ...defaultService,
  createSlackEventsService,
  OUTCOME,
};
