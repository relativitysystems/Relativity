'use strict';

// Event-level idempotency and durable processing state for the Slack
// app_mention Q&A path (Architecture Review Phase 4, Milestone 4, §4.7-§4.8).
// Backs the slack_event_log table (supabase/migrations/20260716_slack_event_log.sql).
//
// Factory pattern + DI'd Supabase client, matching this repo's existing
// convention (services/oauthConnectionsService.js) so every function here is
// unit-testable without a real database.
//
// TODO(ADR-007 metadata retention): once a row reaches a terminal status
// (delivered/failed/delivery_failed), only technical/dedup metadata remains
// (customer content is already redacted on delivery_failed — see
// markDeliveryFailed below). ADR-007 recommends retaining that metadata for
// roughly 30 days, then allowing cleanup — but this is explicitly NOT a
// scheduled Slack delivery retry (which ADR-007 forbids), just routine data
// hygiene, and no such mechanism (cron, Inngest cron trigger, Supabase
// pg_cron, etc.) currently exists in either repository. Do not build one
// speculatively as part of unrelated work — implement it as its own
// reviewed change, consistent with whatever general retention/cleanup
// approach the platform adopts, rather than inventing a Slack-specific one
// here.

const { createClient } = require('@supabase/supabase-js');
const { supabase: supabaseConfig } = require('../config');

const PROVIDER = 'slack';

const STATUS = Object.freeze({
  RECEIVED: 'received',
  ENQUEUED: 'enqueued',
  ANSWERED: 'answered',
  DELIVERED: 'delivered',
  FAILED: 'failed',
  // ADR-007 — terminal state for a Slack delivery that exhausted its bounded
  // in-flow retries (or could never be attempted, e.g. a revoked
  // connection). Distinct from FAILED, which remains the AIKB-generation-
  // failure-notification path's status (unchanged by ADR-007 — see
  // slackDeliverService.js). Never revisited by any scheduled process.
  DELIVERY_FAILED: 'delivery_failed',
});

// Postgres unique_violation.
const UNIQUE_VIOLATION = '23505';

