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

// @deprecated — no longer called at runtime; use client_members for identity resolution
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
  // Get email and owner auth_user_id before deleting
  const [{ data: clientRecord }, { data: ownerMember }] = await Promise.all([
    supabase.from('clients').select('email').eq('id', clientId).single(),
    supabase.from('client_members').select('auth_user_id').eq('client_id', clientId).eq('role', 'owner').limit(1).single(),
  ]);

  // Delete related records
  await supabase.from('oauth_tokens').delete().eq('client_id', clientId);
  await supabase.from('client_users').delete().eq('client_id', clientId);
  await supabase.from('clients').delete().eq('id', clientId);

  // Delete the Supabase auth user — use owner member link if present (accepted invite),
  // otherwise find by email (pending invite that was never accepted)
  let authUserId = ownerMember?.auth_user_id;
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

  const [{ data: activeMembers }, { data: tokens }] = await Promise.all([
    supabase.from('client_members').select('client_id').not('auth_user_id', 'is', null).in('client_id', clientIds),
    supabase.from('oauth_tokens').select('client_id, provider').in('client_id', clientIds),
  ]);

  const acceptedSet = new Set((activeMembers || []).map(m => m.client_id));
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

// @deprecated — no longer called at runtime; identity is established via client_members
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

// ─────────────────────────────────────────────
// Team members
// ─────────────────────────────────────────────

async function getClientMemberByAuthUserId(authUserId, clientId) {
  const { data, error } = await supabase
    .from('client_members')
    .select('id, role, status, full_name, email')
    .eq('auth_user_id', authUserId)
    .eq('client_id', clientId)
    .single();

  if (error && error.code === 'PGRST116') return null;
  if (error) throw new Error(`getClientMemberByAuthUserId failed: ${error.message}`);
  return data;
}

async function createClientMember({ clientId, email, fullName, role, status, invitedBy, invitedAt }) {
  const { data, error } = await supabase
    .from('client_members')
    .insert({
      client_id: clientId,
      email,
      full_name: fullName || null,
      role,
      status,
      invited_by: invitedBy || null,
      invited_at: invitedAt || null,
    })
    .select()
    .single();

  if (error) throw new Error(`createClientMember failed: ${error.message}`);
  return data;
}

async function getClientMembers(clientId) {
  const { data, error } = await supabase
    .from('client_members')
    .select('id, email, full_name, role, status, invited_at, accepted_at, last_active_at, created_at')
    .eq('client_id', clientId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`getClientMembers failed: ${error.message}`);
  return data || [];
}

async function updateClientMember(memberId, clientId, updates) {
  const allowed = {};
  if (updates.role !== undefined) allowed.role = updates.role;
  if (updates.status !== undefined) allowed.status = updates.status;
  if (updates.full_name !== undefined) allowed.full_name = updates.full_name;
  if (updates.last_active_at !== undefined) allowed.last_active_at = updates.last_active_at;
  allowed.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('client_members')
    .update(allowed)
    .eq('id', memberId)
    .eq('client_id', clientId)
    .select()
    .single();

  if (error) throw new Error(`updateClientMember failed: ${error.message}`);
  return data;
}

async function getActiveMemberCount(clientId) {
  const { count, error } = await supabase
    .from('client_members')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .not('status', 'in', '("disabled","revoked")');

  if (error) throw new Error(`getActiveMemberCount failed: ${error.message}`);
  return count || 0;
}

// ─────────────────────────────────────────────
// Team invites
// ─────────────────────────────────────────────

async function createTeamInvite({ clientId, email, role, token, expiresAt, invitedBy }) {
  const { data, error } = await supabase
    .from('team_invites')
    .insert({
      client_id: clientId,
      email,
      role,
      token,
      expires_at: expiresAt,
      invited_by: invitedBy || null,
    })
    .select()
    .single();

  if (error) throw new Error(`createTeamInvite failed: ${error.message}`);
  return data;
}

async function getTeamInviteByToken(token) {
  const { data, error } = await supabase
    .from('team_invites')
    .select('*, clients(name)')
    .eq('token', token)
    .single();

  if (error && error.code === 'PGRST116') return null;
  if (error) throw new Error(`getTeamInviteByToken failed: ${error.message}`);
  return data;
}

async function getPendingInviteByMemberId(memberId, clientId) {
  const { data: member } = await supabase
    .from('client_members')
    .select('email')
    .eq('id', memberId)
    .eq('client_id', clientId)
    .single();

  if (!member) return null;

  const { data, error } = await supabase
    .from('team_invites')
    .select('*')
    .eq('client_id', clientId)
    .eq('email', member.email)
    .is('accepted_at', null)
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error && error.code === 'PGRST116') return null;
  if (error) throw new Error(`getPendingInviteByMemberId failed: ${error.message}`);
  return data;
}

