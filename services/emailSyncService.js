'use strict';

// Email sync orchestration — Architecture/architecture/EMAIL_INGESTION.md.
// EM6 (§14.2, §15, §17) shipped the first real ingestion: bounded,
// paginated, `manual_selected`-mode-only historical import, using EM5's
// label workflow, forwarding normalized text to AIKB's existing,
// generalized `/ingest` route (services/aikbService.js). EM7 (§18) adds the
// Gmail History API incremental path on top of it: once a connection has a
// valid stored cursor (`email_sync_state.provider_cursor`), a fresh sync
// reads only what changed since that cursor instead of re-scanning the
// whole label — falling back transparently to a bounded historical re-scan
// when the cursor has expired (§18.4).
//
// EM8 (§18.3) extends `syncConnection` to also support `automatic` mode —
// both historical (already worked once `mode` stopped being hardcoded to
// `manual_selected`, since `gmailService.compileSearchQuery` already had an
// `automatic` branch from EM5) and incremental (Gmail History API scoped to
// `historyTypes: ['messageAdded']` with no `labelId`, instead of manual
// mode's label-scoped `labelAdded`/`labelRemoved`/`messageDeleted` — see
// gmailService.js's `listHistory`). `runTick` (bottom of this file) is the
// new tick-handler entry point that drives this same function for every due
// automatic-mode connection, exactly the same code path `POST
// /connections/:id/sync` already used for manual "Sync now" clicks (§18.3).
//
// Deliberately NOT included in this first EM8 pass: remote-deletion/
// policy-change tombstone reconciliation for `automatic`-mode connections
// (`reconcileRemovedLabelsFullList` remains manual-mode-only below — it's
// keyed to the managed label, which automatic mode never uses as an
// ingestion criterion, so running it against automatic-mode content would
// tombstone messages that were never label-gated in the first place). A
// real policy-change reconciliation pass for automatic mode is flagged as a
// named follow-up, not silently absorbed — mirrors how EM6 shipped
// historical-only before EM7 filled in incremental.

const { createClient } = require('@supabase/supabase-js');
const { supabase: supabaseConfig, limits, email: emailConfig } = require('../config');
const defaultGmailService = require('./gmailService');
const { ERROR_CODES: GMAIL_ERROR_CODES } = require('./gmailService');
const defaultEmailPolicyService = require('./emailPolicyService');
const defaultEmailNormalizationService = require('./emailNormalizationService');
const defaultAikbService = require('./aikbService');
// EM8 (§18.3) — runTick needs a valid Gmail access token per due connection,
// the same refresh-if-expiring orchestration the /sync route already gets
// via req-scoped emailConnectionService.getValidGmailAccessToken. No
// circular dependency: emailConnectionService.js never requires this file.
const defaultEmailConnectionService = require('./emailConnectionService');

// Bounded per request (Vercel timeout — §17 item 3): one page of historical
// import, or one page of history-diff processing, per POST /sync call. A
// caller re-invokes with the returned nextPageToken (and runType) until
// complete: true.
const HISTORICAL_PAGE_SIZE = emailConfig.historicalSyncPageSize;

// Label-removal reconciliation (§24.2) for a FULL historical sync (fresh or
// cursor-expired-fallback) needs "every message currently under the
// label," not just this page's candidates — a single, larger, bounded
// listing rather than true unbounded pagination, run only once the
// historical page loop reports complete. An incremental sync never needs
// this: the History API diff itself reports label removals directly
// (§18.4), tombstoned per-page as they're seen. A mailbox with more than
// this many labeled messages gets a best-effort full-list reconciliation
// pass (a documented MVP bound, not a correctness bug — the next completed
// sync re-attempts it).
const RECONCILIATION_LIST_SIZE = 500;

const ERROR_CODES = Object.freeze({
  SEARCH_DISABLED: 'SEARCH_DISABLED',
  SYNC_DISABLED: 'SYNC_DISABLED',
  SYNC_PAUSED: 'SYNC_PAUSED',
  DOCUMENT_LIMIT_REACHED: 'DOCUMENT_LIMIT_REACHED',
  INVALID_RESUME: 'INVALID_RESUME',
});

// EM8 (§18.3) — how long after a completed automatic-mode sync before the
// tick handler considers this connection due again. Also used by manual
// "Sync now" clicks on an automatic-mode connection, per §15.1's "run_type
// describes the fetch strategy, not the trigger source" — every completed
// automatic-mode sync, however triggered, advances the same due timestamp.
const TICK_INTERVAL_MS = emailConfig.tickIntervalMs;

// EM8 (§18.3) — the tick handler's own per-request processing cap (Vercel
// timeout, same reasoning as HISTORICAL_PAGE_SIZE) — a due connection
// beyond this many simply waits for the next tick.
const TICK_MAX_CONNECTIONS = emailConfig.tickMaxConnections;

// A generous upper bound on how many automatic-mode connections
// listDueAutomaticConnections ever fetches from the database before
// filtering/capping in application code — not the per-tick processing cap
// itself (TICK_MAX_CONNECTIONS is), just a safety valve against an
// unbounded query at a client base size this codebase doesn't operate at
// today (§29).
const TICK_QUERY_SAFETY_LIMIT = 500;

