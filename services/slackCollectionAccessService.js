'use strict';

// Which AIKB knowledge_collections a client has allowed Slack to search
// (Milestone 5: Slack Knowledge Collections). Organization-wide
// (client_id-scoped) only — no per-user/per-group scoping in this
// milestone, per its explicit non-goals.
//
// collection_id values here are AIKB knowledge_collections.id — plain UUIDs
// with no foreign key, since AIKB lives in a separate Supabase project (see
// supabase/migrations/20260717_slack_collection_access.sql).
//
// Exported as a ready-to-use singleton (matching this repo's existing
// service-module convention, e.g. oauthConnectionsService.js), plus a
// createSlackCollectionAccessService(client) factory so tests/callers can
// inject a fake Supabase client instead of making real network calls.

const { createClient } = require('@supabase/supabase-js');
const { supabase: supabaseConfig } = require('../config');

function createSlackCollectionAccessService(client) {
  async function getAllowedCollectionIds(clientId) {
    if (!clientId) throw new Error('getAllowedCollectionIds requires clientId');

    const { data, error } = await client
      .from('slack_collection_access')
      .select('collection_id')
      .eq('client_id', clientId);
    if (error) throw new Error(`getAllowedCollectionIds failed: ${error.message}`);

    return (data || []).map((row) => row.collection_id);
  }

  // Replaces the full allow-list for a client. Deliberately delete-then-
  // insert, in that order: if the insert half fails after the delete
  // succeeds, the client is left with an EMPTY allow-list (deny-all on the
  // next Slack question) rather than a stale, possibly over-permissive one
  // — a fail-closed partial-failure mode. Self-heals on the next successful
  // save.
  async function setAllowedCollectionIds(clientId, collectionIds) {
    if (!clientId) throw new Error('setAllowedCollectionIds requires clientId');
    if (!Array.isArray(collectionIds)) throw new Error('setAllowedCollectionIds requires an array of collectionIds');

    const { error: deleteError } = await client
      .from('slack_collection_access')
      .delete()
      .eq('client_id', clientId);
    if (deleteError) throw new Error(`setAllowedCollectionIds (delete) failed: ${deleteError.message}`);

    const deduped = [...new Set(collectionIds.filter((id) => typeof id === 'string' && id))];
    if (deduped.length === 0) return [];

    const rows = deduped.map((collectionId) => ({ client_id: clientId, collection_id: collectionId }));
    const { error: insertError } = await client
      .from('slack_collection_access')
      .insert(rows);
    if (insertError) throw new Error(`setAllowedCollectionIds (insert) failed: ${insertError.message}`);

    return deduped;
  }

  return {
    getAllowedCollectionIds,
    setAllowedCollectionIds,
  };
}

const defaultClient = createClient(supabaseConfig.url, supabaseConfig.serviceKey);
const defaultService = createSlackCollectionAccessService(defaultClient);

module.exports = {
  ...defaultService,
  createSlackCollectionAccessService,
};