async function acceptTeamInvite(token, authUserId) {
  const now = new Date().toISOString();

  const { data: invite, error: inviteError } = await supabase
    .from('team_invites')
    .update({ accepted_at: now })
    .eq('token', token)
    .select('client_id, email, role')
    .single();

  if (inviteError) throw new Error(`acceptTeamInvite (invite update) failed: ${inviteError.message}`);

  const { error: memberError } = await supabase
    .from('client_members')
    .update({ auth_user_id: authUserId, status: 'active', accepted_at: now, updated_at: now })
    .eq('client_id', invite.client_id)
    .eq('email', invite.email);

  if (memberError) throw new Error(`acceptTeamInvite (member update) failed: ${memberError.message}`);

  return invite;
}

async function revokeTeamInvite(memberId, clientId) {
  const { data: member, error: memberErr } = await supabase
    .from('client_members')
    .update({ status: 'revoked', updated_at: new Date().toISOString() })
    .eq('id', memberId)
    .eq('client_id', clientId)
    .select('email')
    .single();

  if (memberErr) throw new Error(`revokeTeamInvite (member) failed: ${memberErr.message}`);

  await supabase
    .from('team_invites')
    .update({ revoked_at: new Date().toISOString() })
    .eq('client_id', clientId)
    .eq('email', member.email)
    .is('accepted_at', null)
    .is('revoked_at', null);
}

async function regenerateTeamInvite(memberId, clientId, newToken, newExpiresAt) {
  const { data: member } = await supabase
    .from('client_members')
    .select('email')
    .eq('id', memberId)
    .eq('client_id', clientId)
    .single();

  if (!member) throw new Error('Member not found');

  // Expire any existing pending invites for this email
  await supabase
    .from('team_invites')
    .update({ revoked_at: new Date().toISOString() })
    .eq('client_id', clientId)
    .eq('email', member.email)
    .is('accepted_at', null)
    .is('revoked_at', null);

  // Insert fresh invite
  const { data, error } = await supabase
    .from('team_invites')
    .insert({
      client_id: clientId,
      email: member.email,
      role: 'member',
      token: newToken,
      expires_at: newExpiresAt,
    })
    .select()
    .single();

  if (error) throw new Error(`regenerateTeamInvite failed: ${error.message}`);
  return data;
}

// ─────────────────────────────────────────────
// Chat session membership mapping
// ─────────────────────────────────────────────

async function createMemberSession(clientId, memberId, aikbSessionId) {
  const { error } = await supabase
    .from('client_member_sessions')
    .upsert(
      { client_id: clientId, member_id: memberId, aikb_session_id: aikbSessionId },
      { onConflict: 'client_id,aikb_session_id' }
    );

  if (error) throw new Error(`createMemberSession failed: ${error.message}`);
}

async function getMemberSessionIds(clientId, memberId) {
  const { data, error } = await supabase
    .from('client_member_sessions')
    .select('aikb_session_id')
    .eq('client_id', clientId)
    .eq('member_id', memberId);

  if (error) throw new Error(`getMemberSessionIds failed: ${error.message}`);
  return (data || []).map(r => r.aikb_session_id);
}

async function deleteMemberSession(clientId, memberId, aikbSessionId) {
  const { error } = await supabase
    .from('client_member_sessions')
    .delete()
    .eq('client_id', clientId)
    .eq('member_id', memberId)
    .eq('aikb_session_id', aikbSessionId);

  if (error) throw new Error(`deleteMemberSession failed: ${error.message}`);
}

async function deleteMemberAllSessions(clientId, memberId) {
  const { error } = await supabase
    .from('client_member_sessions')
    .delete()
    .eq('client_id', clientId)
    .eq('member_id', memberId);

  if (error) throw new Error(`deleteMemberAllSessions failed: ${error.message}`);
}

// ─────────────────────────────────────────────
// Upsert owner member for original admin-invited client
// ─────────────────────────────────────────────

async function upsertOwnerMember(clientId, authUserId, email) {
  const { error } = await supabase
    .from('client_members')
    .upsert(
      {
        client_id: clientId,
        auth_user_id: authUserId,
        email,
        role: 'owner',
        status: 'active',
        accepted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'client_id,auth_user_id' }
    );

  if (error) throw new Error(`upsertOwnerMember failed: ${error.message}`);
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
  // Team members
  getClientMemberByAuthUserId,
  createClientMember,
  getClientMembers,
  updateClientMember,
  getActiveMemberCount,
  // Team invites
  createTeamInvite,
  getTeamInviteByToken,
  getPendingInviteByMemberId,
  acceptTeamInvite,
  revokeTeamInvite,
  regenerateTeamInvite,
  // Chat session mapping
  createMemberSession,
  getMemberSessionIds,
  deleteMemberSession,
  deleteMemberAllSessions,
  // Owner member upsert
  upsertOwnerMember,
};
