'use strict';

// Gmail OAuth connection flow orchestration (EM2 — Architecture/architecture/
// EMAIL_INGESTION.md §12, §14.1). Mirrors services/slackIntegrationService.js's
// shape and testing approach (dependency injection, no real network/Supabase
// calls in tests) with the one structural difference EM2 introduces:
// connections are member-scoped, not client-scoped — multiple members of the
// same client can each have their own active Gmail connection, so every
// function here takes/threads memberId, and disconnect only ever revokes the
// specific connection it was asked to, never every connection for the client.
//
// No organization policy, Gmail label, or sync/ingestion logic lives here —
// those are EM3/EM5+. This file connects/lists/disconnects (EM2) and, as of
// EM4, lets a member switch their own connection's sync_mode between
// manual_selected/automatic (§14.1) — still no label workflow or ingestion.
//
// Disconnect is self-service ONLY in EM2 — a member may disconnect only
// their own connection, with no owner/admin override, even though §14.1's
// general route table describes the eventual full-feature shape as
// "connection's own member or owner/admin." For a consent-sensitive
// feature like a personal mailbox connection, that administrative override
// is deliberately deferred to EM9 (member offboarding and policy
// reconciliation) rather than built now — see the EM2 Implementation
// Record in EMAIL_INGESTION.md for the full reasoning. updateSyncMode
// (EM4) follows the identical self-service-only shape — the route enforces
// canDisconnectConnection's own-connection check before calling it, no
// owner/admin override here either.

const { createClient } = require('@supabase/supabase-js');
const { supabase: supabaseConfig } = require('../config');
const defaultOauthStateService = require('./oauthStateService');
const defaultGmailService = require('./gmailService');
const defaultOauthConnectionsService = require('./oauthConnectionsService');
const defaultSupabaseService = require('./supabaseService');
const defaultEmailPolicyService = require('./emailPolicyService');

const SYNC_MODES = ['manual_selected', 'automatic'];

const PROVIDER = 'gmail';

// Safe portal redirects — never carry a raw error string, state, token, or
// mailbox address. Mirrors slackIntegrationService.js's REDIRECT constants.
const REDIRECT = Object.freeze({
  SUCCESS: '/portal.html?integration=gmail&status=connected',
  DENIED: '/portal.html?integration=gmail&error=access_denied',
  INVALID_STATE: '/portal.html?integration=gmail&error=invalid_state',
  EXPIRED_STATE: '/portal.html?integration=gmail&error=expired_state',
  CONNECTION_FAILED: '/portal.html?integration=gmail&error=connection_failed',
});

// Thin, EM2-only data access for the email_connections table (§13.1) — the
// one satellite table Gmail's connect flow needs that Slack's flow never
// did, since Slack has no per-connection metadata table of its own.
// Injectable like every other dependency below, so tests never touch a real
// Supabase project.
const defaultDbClient = createClient(supabaseConfig.url, supabaseConfig.serviceKey);

const defaultEmailConnectionsRepo = {
  async upsertConnection({ clientId, memberId, oauthConnectionId, provider, mailboxAddress, displayName }) {
    const { data, error } = await defaultDbClient
      .from('email_connections')
      .upsert(
        {
          client_id: clientId,
          member_id: memberId,
          oauth_connection_id: oauthConnectionId,
          provider,
          mailbox_address: mailboxAddress,
          display_name: displayName,
        },
        { onConflict: 'oauth_connection_id' }
      )
      .select('*')
      .maybeSingle();

    if (error) throw new Error(`upsertConnection failed: ${error.message}`);
    return data;
  },

  async getByOauthConnectionId(oauthConnectionId) {
    const { data, error } = await defaultDbClient
      .from('email_connections')
      .select('*')
      .eq('oauth_connection_id', oauthConnectionId)
      .maybeSingle();

    if (error) throw new Error(`getByOauthConnectionId failed: ${error.message}`);
    return data || null;
  },

  // EM4 (§14.1 POST /connections/:id/sync-mode) — :id in the route is always
  // the oauth_connections row's id (mapGmailConnectionResponse's
  // connectionId), never email_connections.id, matching disconnect's
  // existing convention above.
  async updateSyncMode(oauthConnectionId, syncMode) {
    const { data, error } = await defaultDbClient
      .from('email_connections')
      .update({ sync_mode: syncMode, updated_at: new Date().toISOString() })
      .eq('oauth_connection_id', oauthConnectionId)
      .select('*')
      .maybeSingle();

    if (error) throw new Error(`updateSyncMode failed: ${error.message}`);
    return data || null;
  },
};

