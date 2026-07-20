const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { supabase: supabaseConfig } = require('../config');
const aikbService = require('./aikbService');
const { sourceLabelFor } = require('./importMetadata');
const oauthConnectionsService = require('./oauthConnectionsService');

const supabase = createClient(supabaseConfig.url, supabaseConfig.serviceKey);

// @deprecated — stores tokens in PLAINTEXT. Replaced by
// services/oauthConnectionsService.js (backed by the encrypted
// oauth_connections/oauth_credentials tables) for every provider this repo
// writes: Slack (Milestone 3), then Google Drive and Dropbox (backlog H2).
// Do not call upsertToken/getToken for any of these providers in new code.
// Kept only because oauth_tokens itself is not dropped — the confirmed-empty
// legacy rows (see supabase/migrations/ for the H2 cleanup statement) mean
// nothing currently depends on it, but the table isn't torn down.
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

// @deprecated for new providers — see the note on upsertToken above.
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

// All three providers now read from oauth_connections/oauth_credentials via
// services/oauthConnectionsService.js#getSafeConnectionStatus — Slack since
// Milestone 3, Dropbox and Google Drive since backlog H2. Continuing to read
// oauth_tokens here would silently report every connection as never-made,
// since new connections for any of these three providers no longer write
// there — see the deprecation note on upsertToken/getToken above.
async function getClientConnectionStatus(clientId) {
  const providers = ['dropbox', 'google_drive', 'slack'];
  const results = await Promise.all(
    providers.map(p => oauthConnectionsService.getSafeConnectionStatus(clientId, p))
  );

  const status = {};
  providers.forEach((p, i) => { status[p] = results[i].connected; });
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

async function getClientMembersForDeletion(clientId) {
  const { data, error } = await supabase
    .from('client_members')
    .select('id, email, auth_user_id, role')
    .eq('client_id', clientId);
  if (error) throw new Error(`getClientMembersForDeletion failed: ${error.message}`);
  return data || [];
}

async function deleteClientFull(clientId) {
  console.log(`[deleteClientFull] START | clientId=${clientId}`);
  const errors = [];

  const { data: clientRecord } = await supabase
    .from('clients').select('email').eq('id', clientId).maybeSingle();

  const members = await getClientMembersForDeletion(clientId).catch((err) => {
    errors.push(`fetch members: ${err.message}`);
    return [];
  });

  let authUserIds = [...new Set(members.map(m => m.auth_user_id).filter(Boolean))];

  if (authUserIds.length === 0 && clientRecord?.email) {
    console.log('[deleteClientFull] No member auth_user_ids found, falling back to email lookup');
    try {
      const { data: { users }, error } = await supabase.auth.admin.listUsers({ perPage: 1000 });
      if (error) throw new Error(error.message);
      const fallback = users.find(u => u.email === clientRecord.email)?.id;
      if (fallback) authUserIds = [fallback];
    } catch (err) {
      errors.push(`auth email fallback: ${err.message}`);
    }
  }
  console.log(`[deleteClientFull] ${authUserIds.length} auth user(s) queued for deletion`);

  // AIKB cleanup — best-effort, must not block Global DB cleanup. Runs
  // before any Global DB rows are deleted so the AIKB call still has a
  // valid clientId to scope its own cleanup by (it doesn't depend on the
  // Global clients row existing, but this keeps ordering intuitive).
  try {
    const result = await aikbService.deleteClientData(clientId);
    if (result?.errors?.length) {
      console.warn(`[deleteClientFull] AIKB cleanup completed with ${result.errors.length} partial error(s) for clientId=${clientId}`);
    } else {
      console.log(`[deleteClientFull] AIKB cleanup succeeded for clientId=${clientId}`);
    }
  } catch (err) {
    console.error(`[deleteClientFull] AIKB cleanup failed for clientId=${clientId}: ${err.message}`);
    errors.push(`aikb: ${err.message}`);
  }

  // Related Global DB rows — each independently non-fatal. client_members,
  // team_invites, client_member_sessions would cascade from `clients`
  // anyway; folder_states/automation_logs aren't referenced elsewhere in
  // this repo and may not exist live, so failures there are expected, not
  // real errors — never leak token/secret column values in these logs.
  const relatedTables = ['oauth_tokens', 'client_portal_issues', 'client_member_sessions', 'team_invites', 'client_members', 'client_users'];
  const defensiveTables = ['folder_states', 'automation_logs'];
  for (const table of [...relatedTables, ...defensiveTables]) {
    const { error, count } = await supabase.from(table).delete({ count: 'exact' }).eq('client_id', clientId);
    if (error) {
      if (defensiveTables.includes(table)) {
        console.warn(`[deleteClientFull] ${table} delete skipped (expected if table absent): ${error.message}`);
      } else {
        console.error(`[deleteClientFull] ${table} delete failed for clientId=${clientId}: ${error.message}`);
        errors.push(`${table}: ${error.message}`);
      }
    } else {
      console.log(`[deleteClientFull] ${table} deleted count=${count ?? 'n/a'}`);
    }
  }

  // FATAL — the one step that must abort deletion. Every prior step is
  // best-effort; if the client row itself can't be removed, the client was
  // not actually deleted and the caller must see an error.
  const { error: clientDeleteError } = await supabase.from('clients').delete().eq('id', clientId);
  if (clientDeleteError) {
    throw new Error(`deleteClientFull: failed to delete clients row for clientId=${clientId}: ${clientDeleteError.message}`);
  }
  console.log(`[deleteClientFull] clients row deleted for clientId=${clientId}`);

  // Auth users last, after the clients row is confirmed gone. deleteUser()
  // resolves { error } rather than throwing — check it explicitly, log and
  // continue past individual failures so one bad ID doesn't abort the rest.
  for (const authUserId of authUserIds) {
    const { error } = await supabase.auth.admin.deleteUser(authUserId);
    if (error) {
      console.error(`[deleteClientFull] Failed to delete auth user ${authUserId} for clientId=${clientId}: ${error.message}`);
      errors.push(`auth user ${authUserId}: ${error.message}`);
    } else {
      console.log(`[deleteClientFull] Deleted auth user ${authUserId}`);
    }
  }

  if (errors.length) {
    console.warn(`[deleteClientFull] DONE with ${errors.length} non-fatal error(s) | clientId=${clientId}`);
  } else {
    console.log(`[deleteClientFull] DONE | clientId=${clientId}`);
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

  // All three providers now come from oauth_connections (Slack since
  // Milestone 3, Dropbox/Google Drive since backlog H2) instead of
  // oauth_tokens — see the note on getClientConnectionStatus above. Only
  // client_id/provider are read here (oauth_connections columns, never
  // oauth_credentials), so no credential material is touched.
  const [{ data: activeMembers }, { data: connections }] = await Promise.all([
    supabase.from('client_members').select('client_id').not('auth_user_id', 'is', null).in('client_id', clientIds),
    supabase.from('oauth_connections').select('client_id, provider').eq('status', 'active').in('client_id', clientIds),
  ]);

  const acceptedSet = new Set((activeMembers || []).map(m => m.client_id));
  const connectionMap = {};
  (connections || []).forEach(c => {
    if (!connectionMap[c.client_id]) connectionMap[c.client_id] = {};
    connectionMap[c.client_id][c.provider] = true;
  });

  return clients.map(client => ({
    id: client.id,
    name: client.name,
    email: client.email,
    is_active: client.is_active,
    created_at: client.created_at,
    invite_accepted: acceptedSet.has(client.id),
    dropbox: !!(connectionMap[client.id] && connectionMap[client.id]['dropbox']),
    slack: !!(connectionMap[client.id] && connectionMap[client.id]['slack']),
    google_drive: !!(connectionMap[client.id] && connectionMap[client.id]['google_drive']),
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

// Looks up a member by client_members.id (not auth_user_id), scoped to a
// specific client_id. Used by the Slack OAuth callback (routes/integrations/
// slack.js) to re-verify — server-side, never from browser input — that the
// member who initiated /start (resolved from the consumed oauth_states row)
// is still active and still owner/admin before a connection is persisted.
async function getClientMemberById(memberId, clientId) {
  const { data, error } = await supabase
    .from('client_members')
    .select('id, client_id, email, role, status, full_name')
    .eq('id', memberId)
    .eq('client_id', clientId)
    .single();

  if (error && error.code === 'PGRST116') return null;
  if (error) throw new Error(`getClientMemberById failed: ${error.message}`);
  return data;
}

async function getMemberByAuthUserId(authUserId) {
  const { data, error } = await supabase
    .from('client_members')
    .select('id, client_id, email, role, status')
    .eq('auth_user_id', authUserId)
    .single();

  if (error && error.code === 'PGRST116') return null;
  if (error) throw new Error(`getMemberByAuthUserId failed: ${error.message}`);
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

async function getClientMembersByClientIds(clientIds) {
  if (!Array.isArray(clientIds) || clientIds.length === 0) return [];

  const { data, error } = await supabase
    .from('client_members')
    .select('id, client_id, email, full_name, role, status, invited_at, accepted_at, last_active_at, created_at')
    .in('client_id', clientIds)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`getClientMembersByClientIds failed: ${error.message}`);
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

// Backlog M2 — team_invites stores only this hash, never the raw token,
// mirroring oauthStateService.js#hashState (same algorithm/encoding). The
// raw token (routes/team.js#generateToken) is still what gets emailed to
// the invitee; only its at-rest storage is hash-only.
function hashInviteToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

async function createTeamInvite({ clientId, email, role, token, expiresAt, invitedBy }) {
  const { data, error } = await supabase
    .from('team_invites')
    .insert({
      client_id: clientId,
      email,
      role,
      token_hash: hashInviteToken(token),
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
    .eq('token_hash', hashInviteToken(token))
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

async function acceptTeamInvite(token, authUserId, clientId, email) {
  const now = new Date().toISOString();

  // Link the member row first, and verify a row was actually matched.
  // Only rows in 'invited' or 'active' status may be (re)linked — this
  // stops a replayed/stale invite token from reactivating a member that
  // was later disabled or revoked.
  const { data: member, error: memberError } = await supabase
    .from('client_members')
    .update({ auth_user_id: authUserId, status: 'active', accepted_at: now, updated_at: now })
    .eq('client_id', clientId)
    .eq('email', email)
    .in('status', ['invited', 'active'])
    .select('id, status')
    .single();

  if (memberError || !member) {
    const err = new Error(`acceptTeamInvite (member link) failed: ${memberError ? memberError.message : 'no matching member row'}`);
    err.code = 'MEMBER_LINK_FAILED';
    throw err;
  }

  // Only mark the invite accepted after the member link succeeded, so a
  // failed link leaves the invite retryable instead of permanently spent.
  // A concurrent caller may have already marked it accepted — that's a
  // benign race now that the member link itself is idempotent, so treat
  // a 0-row result here as success rather than an error.
  const { data: invite, error: inviteError } = await supabase
    .from('team_invites')
    .update({ accepted_at: now })
    .eq('token_hash', hashInviteToken(token))
    .is('accepted_at', null)
    .select('client_id, email, role')
    .maybeSingle();

  if (inviteError) throw new Error(`acceptTeamInvite (invite update) failed: ${inviteError.message}`);

  return {
    client_id: clientId,
    email,
    role: invite ? invite.role : null,
    alreadyAccepted: !invite,
  };
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
      token_hash: hashInviteToken(newToken),
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
// Document import provenance / grouped history
// ─────────────────────────────────────────────

// Best-effort — a logging failure must never fail an import. Callers should
// catch and swallow errors from this the same way the maxDocuments count
// check is treated as non-blocking elsewhere in routes/api.js.
async function logImportBatch(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;

  const rows = entries.map((e) => ({
    client_id: e.clientId,
    import_batch_id: e.importBatchId,
    source_type: e.sourceType,
    source_path: e.sourcePath || null,
    file_name: e.fileName,
    source_file_id: e.sourceFileId,
    imported_by: e.importedBy || null,
  }));

  const { error } = await supabase.from('document_import_log').insert(rows);
  if (error) throw new Error(`logImportBatch failed: ${error.message}`);
}

async function getImportHistory(clientId, limit = 20) {
  const { data, error } = await supabase
    .from('document_import_log')
    .select('import_batch_id, source_type, created_at')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(500); // enough rows to reconstruct the most recent `limit` batches

  if (error) throw new Error(`getImportHistory failed: ${error.message}`);

  const batches = new Map();
  for (const row of data || []) {
    const existing = batches.get(row.import_batch_id);
    if (existing) {
      existing.fileCount += 1;
      if (row.created_at < existing.createdAt) existing.createdAt = row.created_at;
    } else {
      batches.set(row.import_batch_id, {
        importBatchId: row.import_batch_id,
        sourceType: row.source_type,
        sourceLabel: sourceLabelFor(row.source_type),
        fileCount: 1,
        createdAt: row.created_at,
      });
    }
  }

  return [...batches.values()]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit);
}

// One row per source_file_id, keyed for the documents-list enrichment merge.
// Portal-specific context only — AIKB remains the source of truth for the
// document itself (existence, file name, status).
async function getImportLogMap(clientId) {
  const { data, error } = await supabase
    .from('document_import_log')
    .select('source_file_id, source_type, source_path, file_name, imported_by, created_at')
    .eq('client_id', clientId);

  if (error) throw new Error(`getImportLogMap failed: ${error.message}`);

  const map = new Map();
  for (const row of data || []) {
    map.set(row.source_file_id, {
      sourceType: row.source_type,
      sourceLabel: sourceLabelFor(row.source_type),
      sourcePath: row.source_path,
      importedBy: row.imported_by,
      importedAt: row.created_at,
    });
  }
  return map;
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
  getClientMemberById,
  getMemberByAuthUserId,
  createClientMember,
  getClientMembers,
  getClientMembersByClientIds,
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
  // Document import provenance / grouped history
  logImportBatch,
  getImportHistory,
  sourceLabelFor,
  getImportLogMap,
};
