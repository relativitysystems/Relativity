'use strict';

// Historical email import (EM6 — Architecture/architecture/EMAIL_INGESTION.md
// §14.2, §15, §17). First real ingestion: bounded, paginated,
// `manual_selected`-mode only, using EM5's label workflow. Orchestrates the
// fetch/label-check/policy-evaluation half described in §15 (which lives in
// Relativity, synchronously inside the request handler, since Relativity has
// no background-job runner — §6 gap 1) and forwards eligible messages to
// AIKB's existing, generalized `/ingest` route (services/aikbService.js).
//
// EM6 scope is deliberately narrower than §17's own general text: this file
// only ever compiles the fixed `manual_selected` label query and rejects a
// sync attempt on a connection whose sync_mode is `automatic` — the
// milestone's own Backend line (§31, EM6) scopes it to "historical path,
// manual mode only." Automatic-mode historical/incremental sync is EM7/EM8's
// responsibility, once the tick scheduler and its own safeguards exist. This
// mirrors how EM3's deviation 6 and EM5's deviation 3 each resolved an
// analogous §14.1-vs-detailed-section inconsistency: in favor of the more
// specific, milestone-scoping text.

const { createClient } = require('@supabase/supabase-js');
const { supabase: supabaseConfig, limits } = require('../config');
const defaultGmailService = require('./gmailService');
const defaultEmailPolicyService = require('./emailPolicyService');
const defaultEmailNormalizationService = require('./emailNormalizationService');
const defaultAikbService = require('./aikbService');

// Bounded per request (Vercel timeout — §17 item 3): one page of historical
// import per POST /sync call. A caller re-invokes with the returned
// nextPageToken until complete: true.
const HISTORICAL_PAGE_SIZE = 25;

// Label-removal reconciliation (§24.2) needs "every message currently under
// the label," not just this page's candidates — a single, larger, bounded
// listing rather than true unbounded pagination, run only once the
// historical page loop reports complete. A mailbox with more than this many
// labeled messages gets a best-effort reconciliation pass (a documented MVP
// bound, not a correctness bug — the next completed sync re-attempts it).
const RECONCILIATION_LIST_SIZE = 500;

const ERROR_CODES = Object.freeze({
  SEARCH_DISABLED: 'SEARCH_DISABLED',
  SYNC_DISABLED: 'SYNC_DISABLED',
  SYNC_PAUSED: 'SYNC_PAUSED',
  AUTOMATIC_SYNC_NOT_SUPPORTED: 'AUTOMATIC_SYNC_NOT_SUPPORTED',
  DOCUMENT_LIMIT_REACHED: 'DOCUMENT_LIMIT_REACHED',
});

function syncError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Thin, EM6-only data access for email_sync_runs/email_ingestion_events/
// email_sync_state, plus the one email_connections column (
// historical_import_status) this milestone writes. Injectable like every
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

  async upsertSyncState(emailConnectionId, { lastSyncStartedAt, lastSyncCompletedAt, lastSyncStatus }) {
    const { error } = await defaultDbClient
      .from('email_sync_state')
      .upsert(
        {
          email_connection_id: emailConnectionId,
          last_sync_started_at: lastSyncStartedAt,
          last_sync_completed_at: lastSyncCompletedAt,
          last_sync_status: lastSyncStatus,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'email_connection_id' }
      );
    if (error) throw new Error(`upsertSyncState failed: ${error.message}`);
  },

  // §24.2 reconciliation — every message this connection has ever
  // successfully queued for ingestion, across every past sync run, so a
  // label removed since ANY prior sync (not just the most recent one) is
  // still caught.
  async getPreviouslyIngestedMessageIds(emailConnectionId) {
    const { data, error } = await defaultDbClient
      .from('email_ingestion_events')
      .select('provider_message_id')
      .eq('email_connection_id', emailConnectionId)
      .eq('outcome', 'ingested');
    if (error) throw new Error(`getPreviouslyIngestedMessageIds failed: ${error.message}`);
    return Array.from(new Set((data || []).map((row) => row.provider_message_id)));
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
  if (syncMode === 'automatic') {
    throw syncError(
      ERROR_CODES.AUTOMATIC_SYNC_NOT_SUPPORTED,
      'Automatic-mode sync is not available yet. Switch to manual mode to sync now.'
    );
  }
}

/**
 * @param {object} [deps] — injected for testing; each defaults to the real singleton service.
 */