/**
 * EM2 disconnect authorization — self-service only. A member may disconnect
 * only a connection they themselves own; there is no owner/admin override
 * in this milestone (see the file header comment). Pure and directly
 * testable, exactly like mapGmailConnectionResponse/mapSlackStatusResponse,
 * so this specific security boundary can be asserted without needing a real
 * authenticated HTTP session.
 */
function canDisconnectConnection({ connection, actingMemberId }) {
  return !!connection && !!actingMemberId && connection.connected_by_member_id === actingMemberId;
}

/**
 * Pure mapping from an oauth_connections row + its matching email_connections
 * row (may be null if the satellite row is somehow missing) to the API
 * response shape — allowlists fields explicitly, same discipline as
 * mapSlackStatusResponse.
 */
function mapGmailConnectionResponse(connectionRow, emailConnectionRow) {
  return {
    connectionId: connectionRow.id,
    memberId: connectionRow.connected_by_member_id,
    provider: PROVIDER,
    mailboxAddress: emailConnectionRow ? emailConnectionRow.mailbox_address : connectionRow.external_account_name,
    displayName: emailConnectionRow ? emailConnectionRow.display_name : null,
    syncMode: emailConnectionRow ? emailConnectionRow.sync_mode : null,
    syncEnabled: emailConnectionRow ? emailConnectionRow.sync_enabled : null,
    historicalImportStatus: emailConnectionRow ? emailConnectionRow.historical_import_status : null,
    status: connectionRow.status,
    connectedAt: connectionRow.connected_at,
  };
}

/**
 * @param {object} [deps] — injected for testing; each defaults to the real singleton service.
 */
