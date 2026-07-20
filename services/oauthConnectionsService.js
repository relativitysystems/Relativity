'use strict';

// OAuth connection + encrypted credential storage (Architecture Review
// Phase 4, Milestone 2). Provider-agnostic — "client" here follows the
// existing clients/client_id schema, but every interface and comment in
// this file uses "organization" terminology per the Phase 3 domain model
// (client == organization, Phase 3 §1).
//
// This is the safe replacement for supabaseService.upsertToken/getToken.
// Slack migrated first (Milestone 3); Google Drive and Dropbox migrated
// separately (backlog H2) — see the deprecation note on upsertToken in
// supabaseService.js.
//
// Exported as a ready-to-use singleton (matching this repo's existing
// service-module convention), plus a createOauthConnectionsService(client)
// factory so tests can inject a fake Supabase client instead of making real
// network calls — this repo has no test-database pattern (confirmed: every
// existing test in test/*.test.js exercises pure functions only).

const { createClient } = require('@supabase/supabase-js');
const { supabase: supabaseConfig } = require('../config');
const { encryptCredential, decryptCredential, getCurrentKeyVersion } = require('./integrationCredentialEncryption');

// encryption_key_version identifies WHICH configured encryption key
// produced a row's ciphertext — a Postgres `integer` column. This is a
// distinct concern from the envelope's own `version` field (produced by
// integrationCredentialEncryption.js), which identifies the ciphertext
// *serialization/algorithm format* instead. Neither is derived from the
// other; a key rotation bumps this value without touching envelope
// version, and a future envelope format change bumps envelope version
// without implying a key rotation happened.
//
// Backlog M3 — this used to be a hardcoded `1`, which meant a row's stored
// encryption_key_version was written but never actually read back at
// decrypt time (getDecryptedCredentialForConnection always decrypted with
// whatever key was "current" at read time, not the key that encrypted that
// specific row). It's now delegated to integrationCredentialEncryption.js's
// getCurrentKeyVersion(), the single source of truth for "which version is
// current," and every read path passes the row's own stored version back
// into decryptCredential — see getDecryptedCredentialForConnection below.

// Keep in sync with supabase/migrations/20260714_oauth_connections.sql's
// `provider` CHECK constraint on oauth_connections — enforced here too so a
// typo'd/unsupported provider fails with a clear application error instead
// of an opaque Postgres constraint-violation message. Verified against the
// actual migration file by test/oauthConnectionsService.test.js.
const SUPPORTED_PROVIDERS = ['slack', 'microsoft', 'gmail', 'google_drive', 'dropbox'];

// Keep in sync with the same migration's `status` CHECK constraint.
// Application code today only ever writes ACTIVE/REVOKED; EXPIRED/ERROR are
// reserved for future use (e.g. a token-refresh sweep) but already allowed
// by the database so that future write path needs no migration.
const STATUS = Object.freeze({ ACTIVE: 'active', REVOKED: 'revoked', EXPIRED: 'expired', ERROR: 'error' });

/**
 * Pure mapping from a raw oauth_connections row to the safe, public status
 * shape. No database access — kept separate so response-shape safety is
 * unit-testable without a database, and so this is the one place that
 * decides what's safe to return. Deliberately allowlists fields rather than
 * spreading the row, so an unexpected extra column (e.g. a future join)
 * can never leak through by accident.
 *
 * @param {object|null} connectionRow — a row from oauth_connections, or null.
 */
