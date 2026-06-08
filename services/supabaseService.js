const { createClient } = require('@supabase/supabase-js');
const { supabase: supabaseConfig } = require('../config');

const supabase = createClient(supabaseConfig.url, supabaseConfig.serviceKey);

async function upsertToken(clientId, provider, accessToken, refreshToken, expiresAt, scope = null) {
  const record = {
    client_id: clientId,
    provider,
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt ? expiresAt.toISOString() : null,
    updated_at: new Date().toISOString(),
  };
  if (scope !== null) record.scope = scope;

  const { error } = await supabase
    .from('oauth_tokens')
    .upsert(record, { onConflict: 'client_id,provider' });

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
  const providers = ['dropbox', 'slack', 'google_drive'];
  const results = await Promise.all(providers.map(p => getToken(clientId, p)));
  const status = {};
  providers.forEach((p, i) => { status[p] = results[i] !== null; });
  return status;
}

async function updateClientSlackChannel(clientId, channelId) {
  const { error } = await supabase
    .from('clients')
    .update({ slack_channel_id: channelId })
    .eq('id', clientId);

  if (error) throw new Error(`Supabase updateClientSlackChannel failed: ${error.message}`);
}

async function createClientRecord(name, email) {
  const { data, error } = await supabase
    .from('clients')
    .insert({ name, email, is_active: true })
    .select('id')
    .single();

  if (error) throw new Error(`createClientRecord failed: ${error.message}`);
  return data;
}

async function deleteClient(clientId) {
  const { error } = await supabase
    .from('clients')
    .delete()
    .eq('id', clientId);

  if (error) throw new Error(`deleteClient failed: ${error.message}`);
}

async function deleteClientFull(clientId) {
  // Get auth user id before deleting client_users
  const { data: clientUser } = await supabase
    .from('client_users')
    .select('auth_user_id')
    .eq('client_id', clientId)
    .single();

  // Delete related records
  await supabase.from('oauth_tokens').delete().eq('client_id', clientId);
  await supabase.from('client_users').delete().eq('client_id', clientId);
  await supabase.from('clients').delete().eq('id', clientId);

  // Delete the Supabase auth user if one exists
  if (clientUser?.auth_user_id) {
    await supabase.auth.admin.deleteUser(clientUser.auth_user_id);
  }
}

async function getAllClientsWithStatus() {
  const { data: clients, error } = await supabase
    .from('clients')
    .select('id, name, email, is_active, created_at')
    .order('created_at', { ascending: false });

  if (error) throw new Error(`getAllClientsWithStatus failed: ${error.message}`);
  if (!clients || clients.length === 0) return [];

  const clientIds = clients.map(c => c.id);

  const [{ data: clientUsers }, { data: tokens }] = await Promise.all([
    supabase.from('client_users').select('client_id').in('client_id', clientIds),
    supabase.from('oauth_tokens').select('client_id, provider').in('client_id', clientIds),
  ]);

  const acceptedSet = new Set((clientUsers || []).map(cu => cu.client_id));
  const tokenMap = {};
  (tokens || []).forEach(t => {
    if (!tokenMap[t.client_id]) tokenMap[t.client_id] = {};
    tokenMap[t.client_id][t.provider] = true;
  });

  return clients.map(client => ({
    id: client.id,
    name: client.name,
    email: client.email,
    is_active: client.is_active,
    created_at: client.created_at,
    invite_accepted: acceptedSet.has(client.id),
    dropbox: !!(tokenMap[client.id] && tokenMap[client.id]['dropbox']),
    slack: !!(tokenMap[client.id] && tokenMap[client.id]['slack']),
    google_drive: !!(tokenMap[client.id] && tokenMap[client.id]['google_drive']),
  }));
}

async function createClientUser(authUserId, clientId, email) {
  const { error } = await supabase
    .from('client_users')
    .upsert({ auth_user_id: authUserId, client_id: clientId, email }, { onConflict: 'auth_user_id' });

  if (error) throw new Error(`Supabase createClientUser failed: ${error.message}`);
}

module.exports = {
  upsertToken,
  getToken,
  getClientById,
  getClientByAuthUserId,
  getClientConnectionStatus,
  updateClientSlackChannel,
  createClientUser,
  createClientRecord,
  deleteClient,
  deleteClientFull,
  getAllClientsWithStatus,
};