function createSlackEventLogService(client) {
  /**
   * First delivery of a Slack event_id inserts and returns { inserted: true,
   * row }. A redelivery (or a true concurrent race) hits the UNIQUE
   * (provider, external_event_id) constraint and returns { inserted: false,
   * row: <existing row> } instead of throwing, so the caller can always ack
   * Slack 200 without reprocessing.
   *
   * Backlog M13 (revised): no longer accepts/writes a `question` field —
   * slack_event_log stores only operational/dedup metadata now (see
   * supabase/migrations/<date>_slack_event_log_drop_question.sql). The
   * extracted question text is never persisted to Supabase at all.
   */
  async function insertReceived({
    externalEventId, clientId, connectionId, eventType,
    channelId, eventTs, threadTs, idempotencyKey,
  }) {
    if (!externalEventId) throw new Error('insertReceived requires externalEventId');
    if (!clientId) throw new Error('insertReceived requires clientId');
    if (!connectionId) throw new Error('insertReceived requires connectionId');
    if (!idempotencyKey) throw new Error('insertReceived requires idempotencyKey');

    const { data, error } = await client
      .from('slack_event_log')
      .insert({
        provider: PROVIDER,
        external_event_id: externalEventId,
        client_id: clientId,
        connection_id: connectionId,
        event_type: eventType,
        channel_id: channelId,
        event_ts: eventTs,
        thread_ts: threadTs || null,
        idempotency_key: idempotencyKey,
        status: STATUS.RECEIVED,
      })
      .select()
      .single();

    if (!error) return { inserted: true, row: data };

    if (error.code === UNIQUE_VIOLATION) {
      const existing = await getByExternalEventId(externalEventId);
      return { inserted: false, row: existing };
    }

    throw new Error(`insertReceived failed: ${error.message}`);
  }

  /**
   * Used by POST /deliver (§4.3, §4.8) to map an AIKB callback's
   * idempotencyKey (echoed back exactly as sent to POST /ask, "slack:<event_id>")
   * back to the originating row, without re-deriving it from a
   * caller-supplied event_id (the callback's clientId/idempotencyKey come
   * only from the verified service-request envelope — see
   * services/serviceRequestAuth.js).
   */
  async function getByIdempotencyKey(idempotencyKey) {
    const { data, error } = await client
      .from('slack_event_log')
      .select('*')
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (error) throw new Error(`getByIdempotencyKey failed: ${error.message}`);
    return data || null;
  }

  async function getByExternalEventId(externalEventId) {
    const { data, error } = await client
      .from('slack_event_log')
      .select('*')
      .eq('provider', PROVIDER)
      .eq('external_event_id', externalEventId)
      .maybeSingle();
    if (error) throw new Error(`getByExternalEventId failed: ${error.message}`);
    return data || null;
  }

  /** Marks a row 'enqueued' once AIKB's fast accept-and-enqueue call succeeds. */
  async function markEnqueued(id) {
    const { data, error } = await client
      .from('slack_event_log')
      .update({ status: STATUS.ENQUEUED, processing_started_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', STATUS.RECEIVED)
      .select()
      .maybeSingle();
    if (error) throw new Error(`markEnqueued failed: ${error.message}`);
    return data || null;
  }

  /**
   * Conditional claim: only the FIRST /deliver request for a given event_id
   * transitions enqueued -> answered and proceeds to post to Slack. A
   * concurrent or retried /deliver callback observes zero matched rows and
   * safely no-ops. This is the "only the first delivery attempt proceeds"
   * guarantee from the report's flow diagram (§4.3, §4.8).
   */
  async function claimForDelivery(id) {
    const { data, error } = await client
      .from('slack_event_log')
      .update({ status: STATUS.ANSWERED })
      .eq('id', id)
      .eq('status', STATUS.ENQUEUED)
      .select()
      .maybeSingle();
    if (error) throw new Error(`claimForDelivery failed: ${error.message}`);
    return data || null;
  }

  async function markDelivered(id, { responseMetadata = null, attemptCount } = {}) {
    const update = {
      status: STATUS.DELIVERED,
      completed_at: new Date().toISOString(),
      response_metadata: responseMetadata,
    };
    if (typeof attemptCount === 'number') update.attempt_count = attemptCount;

    const { data, error } = await client
      .from('slack_event_log')
      .update(update)
      .eq('id', id)
      .select()
      .maybeSingle();
    if (error) throw new Error(`markDelivered failed: ${error.message}`);
    return data || null;
  }

  async function markFailed(id, { errorCode, attemptCount } = {}) {
    const update = {
      status: STATUS.FAILED,
      failed_at: new Date().toISOString(),
      error_code: errorCode || 'UNKNOWN_ERROR',
    };
    if (typeof attemptCount === 'number') update.attempt_count = attemptCount;

    const { data, error } = await client
      .from('slack_event_log')
      .update(update)
      .eq('id', id)
      .select()
      .maybeSingle();
    if (error) throw new Error(`markFailed failed: ${error.message}`);
    return data || null;
  }

  /**
   * Terminal state (ADR-007): every bounded Slack-delivery retry attempt
   * failed, or delivery was never possible (e.g. a revoked connection).
   * Technical/dedup metadata (external_event_id, client_id, attempt_count,
   * error_code, failed_at) is retained, per ADR-007. There is no customer
   * content on this row to redact any more (Backlog M13, revised —
   * slack_event_log never stores the question at all; see insertReceived
   * above). Corresponding AIKB-side chat content redaction
   * (services/slackDeliveryFailureService.js) is likewise now a no-op for
   * new events, since no AIKB session ever exists to redact — kept in
   * place for defense in depth / pre-existing rows.
   */
  async function markDeliveryFailed(id, { errorCode, attemptCount } = {}) {
    const update = {
      status: STATUS.DELIVERY_FAILED,
      failed_at: new Date().toISOString(),
      error_code: errorCode || 'UNKNOWN_ERROR',
    };
    if (typeof attemptCount === 'number') update.attempt_count = attemptCount;

    const { data, error } = await client
      .from('slack_event_log')
      .update(update)
      .eq('id', id)
      .select()
      .maybeSingle();
    if (error) throw new Error(`markDeliveryFailed failed: ${error.message}`);
    return data || null;
  }

  return {
    insertReceived,
    getByExternalEventId,
    getByIdempotencyKey,
    markEnqueued,
    claimForDelivery,
    markDelivered,
    markFailed,
    markDeliveryFailed,
  };
}

const defaultClient = createClient(supabaseConfig.url, supabaseConfig.serviceKey);
const defaultService = createSlackEventLogService(defaultClient);

module.exports = {
  ...defaultService,
  createSlackEventLogService,
  STATUS,
  PROVIDER,
};