function createEmailConnectionService({
  oauthStateService = defaultOauthStateService,
  gmailService = defaultGmailService,
  oauthConnectionsService = defaultOauthConnectionsService,
  supabaseService = defaultSupabaseService,
  emailConnectionsRepo = defaultEmailConnectionsRepo,
  emailPolicyService = defaultEmailPolicyService,
} = {}) {
  /**
   * GET /:provider/start — self-service: any active member whose role isn't
   * `viewer` may connect their own mailbox (enforced by the route's
   * middleware); not owner/admin-gated like Slack's /start.
   */
  async function startConnection({ clientId, memberId, provider }) {
    if (!clientId) throw new Error('startConnection requires clientId');
    if (!memberId) throw new Error('startConnection requires memberId');
    if (provider !== PROVIDER) throw new Error(`startConnection: unsupported provider "${provider}"`);
    if (!gmailService.isGmailConfigured()) {
      const err = new Error('Gmail OAuth is not configured');
      err.code = 'GMAIL_NOT_CONFIGURED';
      throw err;
    }

    const { rawState } = await oauthStateService.generateAndStoreState({ clientId, memberId, provider: PROVIDER });
    const url = gmailService.buildAuthorizationUrl({ state: rawState });
    return { url };
  }

  /**
   * GET /:provider/callback. Never throws — every rejection path (denial,
   * missing fields, invalid/expired/reused state, deactivated member, a
   * member demoted to `viewer` mid-round-trip, Gmail exchange failure,
   * persist failure) resolves to a safe redirect path instead. Never logs
   * the raw code, state, access/refresh token, or a full Gmail response.
   */
  async function handleCallback({ code, state, error }) {
    if (error) return { redirectPath: REDIRECT.DENIED };
    if (!code || !state) return { redirectPath: REDIRECT.INVALID_STATE };

    let consumed;
    try {
      consumed = await oauthStateService.consumeState({ rawState: state, provider: PROVIDER });
    } catch (err) {
      console.error('[gmail oauth] state consume error:', err.message);
      return { redirectPath: REDIRECT.CONNECTION_FAILED };
    }

    if (consumed.status === 'expired') return { redirectPath: REDIRECT.EXPIRED_STATE };
    if (consumed.status !== 'consumed') return { redirectPath: REDIRECT.INVALID_STATE }; // not_found | reused | provider_mismatch

    const { clientId, memberId } = consumed;

    let clientRow, member;
    try {
      [clientRow, member] = await Promise.all([
        supabaseService.getClientById(clientId),
        supabaseService.getClientMemberById(memberId, clientId),
      ]);
    } catch (err) {
      console.error('[gmail oauth] org/member lookup error:', err.message);
      return { redirectPath: REDIRECT.CONNECTION_FAILED };
    }

    if (!clientRow || !clientRow.is_active) return { redirectPath: REDIRECT.CONNECTION_FAILED };
    // Self-service: any active member except `viewer` — re-verified here in
    // case the member's role or status changed during the OAuth round trip.
    if (!member || member.status !== 'active' || member.role === 'viewer') {
      return { redirectPath: REDIRECT.CONNECTION_FAILED };
    }

    let tokenData;
    try {
      tokenData = await gmailService.exchangeCodeForToken(code);
    } catch (err) {
      console.error('[gmail oauth] token exchange error:', err.code || 'unknown');
      return { redirectPath: REDIRECT.CONNECTION_FAILED };
    }

    let connection;
    try {
      await oauthConnectionsService.createOrReplaceConnection({
        clientId,
        provider: PROVIDER,
        externalAccountId: tokenData.externalAccountId,
        externalAccountName: tokenData.mailboxAddress,
        scopesGranted: tokenData.scopes,
        providerMetadata: {
          mailbox_address: tokenData.mailboxAddress,
          display_name: tokenData.displayName,
        },
        connectedByMemberId: memberId,
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken,
        expiresAt: tokenData.expiresAt,
      });
      // createOrReplaceConnection's return value is the safe, allowlisted
      // status shape (no id, by design — see toSafeConnectionStatus) — a
      // second, member-scoped read gets us the connection's real id to link
      // the email_connections row, without loosening that safe-shape contract.
      connection = await oauthConnectionsService.getActiveConnectionForClientAndMember(clientId, PROVIDER, memberId);
    } catch (err) {
      console.error('[gmail oauth] connection persist error:', err.message);
      return { redirectPath: REDIRECT.CONNECTION_FAILED };
    }

    if (!connection) {
      // Defensive — should be unreachable if createOrReplaceConnection just
      // succeeded, but never assume a satellite read agrees with a write.
      console.error('[gmail oauth] connection persist error: connection not found immediately after create');
      return { redirectPath: REDIRECT.CONNECTION_FAILED };
    }

    try {
      await emailConnectionsRepo.upsertConnection({
        clientId,
        memberId,
        oauthConnectionId: connection.id,
        provider: PROVIDER,
        mailboxAddress: tokenData.mailboxAddress,
        displayName: tokenData.displayName,
      });
    } catch (err) {
      console.error('[gmail oauth] email_connections persist error:', err.message);
      return { redirectPath: REDIRECT.CONNECTION_FAILED };
    }

    return { redirectPath: REDIRECT.SUCCESS };
  }

  /**
   * GET /connections — any active member sees their own connection by
   * default; `all=true` only takes effect when the caller is owner/admin
   * (a non-admin passing it is silently ignored, fail-safe). Always returns
   * `{ connections: [...] }`, 0 or 1 items in the own-connection case, so
   * the response shape never differs by caller role.
   */
  async function getConnections({ clientId, memberId, isOwnerAdmin, all }) {
    if (!clientId) throw new Error('getConnections requires clientId');
    if (!memberId) throw new Error('getConnections requires memberId');

    if (all && isOwnerAdmin) {
      const rows = await oauthConnectionsService.listActiveConnectionsForClient(clientId, PROVIDER);
      const connections = await Promise.all(
        rows.map(async (row) => mapGmailConnectionResponse(row, await emailConnectionsRepo.getByOauthConnectionId(row.id)))
      );
      return { connections };
    }

    const row = await oauthConnectionsService.getActiveConnectionForClientAndMember(clientId, PROVIDER, memberId);
    if (!row) return { connections: [] };
    const emailConnectionRow = await emailConnectionsRepo.getByOauthConnectionId(row.id);
    return { connections: [mapGmailConnectionResponse(row, emailConnectionRow)] };
  }

  /**
   * POST /connections/:id/disconnect — the route loads the connection first
   * and enforces canDisconnectConnection (self-service only in EM2) before
   * ever calling this; this function re-fetches by id itself rather than
   * trusting a caller-supplied row, and only ever revokes the specific
   * member's connection it was given — never every gmail connection for the
   * client. Idempotent, mirrors slackIntegrationService.js's disconnect.
   */
  async function disconnect({ clientId, connectionId }) {
    if (!clientId) throw new Error('disconnect requires clientId');
    if (!connectionId) throw new Error('disconnect requires connectionId');

    const connection = await oauthConnectionsService.getConnectionById(connectionId);
    if (!connection || connection.client_id !== clientId || connection.provider !== PROVIDER || connection.status !== 'active') {
      return { disconnected: true }; // already disconnected / not found / wrong client — safe no-op
    }

    let accessToken = null;
    try {
      const credential = await oauthConnectionsService.getDecryptedCredentialForConnection(connection.id);
      accessToken = credential ? credential.accessToken : null;
    } catch (err) {
      // Decryption failure must not block local revocation — the connection
      // still gets marked revoked below so it can never be used again.
      console.error('[gmail oauth] credential decrypt error during disconnect:', err.message);
    }

    if (accessToken) {
      // Best-effort — revokeToken never throws, and its outcome never
      // changes whether the local connection is marked revoked.
      await gmailService.revokeToken(accessToken);
    }

    await oauthConnectionsService.markConnectionRevokedForMember(clientId, PROVIDER, connection.connected_by_member_id);
    return { disconnected: true };
  }

  /**
   * POST /connections/:id/sync-mode (EM4 — §14.1). The route loads the
   * oauth_connections row and enforces canDisconnectConnection's same
   * own-connection-only check before calling this (identical ownership
   * shape to disconnect — EM4 gives no owner/admin override here either).
   * Rejects `automatic` with AUTOMATIC_SYNC_DISABLED while the client's
   * email_organization_settings.automatic_sync_enabled is false (§Manual vs
   * Automatic Sync) — `paused` is out of scope here, reached only via a
   * separate pause/resume control this milestone doesn't build (§31's EM4
   * entry lists only sync-mode + search_enabled).
   */
  async function updateSyncMode({ clientId, oauthConnectionId, syncMode }) {
    if (!clientId) throw new Error('updateSyncMode requires clientId');
    if (!oauthConnectionId) throw new Error('updateSyncMode requires oauthConnectionId');
    if (!SYNC_MODES.includes(syncMode)) {
      const err = new Error(`updateSyncMode: unsupported syncMode "${syncMode}"`);
      err.code = 'INVALID_SYNC_MODE';
      throw err;
    }

    if (syncMode === 'automatic') {
      const { automaticSyncEnabled } = await emailPolicyService.getSettings(clientId);
      if (!automaticSyncEnabled) {
        const err = new Error('Automatic sync is not enabled for this organization.');
        err.code = 'AUTOMATIC_SYNC_DISABLED';
        throw err;
      }
    }

    const updated = await emailConnectionsRepo.updateSyncMode(oauthConnectionId, syncMode);
    if (!updated) {
      const err = new Error('Email connection not found.');
      err.code = 'CONNECTION_NOT_FOUND';
      throw err;
    }

    return { syncMode: updated.sync_mode };
  }

  return { startConnection, handleCallback, getConnections, disconnect, updateSyncMode };
}

const defaultService = createEmailConnectionService();

module.exports = {
  ...defaultService,
  createEmailConnectionService,
  mapGmailConnectionResponse,
  canDisconnectConnection,
  REDIRECT,
  PROVIDER,
};
