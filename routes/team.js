const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { appBaseUrl, supabase: supabaseConfig } = require('../config');
const clientAuth = require('../middleware/clientAuth');
const supabaseService = require('../services/supabaseService');
const { sendTeamInviteEmail } = require('../services/emailService');

const supabase = createClient(supabaseConfig.url, supabaseConfig.serviceKey);

const INVITE_EXPIRES_DAYS = 7;
const OWNER_ADMIN = ['owner', 'admin'];

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.member || !roles.includes(req.member.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function inviteExpiresAt() {
  const d = new Date();
  d.setDate(d.getDate() + INVITE_EXPIRES_DAYS);
  return d.toISOString();
}

/**
 * GET /api/team/invites/verify?token=…
 * No auth required — called by invite-team.html before the user logs in.
 */
router.get('/team/invites/verify', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'token is required' });

  try {
    const invite = await supabaseService.getTeamInviteByToken(token);

    if (!invite) return res.json({ valid: false, reason: 'not_found' });
    if (invite.revoked_at) return res.json({ valid: false, reason: 'revoked' });
    if (invite.accepted_at) {
      return res.json({
        valid: false,
        reason: 'already_accepted',
        email: invite.email,
        clientName: invite.clients?.name || 'your company',
      });
    }
    if (new Date(invite.expires_at) < new Date()) return res.json({ valid: false, reason: 'expired' });

    res.json({
      valid: true,
      email: invite.email,
      role: invite.role,
      clientName: invite.clients?.name || 'your company',
    });
  } catch (err) {
    console.error('GET /api/team/invites/verify error:', err.message);
    res.status(500).json({ error: 'Could not verify invite' });
  }
});

/**
 * POST /api/team/invite
 * owner/admin only. Creates a pending member + invite token, sends email.
 */
