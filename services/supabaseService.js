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
  // Get email and auth user id before deleting
  const [{ data: clientRecord }, { data: clientUser }] = await Promise.all([
    supabase.from('clients').select('email').eq('id', clientId).single(),
    supabase.from('client_users').select('auth_user_id').eq('client_id', clientId).single(),
  ]);

  // Delete related records
  await supabase.from('oauth_tokens').delete().eq('client_id', clientId);
  await supabase.from('client_users').delete().eq('client_id', clientId);
  await supabase.from('clients').delete().eq('id', clientId);

  // Delete the Supabase auth user — use client_users link if present (accepted invite),
  // otherwise find by email (pending invite that was never accepted)
  let authUserId = clientUser?.auth_user_id;
  if (!authUserId && clientRecord?.email) {
    const { data: { users } } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    authUserId = users.find(u => u.email === clientRecord.email)?.id;
  }
  if (authUserId) {
    await supabase.auth.admin.deleteUser(authUserId);
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

async function createLead({ name, email, phone, company, message, source }) {
  const { data, error } = await supabase
    .from('leads')
    .insert({
      name,
      email,
      phone: phone || null,
      company: company || null,
      message,
      source: source || 'website',
    })
    .select('id, created_at')
    .single();

  if (error) throw new Error(`createLead failed: ${error.message}`);
  return data;
}

async function getAllLeads() {
  const { data, error } = await supabase
    .from('leads')
    .select('id, name, email, phone, company, message, notes, source, status, archived, created_at')
    .eq('archived', false)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`getAllLeads failed: ${error.message}`);
  return data || [];
}

async function updateLeadStatus(leadId, status) {
  const { error } = await supabase
    .from('leads')
    .update({ status })
    .eq('id', leadId);

  if (error) throw new Error(`updateLeadStatus failed: ${error.message}`);
}

async function updateLeadNotes(leadId, notes) {
  const { error } = await supabase
    .from('leads')
    .update({ notes })
    .eq('id', leadId);

  if (error) throw new Error(`updateLeadNotes failed: ${error.message}`);
}

async function archiveLead(leadId) {
  const { error } = await supabase
    .from('leads')
    .update({ archived: true })
    .eq('id', leadId);

  if (error) throw new Error(`archiveLead failed: ${error.message}`);
}

async function deleteLead(leadId) {
  const { error } = await supabase
    .from('leads')
    .delete()
    .eq('id', leadId);

  if (error) throw new Error(`deleteLead failed: ${error.message}`);
}

async function createPortalIssue({ clientId, submittedBy, submittedEmail, subject, issueType, message }) {
  const { data, error } = await supabase
    .from('client_portal_issues')
    .insert({
      client_id: clientId,
      submitted_by: submittedBy || null,
      submitted_email: submittedEmail || null,
      subject,
      issue_type: issueType,
      message,
    })
    .select('id, created_at')
    .single();

  if (error) throw new Error(`createPortalIssue failed: ${error.message}`);
  return data;
}

async function getAllPortalIssues() {
  const { data: issues, error } = await supabase
    .from('client_portal_issues')
    .select('id, subject, issue_type, status, priority, message, admin_notes, created_at, updated_at, client_id')
    .order('created_at', { ascending: false });

  if (error) throw new Error(`getAllPortalIssues failed: ${error.message}`);
  if (!issues || issues.length === 0) return [];

  const clientIds = [...new Set(issues.map(i => i.client_id))];
  const { data: clients } = await supabase
    .from('clients')
    .select('id, name')
    .in('id', clientIds);

  const clientMap = Object.fromEntries((clients || []).map(c => [c.id, c.name]));
  return issues.map(i => ({ ...i, client_name: clientMap[i.client_id] || i.client_id }));
}

async function updatePortalIssueStatus(issueId, status) {
  const { error } = await supabase
    .from('client_portal_issues')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', issueId);

  if (error) throw new Error(`updatePortalIssueStatus failed: ${error.message}`);
}

async function createClientUser(authUserId, clientId, email) {
  const { error } = await supabase
    .from('client_users')
    .upsert({ auth_user_id: authUserId, client_id: clientId, email }, { onConflict: 'auth_user_id' });

  if (error) throw new Error(`Supabase createClientUser failed: ${error.message}`);
}

async function getClientIssueCount(clientId) {
  const { count, error } = await supabase
    .from('client_portal_issues')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId);

  if (error) throw new Error(`getClientIssueCount failed: ${error.message}`);
  return count || 0;
}

async function getPortalIssueSummary() {
  const { data, error } = await supabase
    .from('client_portal_issues')
    .select('status');

  if (error) throw new Error(`getPortalIssueSummary failed: ${error.message}`);
  const all = data || [];
  return {
    total: all.length,
    open: all.filter(i => i.status === 'open').length,
  };
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
  createLead,
  getAllLeads,
  updateLeadStatus,
  updateLeadNotes,
  archiveLead,
  deleteLead,
  createPortalIssue,
  getAllPortalIssues,
  updatePortalIssueStatus,
  getClientIssueCount,
  getPortalIssueSummary,
};
