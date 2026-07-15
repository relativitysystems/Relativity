'use strict';

// Slack OAuth connection flow orchestration (Architecture Review Phase 4,
// Milestone 3). Wires together oauthStateService, slackService, and
// oauthConnectionsService into the four operations routes/integrations/
// slack.js exposes as HTTP endpoints. Kept separate from the route module
// (which stays a thin Express adapter) so the entire flow — including the
// callback's many rejection paths — is unit-testable via dependency
// injection, with no real Slack or Supabase network calls, matching this
// repo's existing testing convention (see services/oauthConnectionsService.js).
//
// AIKB never receives or stores Slack credentials — this module never calls
// aikbService and never leaves this repository's Global DB boundary.

const defaultOauthStateService = require('./oauthStateService');
const defaultSlackService = require('./slackService');
const defaultOauthConnectionsService = require('./oauthConnectionsService');
const defaultSupabaseService = require('./supabaseService');

const PROVIDER = 'slack';
const OWNER_ADMIN_ROLES = ['owner', 'admin'];

// Safe portal redirects — never carry a raw Slack error string, state,
// token, or workspace ID. See §13 of the Milestone 3 objective.
const REDIRECT = Object.freeze({
  SUCCESS: '/portal.html?integration=slack&status=connected',
  DENIED: '/portal.html?integration=slack&error=access_denied',
  INVALID_STATE: '/portal.html?integration=slack&error=invalid_state',
  EXPIRED_STATE: '/portal.html?integration=slack&error=expired_state',
  CONNECTION_FAILED: '/portal.html?integration=slack&error=connection_failed',
});

/**
 * Pure mapping from an oauth_connections row (metadata-only — never a
 * credential row) to the Slack status endpoint's response shape. Allowlists
 * fields explicitly rather than spreading provider_metadata, so an
 * unexpected key added to that JSONB blob in the future can never leak
 * through by accident.
 */
function mapSlackStatusResponse(connectionRow) {
  if (!connectionRow || connectionRow.status !== 'active') {
    return { connected: false, provider: PROVIDER };
  }

  const meta = (connectionRow.provider_metadata && typeof connectionRow.provider_metadata === 'object')
    ? connectionRow.provider_metadata
    : {};

  return {
    connected: true,
    provider: PROVIDER,
    workspaceId: connectionRow.external_account_id || null,
    workspaceName: connectionRow.external_account_name || null,
    botUserId: typeof meta.bot_user_id === 'string' ? meta.bot_user_id : null,
    scopes: Array.isArray(connectionRow.scopes_granted) ? connectionRow.scopes_granted : [],
    status: connectionRow.status,
    connectedAt: connectionRow.connected_at || null,
  };
}

/**
 * @param {object} [deps] — injected for testing; each defaults to the real singleton service.
 */
