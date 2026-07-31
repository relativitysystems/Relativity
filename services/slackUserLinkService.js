'use strict';

// EL7A — Slack identity linking (Architecture/architecture/
// LIVE_EMAIL_LOOKUP.md §3.1). A much smaller, purpose-built identity link,
// scoped only to enabling live mailbox lookup from Slack — NOT the
// deferred, full Milestone 7 (general per-employee authorization). This
// module only builds the mapping; no live-lookup behavior consumes it yet
// (that's EL7B).
//
// Code generation happens in the authenticated portal
// (POST /api/integrations/slack/link/generate-code); the raw code is then
// typed into a Slack DM to the bot, which calls completeLink. This
// direction (portal, already-authenticated -> Slack, unauthenticated by
// this platform) is the only direction identity verification is allowed
// to flow — automatic matching on a Slack profile's self-reported email is
// explicitly rejected (§3.1).
//
// Mirrors services/oauthStateService.js's shape and testing approach
// almost exactly: hash-only storage, a single atomic conditional UPDATE
// for race-safe one-time consumption, a discriminated result instead of
// throwing for expected rejection cases. A dedicated table
// (slack_link_codes) rather than literally reusing oauth_states, since
// that table's schema (provider, redirect_after) is OAuth-redirect-flow-
// specific, not a generic code-payload table.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { supabase: supabaseConfig } = require('../config');

// Excludes visually ambiguous characters (0/O, 1/I/L) — this code is typed
// by hand into a Slack DM, unlike oauthStateService's browser-redirect
// state value.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes, matching oauthStateService's default

/** SHA-256 hex digest — the only form of the code ever persisted. */
function hashCode(rawCode) {
  return crypto.createHash('sha256').update(rawCode, 'utf8').digest('hex');
}

/**
 * 8 characters from CODE_ALPHABET (32 symbols), one crypto-random byte per
 * character. 256 / 32 = 8 exactly, so `byte % 32` is uniform — no modulo
 * bias to correct for.
 */
function generateRawCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

/** Uppercases and strips anything outside A-Z0-9 — tolerant of stray whitespace/punctuation a human might type around the code. */
function normalizeCode(input) {
  return typeof input === 'string' ? input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} client
 */
function createSlackUserLinkService(client) {
  /**
   * Portal-authenticated, own-member-only (the route always passes
   * req.member.id, never a caller-supplied memberId).
   */
  async function generateLinkCode({ clientId, memberId, ttlMs = DEFAULT_TTL_MS }) {
    if (!clientId) throw new Error('generateLinkCode requires clientId');
    if (!memberId) throw new Error('generateLinkCode requires memberId');

    const rawCode = generateRawCode();
    const codeHash = hashCode(rawCode);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    const { error } = await client.from('slack_link_codes').insert({
      code_hash: codeHash,
      client_id: clientId,
      member_id: memberId,
      expires_at: expiresAt,
    });
    if (error) throw new Error(`generateLinkCode failed: ${error.message}`);

    return { code: rawCode, expiresAt };
  }

  /**
   * Atomically consumes a code (single conditional UPDATE, race-safe — same
   * technique as oauthStateService#consumeState) then upserts the
   * slack_user_links row. `clientId` is the Slack workspace's OWN resolved
   * client (from slackEventsService's resolveWorkspace, never trusted from
   * anywhere else) — cross-checked against the code's own stored client_id
   * so a code generated for one client can never link a Slack identity
   * under a different client's workspace, even if somehow submitted there.
   * A code is burned by the consume step regardless of this cross-check's
   * outcome — no retry with the same code either way, correct fail-closed
   * behavior for a wrong-workspace submission.
   *
   * Re-linking a Slack user id replaces, never appends to, any prior link
   * for that id — the upsert's onConflict target is slack_user_links'
   * (client_id, slack_user_id) unique constraint.
   *
   * @returns {Promise<{status:'linked', clientId:string, memberId:string}|{status:'not_found'|'reused'|'expired'|'client_mismatch'}>}
   */
  async function completeLink({ rawCode, clientId, slackTeamId, slackUserId }) {
    if (!clientId) throw new Error('completeLink requires clientId');
    if (!slackTeamId) throw new Error('completeLink requires slackTeamId');
    if (!slackUserId) throw new Error('completeLink requires slackUserId');

    const normalized = normalizeCode(rawCode);
    if (!normalized) return { status: 'not_found' };
    const codeHash = hashCode(normalized);
    const nowIso = new Date().toISOString();

    const { data, error } = await client
      .from('slack_link_codes')
      .update({ consumed_at: nowIso })
      .eq('code_hash', codeHash)
      .is('consumed_at', null)
      .gt('expires_at', nowIso)
      .select('*')
      .maybeSingle();
    if (error) throw new Error(`completeLink (consume) failed: ${error.message}`);

    if (!data) {
      const { data: existing } = await client
        .from('slack_link_codes')
        .select('consumed_at, expires_at')
        .eq('code_hash', codeHash)
        .maybeSingle();
      if (!existing) return { status: 'not_found' };
      if (existing.consumed_at) return { status: 'reused' };
      if (new Date(existing.expires_at) <= new Date()) return { status: 'expired' };
      // Matched nothing above but also isn't consumed/expired — only
      // reachable under a concurrent race with another consume call that
      // hasn't yet committed; treat conservatively as not usable.
      return { status: 'not_found' };
    }

    if (data.client_id !== clientId) {
      return { status: 'client_mismatch' };
    }

    const { error: linkError } = await client
      .from('slack_user_links')
      .upsert(
        {
          client_id: data.client_id,
          slack_user_id: slackUserId,
          slack_team_id: slackTeamId,
          member_id: data.member_id,
          linked_at: nowIso,
        },
        { onConflict: 'client_id,slack_user_id' }
      );
    if (linkError) throw new Error(`completeLink (link upsert) failed: ${linkError.message}`);

    return { status: 'linked', clientId: data.client_id, memberId: data.member_id };
  }

  /**
   * EL7B's own resolver — identity plumbing belongs here, not duplicated
   * into slackEventsService.js. Every request re-resolves (no caching),
   * matching this platform's "server enforces regardless of what a stale
   * client-side assumption might be" convention.
   */
  async function getLinkedMember({ clientId, slackUserId }) {
    if (!clientId || !slackUserId) return null;
    const { data, error } = await client
      .from('slack_user_links')
      .select('member_id, linked_at')
      .eq('client_id', clientId)
      .eq('slack_user_id', slackUserId)
      .maybeSingle();
    if (error) throw new Error(`getLinkedMember failed: ${error.message}`);
    return data || null;
  }

  return { generateLinkCode, completeLink, getLinkedMember };
}

const defaultClient = createClient(supabaseConfig.url, supabaseConfig.serviceKey);
const defaultService = createSlackUserLinkService(defaultClient);

module.exports = {
  ...defaultService,
  createSlackUserLinkService,
  hashCode,
  generateRawCode,
  normalizeCode,
  CODE_ALPHABET,
  CODE_LENGTH,
  DEFAULT_TTL_MS,
};