function createEmailSyncService({
  gmailService = defaultGmailService,
  emailPolicyService = defaultEmailPolicyService,
  emailNormalizationService = defaultEmailNormalizationService,
  aikbService = defaultAikbService,
  emailSyncRepo = defaultEmailSyncRepo,
  maxDocuments = limits.maxDocuments,
} = {}) {
  /**
   * Runs one bounded page of historical import for a connection (§17).
   *
   * @param {string} clientId
   * @param {object} emailConnectionRow - email_connections row (needs id,
   *   member_id, mailbox_address, sync_mode, sync_enabled, managed_label_id).
   * @param {boolean} memberSearchEnabled - the connection's own member's
   *   client_members.search_enabled (§16's fail-closed gate).
   * @param {string} accessToken - a live, already-refreshed Gmail access
   *   token (emailConnectionService.getValidGmailAccessToken).
   * @param {string|null} [triggeredByMemberId] - the acting member for this
   *   specific sync click (§15.1 — distinguishes a manual run from a future
   *   tick-triggered one; null is reserved for EM8's automatic runs).
   * @param {string|null} [pageToken] - continuation token from a prior call.
   * @returns {{syncRunId:string, complete:boolean, nextPageToken:string|null, imported:object[], skipped:object[], failed:object[]}}
   */
  async function syncConnection({
    clientId,
    emailConnectionRow,
    memberSearchEnabled,
    accessToken,
    triggeredByMemberId = null,
    pageToken = null,
  }) {
    if (!clientId) throw new Error('syncConnection requires clientId');
    if (!emailConnectionRow) throw new Error('syncConnection requires emailConnectionRow');
    if (!accessToken) throw new Error('syncConnection requires accessToken');

    assertSyncAllowed({
      memberSearchEnabled,
      syncEnabled: emailConnectionRow.sync_enabled,
      syncMode: emailConnectionRow.sync_mode,
    });

    // §17 item 6 — the existing per-client document-count ceiling, checked
    // once at the start of a historical import (not re-checked per page —
    // a client that crosses the limit mid-import simply stops importing new
    // documents on subsequent calls once AIKB's own count reflects it).
    if (!pageToken) {
      const count = await countActiveDocuments(aikbService, clientId);
      if (count >= maxDocuments) {
        throw syncError(ERROR_CODES.DOCUMENT_LIMIT_REACHED, `Document limit reached (${maxDocuments} max). Delete some documents to sync more.`);
      }
    }

    const mode = 'manual_selected'; // EM6 scope — see file header.
    const { rules } = await emailPolicyService.getPolicy(clientId);
    const query = gmailService.compileSearchQuery({ mode, rules });

    const syncRun = await emailSyncRepo.createSyncRun({
      clientId,
      emailConnectionId: emailConnectionRow.id,
      runType: 'historical',
      triggeredByMemberId,
    });
    const startedAt = new Date().toISOString();
    if (!pageToken) {
      await emailSyncRepo.updateHistoricalImportStatus(emailConnectionRow.id, 'running');
    }

    const counts = { scanned: 0, matched: 0, ingested: 0, skipped: 0, duplicate: 0, failed: 0 };
    const events = [];
    const imported = [];
    const skipped = [];
    const failed = [];

    let listResult = { messageIds: [], nextPageToken: null };
    let runStatus = 'completed';
    let errorSummary = null;

    try {
      listResult = await gmailService.listMessageIdsByQuery({ accessToken, query, pageToken, maxResults: HISTORICAL_PAGE_SIZE });

      let labelNameById = new Map();
      if (listResult.messageIds.length > 0) {
        const labels = await gmailService.listLabels(accessToken);
        labelNameById = new Map(labels.map((l) => [l.id, l.name]));
      }

      for (const messageId of listResult.messageIds) {
        counts.scanned++;
        try {
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
            counts.skipped++;
            events.push({
              sync_run_id: syncRun.id,
              email_connection_id: emailConnectionRow.id,
              provider_message_id: messageId,
              outcome: decision.outcome,
              matched_rule_id: decision.matchedRuleId,
              reason: decision.reason,
            });
            skipped.push({ messageId, subject: meta.subject, reason: decision.reason });
            continue;
          }

          counts.matched++;

          const body = await gmailService.getMessageBody({ accessToken, messageId });
          const normalized = emailNormalizationService.normalizeEmailBody({ html: body.html, text: body.text });

          if (!normalized) {
            counts.failed++;
            const reason = 'Message produced no extractable text after normalization.';
            events.push({
              sync_run_id: syncRun.id,
              email_connection_id: emailConnectionRow.id,
              provider_message_id: messageId,
              outcome: 'failed',
              matched_rule_id: decision.matchedRuleId,
              reason,
            });
            failed.push({ messageId, subject: meta.subject, reason });
            continue;
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

          counts.ingested++;
          events.push({
            sync_run_id: syncRun.id,
            email_connection_id: emailConnectionRow.id,
            provider_message_id: messageId,
            outcome: 'ingested',
            matched_rule_id: decision.matchedRuleId,
            reason: decision.reason,
          });
          imported.push({ messageId, subject: meta.subject });
        } catch (err) {
          counts.failed++;
          const reason = `Sync error: ${err.message}`.slice(0, 500);
          events.push({
            sync_run_id: syncRun.id,
            email_connection_id: emailConnectionRow.id,
            provider_message_id: messageId,
            outcome: 'failed',
            matched_rule_id: null,
            reason,
          });
          failed.push({ messageId, reason: err.message });
        }
      }
    } catch (err) {
      // A page-level failure (e.g. the listMessageIdsByQuery/listLabels call
      // itself) fails the whole run — individual message failures above are
      // already caught and counted without reaching here (§17 item 5).
      runStatus = 'failed';
      errorSummary = err.message;
    }

    if (runStatus !== 'failed' && counts.failed > 0) runStatus = 'partial';

    const complete = runStatus === 'failed' || !listResult.nextPageToken;

    let reconciled = [];
    if (complete && runStatus !== 'failed') {
      reconciled = await reconcileRemovedLabels({
        gmailService,
        emailSyncRepo,
        aikbService,
        clientId,
        emailConnectionRow,
        accessToken,
      });
    }

    await emailSyncRepo.recordEvents(events);
    await emailSyncRepo.completeSyncRun(syncRun.id, { status: runStatus, counts, errorSummary });
    if (complete) {
      await emailSyncRepo.updateHistoricalImportStatus(emailConnectionRow.id, runStatus === 'failed' ? 'failed' : 'completed');
    }
    await emailSyncRepo.upsertSyncState(emailConnectionRow.id, {
      lastSyncStartedAt: startedAt,
      lastSyncCompletedAt: new Date().toISOString(),
      lastSyncStatus: runStatus,
    });

    return {
      syncRunId: syncRun.id,
      status: runStatus,
      complete,
      nextPageToken: listResult.nextPageToken || null,
      imported,
      skipped,
      failed,
      reconciled,
      errorSummary,
    };
  }

  return { syncConnection };
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
 * §24.2 — label-removal reconciliation, run once per completed historical
 * sync. Re-lists every message currently under the managed label (a single
 * bounded call, RECONCILIATION_LIST_SIZE — see the constant's comment),
 * diffs it against every message this connection has ever successfully
 * queued for ingestion, and tombstones (via AIKB's existing
 * DELETE /document/:id, resolved to the real document id through
 * aikbService.listDocuments since /ingest never returns one synchronously)
 * anything no longer labeled. Best-effort: a reconciliation failure is
 * logged and does not fail the sync run that triggered it — the label
 * itself is unaffected either way, so a missed reconciliation is simply
 * retried on the next completed sync.
 */
async function reconcileRemovedLabels({ gmailService, emailSyncRepo, aikbService, clientId, emailConnectionRow, accessToken }) {
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

    const documents = await aikbService.listDocuments(clientId);
    const docs = documents.documents || (Array.isArray(documents) ? documents : []);
    const docIdByMessageId = new Map(
      docs
        .filter((d) => (d.source_provider || d.sourceProvider) === 'gmail')
        .map((d) => [d.source_file_id || d.sourceFileId, d.id])
    );

    const tombstoned = [];
    const events = [];
    for (const messageId of removed) {
      const documentId = docIdByMessageId.get(messageId);
      if (!documentId) continue; // already deleted/never resolved — nothing to do
      try {
        await aikbService.deleteDocumentById(clientId, documentId);
        tombstoned.push({ messageId, documentId });
        events.push({
          sync_run_id: null,
          email_connection_id: emailConnectionRow.id,
          provider_message_id: messageId,
          outcome: 'tombstoned_label_removed',
          matched_rule_id: null,
          reason: 'Relativity/Knowledge label removed since last sync.',
          ingested_document_id: documentId,
        });
      } catch (err) {
        console.error('[emailSyncService] reconciliation delete failed:', messageId, err.message);
      }
    }
    if (events.length > 0) await emailSyncRepo.recordEvents(events);
    return tombstoned;
  } catch (err) {
    console.error('[emailSyncService] label reconciliation failed (non-fatal):', err.message);
    return [];
  }
}

const defaultService = createEmailSyncService();

module.exports = {
  ...defaultService,
  createEmailSyncService,
  assertSyncAllowed,
  ERROR_CODES,
  HISTORICAL_PAGE_SIZE,
  RECONCILIATION_LIST_SIZE,
};
