const { createClient } = require('@supabase/supabase-js');
const { supabase: supabaseConfig } = require('../config');

// Service-role client bypasses Row Level Security — keep this server-side only.
// Never expose SUPABASE_SERVICE_KEY to the frontend.
const supabase = createClient(supabaseConfig.url, supabaseConfig.key);

/**
 * Save or update a client's OAuth token for a given provider.
 * Uses upsert so re-connecting Dropbox overwrites the old tokens cleanly.
 *
 * @param {string} clientId   - UUID from the clients table
 * @param {string} provider   - 'dropbox' | 'google_drive' | 'slack'
 * @param {string} accessToken
 * @param {string|null} refreshToken
 * @param {Date|null} expiresAt - JS Date object or null
 */
async function upsertToken(clientId, provider, accessToken, refreshToken, expiresAt) {
  const { error } = await supabase
    .from('oauth_tokens')
    .upsert(
      {
        client_id: clientId,
        provider,
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt ? expiresAt.toISOString() : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'client_id,provider' }
    );

  if (error) throw new Error(`Supabase upsertToken failed: ${error.message}`);
}

/**
 * Retrieve stored tokens for a client + provider combination.
 * Returns null if no token row exists (client hasn't connected yet).
 *
 * @param {string} clientId
 * @param {string} provider
 * @returns {object|null}
 */
async function getToken(clientId, provider) {
  const { data, error } = await supabase
    .from('oauth_tokens')
    .select('*')
    .eq('client_id', clientId)
    .eq('provider', provider)
    .single();

  if (error && error.code === 'PGRST116') return null; // no row found
  if (error) throw new Error(`Supabase getToken failed: ${error.message}`);
  return data;
}

module.exports = { upsertToken, getToken };
