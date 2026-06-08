const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { supabase: supabaseConfig, appBaseUrl } = require('../config');
const adminAuth = require('../middleware/adminAuth');
const supabaseService = require('../services/supabaseService');

const supabase = createClient(supabaseConfig.url, supabaseConfig.serviceKey);

router.post('/login', (req, res) => {
  const { password } = req.body;
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  res.json({ token: adminAuth.generateToken() });
});

router.get('/clients', adminAuth, async (req, res) => {
  try {
    const clients = await supabaseService.getAllClientsWithStatus();
    res.json(clients);
  } catch (err) {
    console.error('admin/clients error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/invite', adminAuth, async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }

  let client;
  try {
    client = await supabaseService.createClientRecord(name, email);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const { error: inviteError } = await supabase.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${appBaseUrl}/invite-claim.html`,
    data: { client_id: client.id },
  });

  if (inviteError) {
    try { await supabaseService.deleteClient(client.id); } catch {}
    console.error('Invite error:', inviteError.message);
    return res.status(500).json({ error: inviteError.message });
  }

  res.json({ success: true, clientId: client.id });
});

router.delete('/clients/:clientId', adminAuth, async (req, res) => {
  try {
    await supabaseService.deleteClientFull(req.params.clientId);
    res.json({ success: true });
  } catch (err) {
    console.error('admin/delete client error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