function toSafeConnectionStatus(connectionRow) {
  if (!connectionRow || connectionRow.status !== STATUS.ACTIVE) {
    return {
      connected: false,
      provider: connectionRow ? connectionRow.provider : null,
      externalAccountId: null,
      externalAccountName: null,
      scopes: [],
      status: connectionRow ? connectionRow.status : null,
      connectedAt: null,
    };
  }

  return {
    connected: true,
    provider: connectionRow.provider,
    externalAccountId: connectionRow.external_account_id,
    externalAccountName: connectionRow.external_account_name,
    scopes: connectionRow.scopes_granted || [],
    status: connectionRow.status,
    connectedAt: connectionRow.connected_at,
  };
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 */
function createOauthConnectionsService(client) {
  /**
   * Encrypts tokens server-side, then writes the connection + credential
   * atomically via the replace_active_oauth_connection RPC (see the
   * migration comment for why this is the atomicity boundary instead of
   * separate client-side insert calls). Never stores or returns plaintext.
   */
  async function createOrReplaceConnection({
    clientId,
    provider,
    externalAccountId = null,
    externalAccountName = null,
    scopesGranted = [],
    providerMetadata = {},
    connectedByMemberId = null,
    accessToken,
    refreshToken = null,
    expiresAt = null,
  }) {
    if (!clientId) throw new Error('createOrReplaceConnection requires clientId');
    if (!provider) throw new Error('createOrReplaceConnection requires provider');
    if (!SUPPORTED_PROVIDERS.includes(provider)) {
      throw new Error(`createOrReplaceConnection: unsupported provider "${provider}" — must be one of ${SUPPORTED_PROVIDERS.join(', ')}`);
    }
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new Error('createOrReplaceConnection requires a non-empty accessToken');
    }

    // Encryption happens before any database call — plaintext never
    // crosses into a Supabase client call, an RPC argument, or a log line.
    const accessTokenEncrypted = encryptCredential(accessToken);
    const refreshTokenEncrypted = refreshToken ? encryptCredential(refreshToken) : null;

    const { data, error } = await client.rpc('replace_active_oauth_connection', {
      p_client_id: clientId,
      p_provider: provider,
      p_external_account_id: externalAccountId,
      p_external_account_name: externalAccountName,
      p_scopes_granted: scopesGranted,
      p_provider_metadata: providerMetadata,
      p_connected_by_member_id: connectedByMemberId,
      p_access_token_encrypted: accessTokenEncrypted,
      p_refresh_token_encrypted: refreshTokenEncrypted,
      p_expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
      p_encryption_key_version: getCurrentKeyVersion(),
    });

    if (error) throw new Error(`createOrReplaceConnection failed: ${error.message}`);
    return toSafeConnectionStatus(data);
  }

  async function getActiveConnectionForClient(clientId, provider) {
    if (!clientId) throw new Error('getActiveConnectionForClient requires clientId');
    if (!provider) throw new Error('getActiveConnectionForClient requires provider');

    const { data, error } = await client
      .from('oauth_connections')
      .select('*')
      .eq('client_id', clientId)
      .eq('provider', provider)
      .eq('status', STATUS.ACTIVE)
      .maybeSingle();

    if (error) throw new Error(`getActiveConnectionForClient failed: ${error.message}`);
    return data || null;
  }

  async function getActiveConnectionByExternalAccount(provider, externalAccountId) {
    if (!provider) throw new Error('getActiveConnectionByExternalAccount requires provider');
    if (!externalAccountId) throw new Error('getActiveConnectionByExternalAccount requires externalAccountId');

    const { data, error } = await client
      .from('oauth_connections')
      .select('*')
      .eq('provider', provider)
      .eq('external_account_id', externalAccountId)
      .eq('status', STATUS.ACTIVE)
      .maybeSingle();

    if (error) throw new Error(`getActiveConnectionByExternalAccount failed: ${error.message}`);
    return data || null;
  }

  /**
   * Metadata-only lookup by connection id (never touches oauth_credentials).
   * Added for Architecture Review Phase 4, Milestone 4 — the Slack delivery
   * path (§4.13), and its bounded in-flow retries (ADR-007), need to
   * re-verify a specific connection is still active without going back
   * through the team_id/client_id lookups.
   */
  async function getConnectionById(connectionId) {
    if (!connectionId) throw new Error('getConnectionById requires connectionId');

    const { data, error } = await client
      .from('oauth_connections')
      .select('*')
      .eq('id', connectionId)
      .maybeSingle();

    if (error) throw new Error(`getConnectionById failed: ${error.message}`);
    return data || null;
  }

  async function getSafeConnectionStatus(clientId, provider) {
    const connection = await getActiveConnectionForClient(clientId, provider);
    return toSafeConnectionStatus(connection);
  }

  /**
   * Server-only. Decrypts in memory and returns the smallest object
   * necessary to make a provider API call — never logged, never returned
   * from an HTTP route directly.
   */
  async function getDecryptedCredentialForConnection(connectionId) {
    if (!connectionId) throw new Error('getDecryptedCredentialForConnection requires connectionId');

    const { data, error } = await client
      .from('oauth_credentials')
      .select('access_token_encrypted, refresh_token_encrypted, expires_at, encryption_key_version')
      .eq('connection_id', connectionId)
      .maybeSingle();

    if (error) throw new Error(`getDecryptedCredentialForConnection failed: ${error.message}`);
    if (!data) return null;

    // Backlog M3 — decrypt with the key that actually encrypted this row,
    // not whichever key happens to be "current" right now. Before this fix
    // a row left behind by an in-progress or historical rotation would fail
    // to decrypt (or worse, silently decrypt as garbage) as soon as the
    // current key diverged from the one that produced its ciphertext.
    return {
      accessToken: decryptCredential(data.access_token_encrypted, data.encryption_key_version),
      refreshToken: data.refresh_token_encrypted
        ? decryptCredential(data.refresh_token_encrypted, data.encryption_key_version)
        : null,
      expiresAt: data.expires_at,
    };
  }

  /**
   * In-place credential refresh for an existing connection — updates only
   * oauth_credentials, never touches oauth_connections. Distinct from
   * createOrReplaceConnection on purpose: that function always revokes the
   * prior connection row and inserts a brand-new one (a new id, a new
   * connected_at), which is correct for a user re-authorizing but wrong for
   * a silent background token refresh — using createOrReplaceConnection for
   * every refresh would churn the connection's identity/history on every
   * expiring-token API call. This function is the refresh-only counterpart:
   * same connection id, same connected_at, only the credential row (and its
   * updated_at) changes.
   *
   * Server-only, same plaintext-never-touches-the-database guarantee as
   * createOrReplaceConnection — encryption happens before any DB call.
   */
  async function updateCredentialForConnection(connectionId, { accessToken, refreshToken = null, expiresAt = null } = {}) {
    if (!connectionId) throw new Error('updateCredentialForConnection requires connectionId');
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new Error('updateCredentialForConnection requires a non-empty accessToken');
    }

    const accessTokenEncrypted = encryptCredential(accessToken);
    const refreshTokenEncrypted = refreshToken ? encryptCredential(refreshToken) : null;

    const { error } = await client
      .from('oauth_credentials')
      .update({
        access_token_encrypted: accessTokenEncrypted,
        refresh_token_encrypted: refreshTokenEncrypted,
        expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
        encryption_key_version: getCurrentKeyVersion(),
        updated_at: new Date().toISOString(),
      })
      .eq('connection_id', connectionId);

    if (error) throw new Error(`updateCredentialForConnection failed: ${error.message}`);
  }

  /**
   * Soft-revokes the active connection and deletes its credential row
   * immediately (ciphertext is not retained past revocation), matching the
   * disconnect behavior documented in the architecture report.
   */
  async function markConnectionRevoked(clientId, provider) {
    if (!clientId) throw new Error('markConnectionRevoked requires clientId');
    if (!provider) throw new Error('markConnectionRevoked requires provider');

    const nowIso = new Date().toISOString();
    const { data, error } = await client
      .from('oauth_connections')
      .update({ status: STATUS.REVOKED, revoked_at: nowIso, updated_at: nowIso })
      .eq('client_id', clientId)
      .eq('provider', provider)
      .eq('status', STATUS.ACTIVE)
      .select('id')
      .maybeSingle();

    if (error) throw new Error(`markConnectionRevoked failed: ${error.message}`);
    if (!data) return { revoked: false };

    const { error: credError } = await client
      .from('oauth_credentials')
      .delete()
      .eq('connection_id', data.id);

    if (credError) throw new Error(`markConnectionRevoked (credential cleanup) failed: ${credError.message}`);
    return { revoked: true };
  }

  /**
   * Backlog M3 — lists connection_ids whose stored encryption_key_version
   * doesn't match the currently configured key, i.e. rows a rotation still
   * needs to re-encrypt. Read-only; does not touch any credential.
   */
  async function listConnectionIdsNeedingKeyRotation() {
    const currentVersion = getCurrentKeyVersion();
    const { data, error } = await client
      .from('oauth_credentials')
      .select('connection_id, encryption_key_version')
      .neq('encryption_key_version', currentVersion);

    if (error) throw new Error(`listConnectionIdsNeedingKeyRotation failed: ${error.message}`);
    return (data || []).map((row) => ({ connectionId: row.connection_id, encryptionKeyVersion: row.encryption_key_version }));
  }

  /**
   * Backlog M3 — decrypts a single credential row with the OLD key version
   * that actually encrypted it, then re-encrypts and rewrites it under the
   * current key/version. This is the actual "rotate" step: an operator sets
   * a new INTEGRATION_CREDENTIAL_ENCRYPTION_KEY + bumps
   * INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_VERSION, keeps the old key
   * available as INTEGRATION_CREDENTIAL_ENCRYPTION_KEY_V{oldVersion}, then
   * calls this for every id from listConnectionIdsNeedingKeyRotation()
   * until none remain — at which point the old key variable can be removed.
   * A no-op (returns { rotated: false }) if the row is already current or
   * gone, so it's safe to re-run/retry against the same connectionId.
   */
  async function reencryptCredentialForConnection(connectionId) {
    if (!connectionId) throw new Error('reencryptCredentialForConnection requires connectionId');

    const { data, error } = await client
      .from('oauth_credentials')
      .select('access_token_encrypted, refresh_token_encrypted, expires_at, encryption_key_version')
      .eq('connection_id', connectionId)
      .maybeSingle();

    if (error) throw new Error(`reencryptCredentialForConnection (read) failed: ${error.message}`);
    if (!data) return { rotated: false };

    const currentVersion = getCurrentKeyVersion();
    if (data.encryption_key_version === currentVersion) return { rotated: false };

    const accessToken = decryptCredential(data.access_token_encrypted, data.encryption_key_version);
    const refreshToken = data.refresh_token_encrypted
      ? decryptCredential(data.refresh_token_encrypted, data.encryption_key_version)
      : null;

    // Reuses updateCredentialForConnection so the write path (re-encrypt,
    // stamp the current version, bump updated_at) stays a single
    // implementation shared with a normal background token refresh.
    await updateCredentialForConnection(connectionId, {
      accessToken,
      refreshToken,
      expiresAt: data.expires_at,
    });

    return { rotated: true, fromVersion: data.encryption_key_version, toVersion: currentVersion };
  }

  /** Hard-deletes the connection row; oauth_credentials cascades via FK. */
  async function deleteConnection(clientId, provider) {
    if (!clientId) throw new Error('deleteConnection requires clientId');
    if (!provider) throw new Error('deleteConnection requires provider');

    const { error } = await client
      .from('oauth_connections')
      .delete()
      .eq('client_id', clientId)
      .eq('provider', provider);

    if (error) throw new Error(`deleteConnection failed: ${error.message}`);
  }

  return {
    createOrReplaceConnection,
    getActiveConnectionForClient,
    getActiveConnectionByExternalAccount,
    getConnectionById,
    getSafeConnectionStatus,
    getDecryptedCredentialForConnection,
    updateCredentialForConnection,
    markConnectionRevoked,
    deleteConnection,
    listConnectionIdsNeedingKeyRotation,
    reencryptCredentialForConnection,
  };
}

const defaultClient = createClient(supabaseConfig.url, supabaseConfig.serviceKey);
const defaultService = createOauthConnectionsService(defaultClient);

module.exports = {
  ...defaultService,
  createOauthConnectionsService,
  toSafeConnectionStatus,
  SUPPORTED_PROVIDERS,
  STATUS,
};