function createSlackIntegrationService({
  oauthStateService = defaultOauthStateService,
  slackService = defaultSlackService,
  oauthConnectionsService = defaultOauthConnectionsService,
  supabaseService = defaultSupabaseService,
} = {}) {
  /** GET /start — requires an already-authorized (owner/admin) caller; enforced by the route's middleware. */
  async function startConnection({ clientId, memberId }) {
    if (!clientId) throw new Error('startConnection requires clientId');
    if (!memberId) throw new Error('startConnection requires memberId');
    if (!slackService.isSlackConfigured()) {
      const err = new Error('Slack OAuth is not configured');
      err.code = 'SLACK_NOT_CONFIGURED';
      throw err;
    }

    const { rawState } = await oauthStateService.generateAndStoreState({ clientId, memberId, provider: PROVIDER });
    const url = slackService.buildAuthorizationUrl({ state: rawState });
    return { url };
  }

  /**
   * GET /callback. Never throws — every rejection path (denial, missing
   * fields, invalid/expired/reused state, deactivated or demoted member,
   * Slack exchange failure) resolves to a safe redirect path instead, so
   * the route handler can always just `res.redirect(...)` the result. Never
   * logs the raw code, state, access token, or a full Slack response.
   */
  async function handleCallback({ code, state, error }) {
    if (error) return { redirectPath: REDIRECT.DENIED };
    if (!code || !state) return { redirectPath: REDIRECT.INVALID_STATE };

    let consumed;
    try {
      consumed = await oauthStateService.consumeState({ rawState: state, provider: PROVIDER });
    } catch (err) {
      console.error('[slack oauth] state consume error:', err.message);
      return { redirectPath: REDIRECT.CONNECTION_FAILED };
    }

    if (consumed.status === 'expired') return { redirectPath: REDIRECT.EXPIRED_STATE };
    if (consumed.status !== 'consumed') return { redirectPath: REDIRECT.INVALID_STATE }; // not_found | reused | provider_mismatch

    const { clientId, memberId } = consumed;

    let client, member;
    try {
      [client, member] = await Promise.all([
        supabaseService.getClientById(clientId),
        supabaseService.getClientMemberById(memberId, clientId),
      ]);
    } catch (err) {
      console.error('[slack oauth] org/member lookup error:', err.message);
      return { redirectPath: REDIRECT.CONNECTION_FAILED };
    }

    if (!client || !client.is_active) return { redirectPath: REDIRECT.CONNECTION_FAILED };
    if (!member || member.status !== 'active' || !OWNER_ADMIN_ROLES.includes(member.role)) {
      return { redirectPath: REDIRECT.CONNECTION_FAILED };
    }

    let tokenData;
    try {
      tokenData = await slackService.exchangeCodeForToken(code);
    } catch (err) {
      console.error('[slack oauth] token exchange error:', err.code || 'unknown');
      return { redirectPath: REDIRECT.CONNECTION_FAILED };
    }

    try {
      await oauthConnectionsService.createOrReplaceConnection({
        clientId,
        provider: PROVIDER,
        externalAccountId: tokenData.team.id,
        externalAccountName: tokenData.team.name,
        scopesGranted: tokenData.scopes,
        providerMetadata: {
          team_id: tokenData.team.id,
          team_name: tokenData.team.name,
          enterprise_id: tokenData.enterprise ? tokenData.enterprise.id : null,
          enterprise_name: tokenData.enterprise ? tokenData.enterprise.name : null,
          bot_user_id: tokenData.botUserId,
          app_id: tokenData.appId,
          token_type: tokenData.tokenType,
        },
        connectedByMemberId: memberId,
        accessToken: tokenData.accessToken,
      });
    } catch (err) {
      console.error('[slack oauth] connection persist error:', err.message);
      return { redirectPath: REDIRECT.CONNECTION_FAILED };
    }

    return { redirectPath: REDIRECT.SUCCESS };
  }

  /** GET /status — any authenticated active member (route middleware enforces auth); org resolved server-side by the caller. */
  async function getStatus({ clientId }) {
    if (!clientId) throw new Error('getStatus requires clientId');
    const connection = await oauthConnectionsService.getActiveConnectionForClient(clientId, PROVIDER);
    return mapSlackStatusResponse(connection);
  }

  /** POST /disconnect — owner/admin required (enforced by the route's middleware); idempotent. */
  async function disconnect({ clientId }) {
    if (!clientId) throw new Error('disconnect requires clientId');

    const connection = await oauthConnectionsService.getActiveConnectionForClient(clientId, PROVIDER);
    if (!connection) return { disconnected: true }; // already disconnected — safe no-op

    let accessToken = null;
    try {
      const credential = await oauthConnectionsService.getDecryptedCredentialForConnection(connection.id);
      accessToken = credential ? credential.accessToken : null;
    } catch (err) {
      // Decryption failure must not block local revocation — the connection
      // still gets marked revoked below so it can never be used again.
      console.error('[slack oauth] credential decrypt error during disconnect:', err.message);
    }

    if (accessToken) {
      // Best-effort — revokeToken never throws, and its outcome (true/false)
      // never changes whether the local connection is marked revoked.
      await slackService.revokeToken(accessToken);
    }

    await oauthConnectionsService.markConnectionRevoked(clientId, PROVIDER);
    return { disconnected: true };
  }

  return { startConnection, handleCallback, getStatus, disconnect };
}

const defaultService = createSlackIntegrationService();

module.exports = {
  ...defaultService,
  createSlackIntegrationService,
  mapSlackStatusResponse,
  REDIRECT,
};
