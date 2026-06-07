const { createClient } = require('@supabase/supabase-js');
const { supabase: supabaseConfig } = require('../config');

const supabase = createClient(supabaseConfig.url, supabaseConfig.serviceKey);

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

async function getToken(clientId, provider) {
  const { data, error } = await supabase
    .from('oauth_tokens')
    .select('*')
    .eq('client_id', clientId)
    .eq('provider', provider)
    .single();

  if (error && error.code === 'PGRST116') return null;
  if (error) throw new Error(`Supabase getToken failed: ${error.message}`);
  return data;
}

async function getClientById(clientId) {
  const { data, error } = await supabase
    .from('clients')
    .select('id, name, email, slack_channel_id, dropbox_watch_path, is_active')
    .eq('id', clientId)
    .single();

  if (error) throw new Error(`Supabase getClientById failed: ${error.message}`);
  return data;
}

async function getClientByAuthUserId(authUserId) {
  const { data: clientUser, error: cuError } = await supabase
    .from('client_users')
    .select('client_id')
    .eq('auth_user_id', authUserId)
    .single();

  if (cuError) throw new Error(`Supabase getClientByAuthUserId failed: ${cuError.message}`);
  return getClientById(clientUser.client_id);
}

async function getClientConnectionStatus(clientId) {
  const providers = ['dropbox'];
  const results = await Promise.all(providers.map(p => getToken(clientId, p)));
  const status = {};
  providers.forEach((p, i) => { status[p] = results[i] !== null; });
  return status;
}

module.exports = {
  upsertToken,
  getToken,
  getClientById,
  getClientByAuthUserId,
  getClientConnectionStatus,
};