router.post('/team/invite', clientAuth, requireRole(...OWNER_ADMIN), async (req, res) => {
  const { email, role } = req.body;

  if (!email || typeof email !== 'string' || !email.trim()) {
    return res.status(400).json({ error: 'email is required' });
  }
  if (!role || !['admin', 'member', 'viewer'].includes(role)) {
    return res.status(400).json({ error: 'role must be admin, member, or viewer' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const clientId = req.client.id;

  try {
    // Seat limit check
    const { data: clientRecord } = await supabase
      .from('clients')
      .select('max_members')
      .eq('id', clientId)
      .single();

    const maxMembers = clientRecord?.max_members ?? 10;
    const activeCount = await supabaseService.getActiveMemberCount(clientId);

    if (activeCount >= maxMembers) {
      return res.status(403).json({ error: `Seat limit reached (${maxMembers} members). Contact support to upgrade.` });
    }

    // Don't allow duplicate active/invited members
    const existing = await supabaseService.getClientMembers(clientId);
    const duplicate = existing.find(
      m => m.email.toLowerCase() === normalizedEmail && !['disabled', 'revoked'].includes(m.status)
    );
    if (duplicate) {
      return res.status(409).json({ error: 'A member with that email already exists' });
    }

    const now = new Date().toISOString();
    const token = generateToken();
    const expiresAt = inviteExpiresAt();

    // Create pending member row
    const member = await supabaseService.createClientMember({
      clientId,
      email: normalizedEmail,
      fullName: null,
      role,
      status: 'invited',
      invitedBy: req.member.id,
      invitedAt: now,
    });

    // Create invite token row
    await supabaseService.createTeamInvite({
      clientId,
      email: normalizedEmail,
      role,
      token,
      expiresAt,
      invitedBy: req.member.id,
    });

    const acceptUrl = `${appBaseUrl}/invite-team.html?token=${token}`;
    await sendTeamInviteEmail({
      toEmail: normalizedEmail,
      companyName: req.client.name || 'your company',
      inviterName: req.member.full_name || req.user?.email || 'A team admin',
      role,
      acceptUrl,
    });

    res.status(201).json({ success: true, member });
  } catch (err) {
    console.error('POST /api/team/invite error:', err.message);
    res.status(500).json({ error: 'Could not send invite' });
  }
});

/**
 * GET /api/team/members
 * owner/admin only. Returns all members for this client.
 */
router.get('/team/members', clientAuth, requireRole(...OWNER_ADMIN), async (req, res) => {
  try {
    const members = await supabaseService.getClientMembers(req.client.id);
    res.json(members);
  } catch (err) {
    console.error('GET /api/team/members error:', err.message);
    res.status(500).json({ error: 'Could not load team members' });
  }
});

/**
 * POST /api/team/invites/resend
 * body: { memberId }
 */
router.post('/team/invites/resend', clientAuth, requireRole(...OWNER_ADMIN), async (req, res) => {
  const { memberId } = req.body;
  if (!memberId) return res.status(400).json({ error: 'memberId is required' });

  try {
    const members = await supabaseService.getClientMembers(req.client.id);
    const member = members.find(m => m.id === memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });
    if (member.status !== 'invited') {
      return res.status(400).json({ error: 'Can only resend for members with invited status' });
    }

    const newToken = generateToken();
    const newExpiresAt = inviteExpiresAt();

    const invite = await supabaseService.regenerateTeamInvite(memberId, req.client.id, newToken, newExpiresAt);

    const acceptUrl = `${appBaseUrl}/invite-team.html?token=${newToken}`;
    await sendTeamInviteEmail({
      toEmail: member.email,
      companyName: req.client.name || 'your company',
      inviterName: req.member.full_name || req.user?.email || 'A team admin',
      role: member.role,
      acceptUrl,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/team/invites/resend error:', err.message);
    res.status(500).json({ error: 'Could not resend invite' });
  }
});

/**
 * POST /api/team/invites/revoke
 * body: { memberId }
 */
router.post('/team/invites/revoke', clientAuth, requireRole(...OWNER_ADMIN), async (req, res) => {
  const { memberId } = req.body;
  if (!memberId) return res.status(400).json({ error: 'memberId is required' });

  try {
    await supabaseService.revokeTeamInvite(memberId, req.client.id);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/team/invites/revoke error:', err.message);
    res.status(500).json({ error: 'Could not revoke invite' });
  }
});

/**
 * PATCH /api/team/members/:memberId
 * body: { role?, status? }
 */
router.patch('/team/members/:memberId', clientAuth, requireRole(...OWNER_ADMIN), async (req, res) => {
  const { memberId } = req.params;
  const { role, status } = req.body;

  if (!role && !status) {
    return res.status(400).json({ error: 'role or status is required' });
  }
  if (role && !['owner', 'admin', 'member', 'viewer'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  try {
    const members = await supabaseService.getClientMembers(req.client.id);
    const target = members.find(m => m.id === memberId);
    if (!target) return res.status(404).json({ error: 'Member not found' });

    // Guard: don't demote the last owner
    if (target.role === 'owner' && role && role !== 'owner') {
      const ownerCount = members.filter(m => m.role === 'owner' && m.status === 'active').length;
      if (ownerCount <= 1) {
        return res.status(400).json({ error: 'Cannot change role of the last owner' });
      }
    }

    const updates = {};
    if (role) updates.role = role;
    if (status) updates.status = status;

    const updated = await supabaseService.updateClientMember(memberId, req.client.id, updates);
    res.json(updated);
  } catch (err) {
    console.error('PATCH /api/team/members/:memberId error:', err.message);
    res.status(500).json({ error: 'Could not update member' });
  }
});

/**
 * POST /api/team/members/:memberId/disable
 */
router.post('/team/members/:memberId/disable', clientAuth, requireRole(...OWNER_ADMIN), async (req, res) => {
  const { memberId } = req.params;

  try {
    const members = await supabaseService.getClientMembers(req.client.id);
    const target = members.find(m => m.id === memberId);
    if (!target) return res.status(404).json({ error: 'Member not found' });

    if (target.role === 'owner') {
      const ownerCount = members.filter(m => m.role === 'owner' && m.status === 'active').length;
      if (ownerCount <= 1) {
        return res.status(400).json({ error: 'Cannot disable the last owner' });
      }
    }

    const updated = await supabaseService.updateClientMember(memberId, req.client.id, { status: 'disabled' });
    res.json(updated);
  } catch (err) {
    console.error('POST /api/team/members/:memberId/disable error:', err.message);
    res.status(500).json({ error: 'Could not disable member' });
  }
});

module.exports = router;
