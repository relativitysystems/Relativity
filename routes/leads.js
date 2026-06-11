const express = require('express');
const router = express.Router();
const supabaseService = require('../services/supabaseService');
const emailService = require('../services/emailService');

const NAME_MAX    = 200;
const EMAIL_MAX   = 200;
const PHONE_MAX   = 200;
const COMPANY_MAX = 200;
const MESSAGE_MAX = 2000;

function isValidEmail(str) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
}

router.post('/leads', async (req, res) => {
  const {
    name: rawName,
    email: rawEmail,
    phone: rawPhone,
    company: rawCompany,
    message: rawMessage,
    website, // honeypot — bots fill this, humans don't
  } = req.body;

  if (website) {
    return res.json({ success: true });
  }

  const name    = typeof rawName    === 'string' ? rawName.trim().slice(0, NAME_MAX)       : '';
  const email   = typeof rawEmail   === 'string' ? rawEmail.trim().slice(0, EMAIL_MAX)     : '';
  const phone   = typeof rawPhone   === 'string' ? rawPhone.trim().slice(0, PHONE_MAX)     : '';
  const company = typeof rawCompany === 'string' ? rawCompany.trim().slice(0, COMPANY_MAX) : '';
  const message = typeof rawMessage === 'string' ? rawMessage.trim().slice(0, MESSAGE_MAX) : '';

  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  let lead;
  try {
    lead = await supabaseService.createLead({ name, email, phone, company, message, source: 'website' });
  } catch (err) {
    console.error('POST /api/leads createLead error:', err.message);
    return res.status(500).json({ error: 'Failed to save your message. Please try again.' });
  }

  void emailService.sendLeadNotification({ name, email, phone, company, message, created_at: lead.created_at });

  res.status(201).json({ success: true });
});

module.exports = router;
