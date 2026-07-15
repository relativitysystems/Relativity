'use strict';

// Secure, server-side OAuth state storage (Architecture Review Phase 4,
// Milestone 3). Provider-neutral — starts with Slack, reusable by any
// future provider on oauth_connections. See
// supabase/migrations/20260715_oauth_states.sql for the full design
// rationale (hash-only storage, atomic single-use consumption, TTL).
//
// Exported as a ready-to-use singleton, plus a createOauthStateService(client)
// factory so tests can inject a fake Supabase client instead of making real
// network calls — mirrors services/oauthConnectionsService.js's convention.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { supabase: supabaseConfig } = require('../config');
const { SUPPORTED_PROVIDERS } = require('./oauthConnectionsService');

const STATE_BYTES = 32; // >= the 32-random-bytes minimum required for a secure state token
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** SHA-256 hex digest — the only form of the state value ever persisted. */
function hashState(rawState) {
  return crypto.createHash('sha256').update(rawState, 'utf8').digest('hex');
}

/** 32 random bytes, hex-encoded (64 characters) — sent to the provider, never stored. */
function generateRawState() {
  return crypto.randomBytes(STATE_BYTES).toString('hex');
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 */
function createOauthStateService(client) {
  /**
   * Persists only the hash of a freshly generated state value, bound to the
   * organization/member resolved server-side by the caller (never from the
   * browser). Returns the raw value — the only copy that will ever exist —
   * for the caller to hand to the provider's authorization URL.
   */
  async function generateAndStoreState({ clientId, memberId, provider, redirectAfter = null, ttlMs = DEFAULT_TTL_MS }) {
    if (!clientId) throw new Error('generateAndStoreState requires clientId');
    if (!memberId) throw new Error('generateAndStoreState requires memberId');
    if (!provider) throw new Error('generateAndStoreState requires provider');
    if (!SUPPORTED_PROVIDERS.includes(provider)) {
      throw new Error(`generateAndStoreState: unsupported provider "${provider}" — must be one of ${SUPPORTED_PROVIDERS.join(', ')}`);
    }

    const rawState = generateRawState();
    const stateHash = hashState(rawState);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    const { error } = await client.from('oauth_states').insert({
      state_hash: stateHash,
      client_id: clientId,
      member_id: memberId,
      provider,
      redirect_after: redirectAfter,
      expires_at: expiresAt,
    });

    if (error) throw new Error(`generateAndStoreState failed: ${error.message}`);

    return { rawState, expiresAt };
  }

  /**
   * Atomically consumes a state value (single conditional UPDATE — see the
   * migration comment for why this is race-safe without an RPC). Returns a
   * discriminated result rather than throwing for expected rejection cases,
   * so callers can map each to a distinct, safe user-facing redirect:
   *   { status: 'consumed', clientId, memberId, redirectAfter }
   *   { status: 'expired' | 'reused' | 'provider_mismatch' | 'not_found' }
   *
   * The classification lookup performed when the atomic update matches
   * nothing is strictly read-only and never grants anything the update
   * itself did not — it exists purely to pick the right safe error reason.
   */
  async function consumeState({ rawState, provider }) {
    if (!provider) throw new Error('consumeState requires provider');
    if (!rawState || typeof rawState !== 'string') return { status: 'not_found' };

    const stateHash = hashState(rawState);
    const nowIso = new Date().toISOString();

    const { data, error } = await client
      .from('oauth_states')
      .update({ consumed_at: nowIso })
      .eq('state_hash', stateHash)
      .eq('provider', provider)
      .is('consumed_at', null)
      .gt('expires_at', nowIso)
      .select('*')
      .maybeSingle();

    if (error) throw new Error(`consumeState failed: ${error.message}`);

    if (data) {
      return {
        status: 'consumed',
        clientId: data.client_id,
        memberId: data.member_id,
        redirectAfter: data.redirect_after || null,
      };
    }

    const { data: existing, error: lookupError } = await client
      .from('oauth_states')
      .select('provider, consumed_at, expires_at')
      .eq('state_hash', stateHash)
      .maybeSingle();

    if (lookupError || !existing) return { status: 'not_found' };
    if (existing.provider !== provider) return { status: 'provider_mismatch' };
    if (existing.consumed_at) return { status: 'reused' };
    if (new Date(existing.expires_at) <= new Date()) return { status: 'expired' };
    // Matched nothing above but also isn't consumed/expired/mismatched —
    // only reachable under a concurrent race with another consume call that
    // has not yet committed; treat conservatively as not usable.
    return { status: 'not_found' };
  }

  return { generateAndStoreState, consumeState };
}

const defaultClient = createClient(supabaseConfig.url, supabaseConfig.serviceKey);
const defaultService = createOauthStateService(defaultClient);

module.exports = {
  ...defaultService,
  createOauthStateService,
  hashState,
  generateRawState,
  STATE_BYTES,
  DEFAULT_TTL_MS,
};