function syncError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// EM8 — advances next_sync_due_at on every `syncConnection` completion of an
// automatic-mode connection (success, partial, or failed alike — a
// persistently-failing connection must not be re-selected every single
// tick, §31 EM8 Backend). `manual_selected`/`paused` connections never set
// this at all — meaningless while sync_mode != 'automatic' (§13.1).
function nextSyncDueAtPatch(mode) {
  if (mode !== 'automatic') return {};
  return { nextSyncDueAt: new Date(Date.now() + TICK_INTERVAL_MS).toISOString() };
}

// Thin, EM6/EM7-only data access for email_sync_runs/email_ingestion_events/
// email_sync_state, plus the one email_connections column
// (historical_import_status) this milestone writes. Injectable like every
// other repo object in this codebase's email services, so tests never touch
// a real Supabase project.
const defaultDbClient = createClient(supabaseConfig.url, supabaseConfig.serviceKey);

const defaultEmailSyncRepo = {
  async createSyncRun({ clientId, emailConnectionId, runType, triggeredByMemberId }) {
    const { data, error } = await defaultDbClient
      .from('email_sync_runs')
      .insert({
        client_id: clientId,
        email_connection_id: emailConnectionId,
        run_type: runType,
        status: 'running',
        triggered_by_member_id: triggeredByMemberId || null,
      })
      .select('*')
      .single();
    if (error) throw new Error(`createSyncRun failed: ${error.message}`);
    return data;
  },

  async completeSyncRun(syncRunId, { status, counts, errorSummary }) {
    const { error } = await defaultDbClient
      .from('email_sync_runs')
      .update({
        status,
        completed_at: new Date().toISOString(),
        messages_scanned: counts.scanned,
        messages_matched: counts.matched,
        messages_ingested: counts.ingested,
        messages_skipped: counts.skipped,
        messages_duplicate: counts.duplicate,
        messages_failed: counts.failed,
        error_summary: errorSummary || null,
      })
      .eq('id', syncRunId);
    if (error) throw new Error(`completeSyncRun failed: ${error.message}`);
  },

  async recordEvents(events) {
    if (!events || events.length === 0) return;
    const { error } = await defaultDbClient.from('email_ingestion_events').insert(events);
    if (error) throw new Error(`recordEvents failed: ${error.message}`);
  },

  async updateHistoricalImportStatus(emailConnectionId, status) {
    const { error } = await defaultDbClient
      .from('email_connections')
      .update({ historical_import_status: status, updated_at: new Date().toISOString() })
      .eq('id', emailConnectionId);
    if (error) throw new Error(`updateHistoricalImportStatus failed: ${error.message}`);
  },

  // EM7 — read the connection's stored cursor to decide historical vs
  // incremental at the start of a fresh sync (§18.2).
  async getSyncState(emailConnectionId) {
    const { data, error } = await defaultDbClient
      .from('email_sync_state')
      .select('*')
      .eq('email_connection_id', emailConnectionId)
      .maybeSingle();
    if (error) throw new Error(`getSyncState failed: ${error.message}`);
    return data || null;
  },

  // EM7 — only the cursor-lifecycle columns are ever conditionally written
  // here (providerCursor/cursorStatus/cursorObtainedAt default to
  // `undefined`, meaning "leave unchanged" — Supabase's upsert only issues
  // an UPDATE SET for keys actually present in the payload, so an
  // in-progress/failed sync's upsertSyncState call — which omits all three
  // — never clobbers a still-valid cursor with nothing).
  async upsertSyncState(emailConnectionId, {
    lastSyncStartedAt, lastSyncCompletedAt, lastSyncStatus,
    providerCursor, cursorStatus, cursorObtainedAt,
    nextSyncDueAt,
  }) {
    const payload = {
      email_connection_id: emailConnectionId,
      last_sync_started_at: lastSyncStartedAt,
      last_sync_completed_at: lastSyncCompletedAt,
      last_sync_status: lastSyncStatus,
      updated_at: new Date().toISOString(),
    };
    if (providerCursor !== undefined) payload.provider_cursor = providerCursor;
    if (cursorStatus !== undefined) payload.cursor_status = cursorStatus;
    if (cursorObtainedAt !== undefined) payload.cursor_obtained_at = cursorObtainedAt;
    // EM8 — same "undefined means leave unchanged" conditional-write
    // contract as the cursor fields above; only ever set for automatic-mode
    // connections (nextSyncDueAtPatch), never touched for manual/paused.
    if (nextSyncDueAt !== undefined) payload.next_sync_due_at = nextSyncDueAt;

    const { error } = await defaultDbClient
      .from('email_sync_state')
      .upsert(payload, { onConflict: 'email_connection_id' });
    if (error) throw new Error(`upsertSyncState failed: ${error.message}`);
  },

  // EM7 (§18.4) — a stale/expired cursor is recorded so the NEXT fresh sync
  // falls back to historical without needing to re-probe Gmail first.
  async markCursorExpired(emailConnectionId) {
    const { error } = await defaultDbClient
      .from('email_sync_state')
      .upsert(
        { email_connection_id: emailConnectionId, cursor_status: 'expired', updated_at: new Date().toISOString() },
        { onConflict: 'email_connection_id' }
      );
    if (error) throw new Error(`markCursorExpired failed: ${error.message}`);
  },

  // §24.2 reconciliation (full-list variant, historical sync only) — every
  // message this connection has ever successfully queued for ingestion,
  // across every past sync run, so a label removed since ANY prior sync
  // (not just the most recent one) is still caught.
  async getPreviouslyIngestedMessageIds(emailConnectionId) {
    const { data, error } = await defaultDbClient
      .from('email_ingestion_events')
      .select('provider_message_id')
      .eq('email_connection_id', emailConnectionId)
      .eq('outcome', 'ingested');
    if (error) throw new Error(`getPreviouslyIngestedMessageIds failed: ${error.message}`);
    return Array.from(new Set((data || []).map((row) => row.provider_message_id)));
  },

  // EM7 — recent sync-run history for the portal's sync-run view (§27, §31 EM7 Frontend).
  async listRecentSyncRuns(emailConnectionId, limit = 10) {
    const { data, error } = await defaultDbClient
      .from('email_sync_runs')
      .select('*')
      .eq('email_connection_id', emailConnectionId)
      .order('started_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`listRecentSyncRuns failed: ${error.message}`);
    return data || [];
  },

  // EM8 (§18.3) — runTick's own fail-closed gate needs client_members.
  // search_enabled the same way the /sync route reads it off req.member,
  // but a tick has no HTTP session to read it from.
  async getMemberSearchEnabled(memberId) {
    const { data, error } = await defaultDbClient
      .from('client_members')
      .select('search_enabled')
      .eq('id', memberId)
      .maybeSingle();
    if (error) throw new Error(`getMemberSearchEnabled failed: ${error.message}`);
    return data ? data.search_enabled !== false : false;
  },

  // EM8 (§18.3) — the tick handler's three-way gate: sync_mode='automatic'
  // AND sync_enabled AND email_organization_settings.automatic_sync_enabled
  // AND due (next_sync_due_at unset or <= now). Two queries rather than one
  // embedded join, to sidestep depending on Supabase/Postgrest's foreign-key
  // embed inference for a cross-table condition this repo has no existing
  // precedent for — simpler to read, and correct at this codebase's current
  // scale (§29 "single-digit-to-low-dozens client base").
  async listDueAutomaticConnections(maxConnections) {
    const { data: settingsRows, error: settingsError } = await defaultDbClient
      .from('email_organization_settings')
      .select('client_id')
      .eq('automatic_sync_enabled', true);
    if (settingsError) throw new Error(`listDueAutomaticConnections (settings) failed: ${settingsError.message}`);
    const eligibleClientIds = (settingsRows || []).map((r) => r.client_id);
    if (eligibleClientIds.length === 0) return [];

    const { data: connectionRows, error: connectionsError } = await defaultDbClient
      .from('email_connections')
      .select('*, email_sync_state(next_sync_due_at)')
      .eq('sync_mode', 'automatic')
      .eq('sync_enabled', true)
      .in('client_id', eligibleClientIds)
      .limit(TICK_QUERY_SAFETY_LIMIT);
    if (connectionsError) throw new Error(`listDueAutomaticConnections failed: ${connectionsError.message}`);

    const now = Date.now();
    const due = (connectionRows || []).filter((row) => {
      // Supabase embeds a to-one relation (email_sync_state has a UNIQUE
      // FK to email_connections) as an object, but defend against an array
      // shape too rather than assume the embed inference never changes.
      const state = Array.isArray(row.email_sync_state) ? row.email_sync_state[0] : row.email_sync_state;
      const dueAt = state && state.next_sync_due_at;
      return !dueAt || new Date(dueAt).getTime() <= now;
    });
    return due.slice(0, maxConnections);
  },
};

/**
 * Fail-closed gate (§16's Policy Evaluation Model, the connection-level
 * steps above the per-message decision tree) — evaluated before any
 * provider call is made. Every branch maps to a single named reason so a
 * rejection is always attributable, never a generic failure.
 */
function assertSyncAllowed({ memberSearchEnabled, syncEnabled, syncMode }) {
  if (!memberSearchEnabled) {
    throw syncError(ERROR_CODES.SEARCH_DISABLED, 'This mailbox is not contributing to search (search_enabled is off).');
  }
  if (!syncEnabled) {
    throw syncError(ERROR_CODES.SYNC_DISABLED, 'Sync is disabled for this connection.');
  }
  if (syncMode === 'paused') {
    throw syncError(ERROR_CODES.SYNC_PAUSED, 'This connection is paused.');
  }
}

function safeIsoDate(dateHeaderValue) {
  const parsed = new Date(dateHeaderValue);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

async function countActiveDocuments(aikbService, clientId) {
  try {
    const existing = await aikbService.listDocuments(clientId);
    const docs = existing.documents || (Array.isArray(existing) ? existing : []);
    return docs.filter((d) => d.status !== 'deleted').length;
  } catch {
    return 0; // non-blocking — matches routes/api.js's existing "proceed if count check fails" precedent
  }
}

/**
 * Shared per-message eligibility + ingest pipeline, used by both the
 * historical and incremental page processors so the two never drift apart:
 * metadata fetch → local policy re-verification (label gate + organization
 * policy, §16) → (if eligible) body fetch → normalize (§19) → forward to
 * AIKB (§14.2). Never throws for an eligibility/normalization/ingest
 * failure — those are represented in the returned `kind`; only an
 * unexpected exception (a network error the caller didn't already handle)
 * propagates, which callers wrap in their own try/catch.
 */
async function processCandidateMessage({
  gmailService, emailPolicyService, emailNormalizationService, aikbService,
  clientId, emailConnectionRow, accessToken, mode, rules, labelNameById, messageId, syncRunId,
}) {
  const meta = await gmailService.getMessageMetadata({ accessToken, messageId });
  const hasLabel = Boolean(emailConnectionRow.managed_label_id) && meta.labelIds.includes(emailConnectionRow.managed_label_id);
  const labelsOrFolders = meta.labelIds.map((id) => labelNameById.get(id)).filter(Boolean);

  const message = {
    provider: 'gmail',
    fromAddress: meta.fromAddress,
    toAddresses: [],
    ccAddresses: [],
    subject: meta.subject,
    isSent: meta.isSent,
    labelsOrFolders,
  };

  const decision = emailPolicyService.evaluateMessageAgainstPolicy({ rules, mode, message, hasLabel });

  if (!decision.eligible) {
    return {
      kind: 'skipped',
      event: {
        sync_run_id: syncRunId,
        email_connection_id: emailConnectionRow.id,
        provider_message_id: messageId,
        outcome: decision.outcome,
        matched_rule_id: decision.matchedRuleId,
        reason: decision.reason,
      },
      entry: { messageId, subject: meta.subject, reason: decision.reason },
    };
  }

  const body = await gmailService.getMessageBody({ accessToken, messageId });
  const normalized = emailNormalizationService.normalizeEmailBody({ html: body.html, text: body.text });

  if (!normalized) {
    const reason = 'Message produced no extractable text after normalization.';
    return {
      kind: 'failed',
      event: {
        sync_run_id: syncRunId,
        email_connection_id: emailConnectionRow.id,
        provider_message_id: messageId,
        outcome: 'failed',
        matched_rule_id: decision.matchedRuleId,
        reason,
      },
      entry: { messageId, subject: meta.subject, reason },
    };
  }

  const matchedRule = (rules || []).find((r) => r.id === decision.matchedRuleId);
  const destinationCollectionId = matchedRule ? matchedRule.destinationCollectionId : null;

  await aikbService.uploadAndIngest({
    clientId,
    sourceFileId: messageId,
    fileName: `${(meta.subject || '(no subject)').slice(0, 200)}.txt`,
    mimeType: 'text/plain',
    fileBuffer: Buffer.from(normalized, 'utf8'),
    sourceProvider: 'gmail',
    collectionId: destinationCollectionId || undefined,
    emailMetadata: {
      provider: 'gmail',
      providerAccountId: emailConnectionRow.mailbox_address,
      contributingMemberId: emailConnectionRow.member_id,
      providerMessageId: messageId,
      providerThreadId: meta.threadId || null,
      from: meta.fromAddress,
      fromName: null,
      to: [],
      cc: [],
      subject: meta.subject,
      sentAt: meta.date ? safeIsoDate(meta.date) : null,
      receivedAt: null,
      folderOrLabels: labelsOrFolders,
      hasAttachments: false,
      deepLinkUrl: `https://mail.google.com/mail/u/0/#all/${messageId}`,
      ingestionRuleId: decision.matchedRuleId,
    },
  });

  return {
    kind: 'ingested',
    event: {
      sync_run_id: syncRunId,
      email_connection_id: emailConnectionRow.id,
      provider_message_id: messageId,
      outcome: 'ingested',
      matched_rule_id: decision.matchedRuleId,
      reason: decision.reason,
    },
    entry: { messageId, subject: meta.subject },
  };
}

/**
 * Runs `processCandidateMessage` for one messageId, folding the result (or
 * an unexpected exception) into the shared counts/events/imported/skipped/
 * failed accumulators — the exact per-message bookkeeping both the
 * historical and incremental loops need identically.
 */
async function processOneCandidate(deps, { messageId, counts, events, imported, skipped, failed }) {
  counts.scanned++;
  try {
    const result = await processCandidateMessage({ ...deps, messageId });
    events.push(result.event);
    if (result.kind === 'skipped') {
      counts.skipped++;
      skipped.push(result.entry);
    } else if (result.kind === 'failed') {
      counts.matched++;
      counts.failed++;
      failed.push(result.entry);
    } else {
      counts.matched++;
      counts.ingested++;
      imported.push(result.entry);
    }
  } catch (err) {
    counts.failed++;
    const reason = `Sync error: ${err.message}`.slice(0, 500);
    events.push({
      sync_run_id: deps.syncRunId,
      email_connection_id: deps.emailConnectionRow.id,
      provider_message_id: messageId,
      outcome: 'failed',
      matched_rule_id: null,
      reason,
    });
    failed.push({ messageId, reason: err.message });
  }
}

/**
 * Tombstones a set of message ids via AIKB's existing DELETE /document/:id
 * (§24.1, §24.2) — resolved to the real AIKB document id through
 * aikbService.listDocuments, since /ingest never returns one synchronously
 * (it only enqueues an async Inngest event). Shared by both the historical
 * full-list reconciliation and the incremental per-page diff handling.
 * Best-effort per message: one delete failure doesn't block the rest.
 */
async function tombstoneMessages({ aikbService, emailSyncRepo, clientId, emailConnectionRow, messageIds, syncRunId, reason }) {
  if (!messageIds || messageIds.length === 0) return [];

  const documents = await aikbService.listDocuments(clientId);
  const docs = documents.documents || (Array.isArray(documents) ? documents : []);
  const docIdByMessageId = new Map(
    docs
      .filter((d) => (d.source_provider || d.sourceProvider) === 'gmail')
      .map((d) => [d.source_file_id || d.sourceFileId, d.id])
  );

  const tombstoned = [];
  const events = [];
  for (const messageId of messageIds) {
    const documentId = docIdByMessageId.get(messageId);
    if (!documentId) continue; // already deleted/never resolved — nothing to do
    try {
      await aikbService.deleteDocumentById(clientId, documentId);
      tombstoned.push({ messageId, documentId });
      events.push({
        sync_run_id: syncRunId,
        email_connection_id: emailConnectionRow.id,
        provider_message_id: messageId,
        outcome: 'tombstoned_label_removed',
        matched_rule_id: null,
        reason,
        ingested_document_id: documentId,
      });
    } catch (err) {
      console.error('[emailSyncService] tombstone delete failed:', messageId, err.message);
    }
  }
  if (events.length > 0) await emailSyncRepo.recordEvents(events);
  return tombstoned;
}

/**
 * §24.2 — full-list label-removal reconciliation, historical sync only, run
 * once a historical sync reports complete (fresh full import OR a
 * cursor-expired fallback). Re-lists every message currently under the
 * managed label (a single bounded call, RECONCILIATION_LIST_SIZE) and diffs
 * it against every message this connection has ever successfully queued for
 * ingestion. An incremental sync never calls this — the History API diff
 * itself already reports label removals directly, tombstoned per-page (see
 * runIncrementalPage). Best-effort: a reconciliation failure is logged and
 * does not fail the sync run that triggered it.
 */
async function reconcileRemovedLabelsFullList({ gmailService, emailSyncRepo, aikbService, clientId, emailConnectionRow, accessToken, syncRunId }) {
  if (!emailConnectionRow.managed_label_id) return [];

  try {
    const [previouslyIngested, { messageIds: currentlyLabeled }] = await Promise.all([
      emailSyncRepo.getPreviouslyIngestedMessageIds(emailConnectionRow.id),
      gmailService.listMessageIdsByQuery({
        accessToken,
        query: gmailService.compileSearchQuery({ mode: 'manual_selected', rules: [] }),
        maxResults: RECONCILIATION_LIST_SIZE,
      }),
    ]);

    if (previouslyIngested.length === 0) return [];

    const currentlyLabeledSet = new Set(currentlyLabeled);
    const removed = previouslyIngested.filter((messageId) => !currentlyLabeledSet.has(messageId));
    if (removed.length === 0) return [];

    return await tombstoneMessages({
      aikbService, emailSyncRepo, clientId, emailConnectionRow, syncRunId,
      messageIds: removed,
      reason: 'Relativity/Knowledge label removed since last sync.',
    });
  } catch (err) {
    console.error('[emailSyncService] full-list label reconciliation failed (non-fatal):', err.message);
    return [];
  }
}

/**
 * One bounded page of historical import (EM6 — §17): compiles the fixed
 * manual-mode label query, lists a page of candidates, and runs each
 * through the shared eligibility/ingest pipeline.
 */
async function runHistoricalPage(deps) {
  const { gmailService, clientId, emailConnectionRow, accessToken, pageToken, mode, rules, syncRunId } = deps;

  const query = gmailService.compileSearchQuery({ mode, rules });
  const listResult = await gmailService.listMessageIdsByQuery({ accessToken, query, pageToken, maxResults: HISTORICAL_PAGE_SIZE });

  const counts = { scanned: 0, matched: 0, ingested: 0, skipped: 0, duplicate: 0, failed: 0 };
  const events = [];
  const imported = [];
  const skipped = [];
  const failed = [];

  let labelNameById = new Map();
  if (listResult.messageIds.length > 0) {
    const labels = await gmailService.listLabels(accessToken);
    labelNameById = new Map(labels.map((l) => [l.id, l.name]));
  }

  for (const messageId of listResult.messageIds) {
    await processOneCandidate(
      { ...deps, clientId, emailConnectionRow, accessToken, mode, rules, labelNameById, syncRunId },
      { messageId, counts, events, imported, skipped, failed }
    );
  }

  return { counts, events, imported, skipped, failed, reconciled: [], nextPageToken: listResult.nextPageToken || null, newCursor: null };
}

/**
 * One bounded page of incremental sync (EM7 — §18): reduces the History
 * API's ordered change list to one final action per message (last-write-
 * wins — a message labeled then unlabeled again within the same page nets
 * out to "removed," and vice versa), runs newly-labeled candidates through
 * the shared eligibility/ingest pipeline, and tombstones anything reported
 * `labelRemoved`/`messageDeleted` immediately — no separate full-list
 * reconciliation pass needed (§18.4).
 *
 * @param {object} [deps.prefetched] - an already-fetched listHistory result
 *   for this exact page, when the caller already made the call itself (the
 *   fresh-sync cursor-expiry probe in syncConnection) — avoids a duplicate
 *   network call. Only ever set for the FIRST page of a fresh incremental
 *   sync; every resumed page fetches its own.
 */
async function runIncrementalPage(deps) {
  const { gmailService, emailSyncRepo, clientId, emailConnectionRow, accessToken, startHistoryId, pageToken, mode, rules, syncRunId, prefetched } = deps;

  const historyResult = prefetched || await gmailService.listHistory({
    accessToken,
    startHistoryId,
    ...(mode === 'automatic'
      ? { historyTypes: ['messageAdded'] }
      : { labelId: emailConnectionRow.managed_label_id }),
    pageToken,
    maxResults: HISTORICAL_PAGE_SIZE,
  });

  const finalActionByMessage = new Map();
  for (const change of historyResult.changes) finalActionByMessage.set(change.messageId, change.type);

  const toIngest = [];
  const toRemoveLabelRemoved = [];
  const toRemoveDeleted = [];
  for (const [messageId, type] of finalActionByMessage.entries()) {
    // 'messageAdded' only ever appears in automatic mode's unscoped diff
    // (EM8 — no managed label involved, so there's no corresponding
    // "removed" counterpart the way labelAdded/labelRemoved pair up).
    if (type === 'labelAdded' || type === 'messageAdded') toIngest.push(messageId);
    else if (type === 'messageDeleted') toRemoveDeleted.push(messageId);
    else toRemoveLabelRemoved.push(messageId);
  }

  const counts = { scanned: 0, matched: 0, ingested: 0, skipped: 0, duplicate: 0, failed: 0 };
  const events = [];
  const imported = [];
  const skipped = [];
  const failed = [];

  let labelNameById = new Map();
  if (toIngest.length > 0) {
    const labels = await gmailService.listLabels(accessToken);
    labelNameById = new Map(labels.map((l) => [l.id, l.name]));
  }

  for (const messageId of toIngest) {
    await processOneCandidate(
      { ...deps, clientId, emailConnectionRow, accessToken, mode, rules, labelNameById, syncRunId },
      { messageId, counts, events, imported, skipped, failed }
    );
  }

  const reconciled = [
    ...(await tombstoneMessages({
      aikbService: deps.aikbService, emailSyncRepo, clientId, emailConnectionRow, syncRunId,
      messageIds: toRemoveLabelRemoved,
      reason: 'Relativity/Knowledge label removed since last sync.',
    })),
    ...(await tombstoneMessages({
      aikbService: deps.aikbService, emailSyncRepo, clientId, emailConnectionRow, syncRunId,
      messageIds: toRemoveDeleted,
      reason: 'Message deleted at the provider since last sync.',
    })),
  ];

  return {
    counts, events, imported, skipped, failed, reconciled,
    nextPageToken: historyResult.nextPageToken || null,
    newCursor: historyResult.historyId || null,
  };
}

/**
 * @param {object} [deps] — injected for testing; each defaults to the real singleton service.
 */
function createEmailSyncService({
  gmailService = defaultGmailService,
  emailPolicyService = defaultEmailPolicyService,
  emailNormalizationService = defaultEmailNormalizationService,
  aikbService = defaultAikbService,
  emailConnectionService = defaultEmailConnectionService,
  emailSyncRepo = defaultEmailSyncRepo,
  maxDocuments = limits.maxDocuments,
} = {}) {
  /**
   * Runs one bounded page of sync for a connection — historical (EM6) or
   * incremental (EM7), decided automatically from the connection's stored
   * cursor on a fresh call, or trusted from the caller on a resumed one.
   *
   * @param {string} clientId
   * @param {object} emailConnectionRow - email_connections row (needs id,
   *   member_id, mailbox_address, sync_mode, sync_enabled, managed_label_id).
   * @param {boolean} memberSearchEnabled - the connection's own member's
   *   client_members.search_enabled (§16's fail-closed gate).
   * @param {string} accessToken - a live, already-refreshed Gmail access
   *   token (emailConnectionService.getValidGmailAccessToken).
   * @param {string|null} [triggeredByMemberId] - the acting member for this
   *   specific sync click (§15.1).
   * @param {string|null} [pageToken] - continuation token from a prior call.
   * @param {'historical'|'incremental'|null} [runType] - REQUIRED when
   *   pageToken is set (resuming), to know which provider-call shape to
   *   continue; ignored/recomputed on a fresh call.
   * @returns {{syncRunId:string, runType:string, status:string, complete:boolean, nextPageToken:string|null, imported:object[], skipped:object[], failed:object[], reconciled:object[], errorSummary:string|null}}
   */
  async function syncConnection({
    clientId,
    emailConnectionRow,
    memberSearchEnabled,
    accessToken,
    triggeredByMemberId = null,
    pageToken = null,
    runType = null,
  }) {
    if (!clientId) throw new Error('syncConnection requires clientId');
    if (!emailConnectionRow) throw new Error('syncConnection requires emailConnectionRow');
    if (!accessToken) throw new Error('syncConnection requires accessToken');

    assertSyncAllowed({
      memberSearchEnabled,
      syncEnabled: emailConnectionRow.sync_enabled,
      syncMode: emailConnectionRow.sync_mode,
    });

    // EM8 (§18.3) — assertSyncAllowed already rejected 'paused' above, so
    // only 'manual_selected'/'automatic' ever reach here. Computed before
    // the cursor/probe logic below since automatic mode's incremental path
    // needs it (no managed-label requirement, different historyTypes).
    const mode = emailConnectionRow.sync_mode === 'automatic' ? 'automatic' : 'manual_selected';

    let resolvedRunType;
    let prefetchedHistoryPage = null;
    let startHistoryId = null;

    if (pageToken) {
      // Resuming a paginated run — trust the caller's runType (the route
      // only ever passes back exactly what a prior call of this same
      // function returned) rather than re-deriving it, since the stored
      // cursor may already have moved on for an unrelated reason by the
      // time a resumed page runs.
      if (runType !== 'historical' && runType !== 'incremental') {
        throw syncError(ERROR_CODES.INVALID_RESUME, 'Resuming a paginated sync requires the runType from the prior page.');
      }
      resolvedRunType = runType;
      if (resolvedRunType === 'incremental') {
        // Gmail's history.list requires startHistoryId on every page, not
        // only the first — re-read it rather than threading it through the
        // route/pageToken, since the stored cursor is guaranteed unchanged
        // until this same run finally completes (upsertSyncState below only
        // ever writes a new cursor once complete: true).
        const syncState = await emailSyncRepo.getSyncState(emailConnectionRow.id);
        startHistoryId = syncState && syncState.provider_cursor;
        if (!startHistoryId) {
          throw syncError(ERROR_CODES.INVALID_RESUME, 'Cannot resume an incremental sync — the connection has no stored cursor.');
        }
      }
    } else {
      // §17 item 6 — the existing per-client document-count ceiling,
      // checked once at the start of a fresh sync (not on a resumed page).
      const count = await countActiveDocuments(aikbService, clientId);
      if (count >= maxDocuments) {
        throw syncError(ERROR_CODES.DOCUMENT_LIMIT_REACHED, `Document limit reached (${maxDocuments} max). Delete some documents to sync more.`);
      }

      const syncState = await emailSyncRepo.getSyncState(emailConnectionRow.id);
      // Automatic mode has no managed-label requirement (it never scopes by
      // label at all, §16.1 item 3) — only manual mode's cursor validity
      // additionally depends on a managed label existing to scope against.
      const hasValidCursor = syncState && syncState.cursor_status === 'valid' && syncState.provider_cursor
        && (mode === 'automatic' || emailConnectionRow.managed_label_id);

      if (hasValidCursor) {
        // Probe now, before creating a sync run, so a stale cursor can fall
        // back to historical without ever recording a spurious incremental
        // run (§18.4).
        try {
          prefetchedHistoryPage = await gmailService.listHistory({
            accessToken,
            startHistoryId: syncState.provider_cursor,
            ...(mode === 'automatic'
              ? { historyTypes: ['messageAdded'] }
              : { labelId: emailConnectionRow.managed_label_id }),
            maxResults: HISTORICAL_PAGE_SIZE,
          });
          resolvedRunType = 'incremental';
        } catch (err) {
          if (err.code === GMAIL_ERROR_CODES.HISTORY_EXPIRED) {
            await emailSyncRepo.markCursorExpired(emailConnectionRow.id);
            resolvedRunType = 'historical';
          } else {
            throw err; // a genuine failure — surface it, don't silently pick a path
          }
        }
      } else {
        resolvedRunType = 'historical';
      }
    }

    const { rules } = await emailPolicyService.getPolicy(clientId);

    const syncRun = await emailSyncRepo.createSyncRun({
      clientId,
      emailConnectionId: emailConnectionRow.id,
      runType: resolvedRunType,
      triggeredByMemberId,
    });
    const startedAt = new Date().toISOString();
    if (!pageToken && resolvedRunType === 'historical') {
      await emailSyncRepo.updateHistoricalImportStatus(emailConnectionRow.id, 'running');
    }

    let pageOutcome;
    let runStatus = 'completed';
    let errorSummary = null;

    try {
      if (resolvedRunType === 'incremental') {
        pageOutcome = await runIncrementalPage({
          gmailService, emailPolicyService, emailNormalizationService, aikbService, emailSyncRepo,
          clientId, emailConnectionRow, accessToken, pageToken, mode, rules, syncRunId: syncRun.id,
          startHistoryId, prefetched: prefetchedHistoryPage,
        });
      } else {
        pageOutcome = await runHistoricalPage({
          gmailService, emailPolicyService, emailNormalizationService, aikbService, emailSyncRepo,
          clientId, emailConnectionRow, accessToken, pageToken, mode, rules, syncRunId: syncRun.id,
        });
      }
    } catch (err) {
      // A page-level failure (e.g. the list call itself, after the initial
      // probe above already succeeded) fails the whole run — individual
      // message failures are already caught inside processOneCandidate and
      // never reach here (§17 item 5).
      runStatus = 'failed';
      errorSummary = err.message;
      pageOutcome = {
        counts: { scanned: 0, matched: 0, ingested: 0, skipped: 0, duplicate: 0, failed: 0 },
        events: [], imported: [], skipped: [], failed: [], reconciled: [], nextPageToken: null, newCursor: null,
      };
    }

    if (runStatus !== 'failed' && pageOutcome.counts.failed > 0) runStatus = 'partial';
    const complete = runStatus === 'failed' || !pageOutcome.nextPageToken;

    let extraReconciled = [];
    if (complete && runStatus !== 'failed' && resolvedRunType === 'historical' && mode === 'manual_selected') {
      extraReconciled = await reconcileRemovedLabelsFullList({
        gmailService, emailSyncRepo, aikbService, clientId, emailConnectionRow, accessToken, syncRunId: syncRun.id,
      });
    }
    const reconciled = [...pageOutcome.reconciled, ...extraReconciled];

    await emailSyncRepo.recordEvents(pageOutcome.events);
    await emailSyncRepo.completeSyncRun(syncRun.id, { status: runStatus, counts: pageOutcome.counts, errorSummary });
    if (complete && resolvedRunType === 'historical') {
      await emailSyncRepo.updateHistoricalImportStatus(emailConnectionRow.id, runStatus === 'failed' ? 'failed' : 'completed');
    }

    // Cursor lifecycle (§18.2): a successful, complete run of EITHER type
    // establishes/refreshes a valid cursor so the NEXT sync can go
    // incremental — an incremental page's own response already carries the
    // new historyId; a historical completion (fresh or fallback) has to ask
    // for one explicitly via getMailboxHistoryId.
    if (complete && runStatus !== 'failed') {
      let newCursor = pageOutcome.newCursor;
      if (!newCursor) {
        try {
          const profile = await gmailService.getMailboxHistoryId(accessToken);
          newCursor = profile.historyId;
        } catch (err) {
          console.error('[emailSyncService] could not establish a fresh cursor after sync (non-fatal):', err.message);
        }
      }
      await emailSyncRepo.upsertSyncState(emailConnectionRow.id, {
        lastSyncStartedAt: startedAt,
        lastSyncCompletedAt: new Date().toISOString(),
        lastSyncStatus: runStatus,
        ...(newCursor ? { providerCursor: newCursor, cursorStatus: 'valid', cursorObtainedAt: new Date().toISOString() } : {}),
        ...nextSyncDueAtPatch(mode),
      });
    } else {
      await emailSyncRepo.upsertSyncState(emailConnectionRow.id, {
        lastSyncStartedAt: startedAt,
        lastSyncCompletedAt: complete ? new Date().toISOString() : null,
        lastSyncStatus: runStatus,
        ...nextSyncDueAtPatch(mode),
      });
    }

    return {
      syncRunId: syncRun.id,
      runType: resolvedRunType,
      status: runStatus,
      complete,
      nextPageToken: pageOutcome.nextPageToken || null,
      imported: pageOutcome.imported,
      skipped: pageOutcome.skipped,
      failed: pageOutcome.failed,
      reconciled,
      errorSummary,
    };
  }

  /**
   * GET .../sync-runs (§27, §31 EM7 Frontend) — recent sync-run history for
   * a connection, newest first.
   */
  async function listSyncRuns(emailConnectionId, limit = 10) {
    if (!emailConnectionId) throw new Error('listSyncRuns requires emailConnectionId');
    return emailSyncRepo.listRecentSyncRuns(emailConnectionId, limit);
  }

  /**
   * POST /api/integrations/email/sync/tick's orchestration (EM8 — §18.3):
   * runs exactly the same syncConnection() code path "Sync now" already
   * uses, once per due automatic-mode connection, up to maxConnections.
   * Per-connection failures are isolated — one broken connection (expired
   * auth, a Gmail outage, whatever) never aborts the rest of the tick, the
   * same "isolate, don't abort" discipline processOneCandidate already
   * applies one layer down at the per-message level (§17 item 5).
   * triggeredByMemberId is always null here — a tick-triggered run has no
   * acting member, by construction.
   */
  async function runTick({ maxConnections = TICK_MAX_CONNECTIONS } = {}) {
    const dueConnections = await emailSyncRepo.listDueAutomaticConnections(maxConnections);
    const results = { processed: 0, succeeded: 0, failed: 0, connectionIds: [] };

    for (const emailConnectionRow of dueConnections) {
      results.processed++;
      results.connectionIds.push(emailConnectionRow.id);
      try {
        const [memberSearchEnabled, accessToken] = await Promise.all([
          emailSyncRepo.getMemberSearchEnabled(emailConnectionRow.member_id),
          emailConnectionService.getValidGmailAccessToken(emailConnectionRow.oauth_connection_id),
        ]);

        const outcome = await syncConnection({
          clientId: emailConnectionRow.client_id,
          emailConnectionRow,
          memberSearchEnabled,
          accessToken,
          triggeredByMemberId: null,
        });
        if (outcome.status === 'failed') results.failed++;
        else results.succeeded++;
      } catch (err) {
        // A connection-level failure BEFORE syncConnection ever ran (token
        // refresh, the member-search-enabled lookup) never reaches
        // syncConnection's own next_sync_due_at bookkeeping — advance it
        // here directly, or a persistently-broken connection (e.g. expired
        // auth) would be re-selected and re-attempted on every single tick
        // forever, never actually waiting out the interval like every other
        // outcome does.
        results.failed++;
        console.error('[emailSyncService] runTick: connection failed, continuing with the rest of the tick:', emailConnectionRow.id, err.message);
        try {
          await emailSyncRepo.upsertSyncState(emailConnectionRow.id, {
            lastSyncStartedAt: new Date().toISOString(),
            lastSyncCompletedAt: new Date().toISOString(),
            lastSyncStatus: 'failed',
            ...nextSyncDueAtPatch('automatic'),
          });
        } catch (writeErr) {
          console.error('[emailSyncService] runTick: could not advance next_sync_due_at after a connection-level failure (non-fatal):', emailConnectionRow.id, writeErr.message);
        }
      }
    }

    return results;
  }

  return { syncConnection, listSyncRuns, runTick };
}

const defaultService = createEmailSyncService();

module.exports = {
  ...defaultService,
  createEmailSyncService,
  assertSyncAllowed,
  ERROR_CODES,
  HISTORICAL_PAGE_SIZE,
  RECONCILIATION_LIST_SIZE,
  TICK_MAX_CONNECTIONS,
};
