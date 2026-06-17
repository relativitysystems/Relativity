const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { supabase: supabaseConfig, appBaseUrl } = require('../config');
const adminAuth = require('../middleware/adminAuth');
const supabaseService = require('../services/supabaseService');
const aikbService = require('../services/aikbService');

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

router.get('/clients/:clientId/aikb-health', adminAuth, async (req, res) => {
  const { clientId } = req.params;
  const [summaryR, analyticsR, jobsR, issueR] = await Promise.allSettled([
    aikbService.getClientSummary(clientId),
    aikbService.getClientAnalytics(clientId),
    aikbService.listIngestionJobs(clientId),
    supabaseService.getClientIssueCount(clientId),
  ]);

  const summary   = summaryR.status   === 'fulfilled' ? (summaryR.value   || {}) : {};
  const analytics = analyticsR.status === 'fulfilled' ? (analyticsR.value || {}) : {};
  const jobs      = jobsR.status      === 'fulfilled'
    ? (jobsR.value.jobs || (Array.isArray(jobsR.value) ? jobsR.value : []))
    : [];
  const latestJob = jobs[0] || null;

  res.json({
    totalDocuments:     summary.totalDocuments     ?? summary.documentCount   ?? null,
    indexedDocuments:   summary.indexedDocuments   ?? summary.indexedCount    ?? null,
    failedDocuments:    summary.failedDocuments     ?? summary.failedCount     ?? null,
    indexingDocuments:  summary.indexingDocuments   ?? null,
    totalQuestions:     analytics.totalQuestions    ?? null,
    totalKnowledgeGaps: analytics.totalKnowledgeGaps ?? analytics.knowledgeGaps ?? null,
    latestIngestionJob: latestJob ? { status: latestJob.status, created_at: latestJob.created_at } : null,
    lastQuestionAt:     analytics.lastQuestionAt   ?? null,
    lastIndexedAt:      summary.lastIndexedAt      ?? null,
    issueCount:         issueR.status === 'fulfilled' ? issueR.value : null,
  });
});

router.get('/analytics', adminAuth, async (req, res) => {
  try {
    const [clients, issueSummary] = await Promise.all([
      supabaseService.getAllClientsWithStatus(),
      supabaseService.getPortalIssueSummary(),
    ]);

    const aikbStats = await Promise.allSettled(
      clients.map(c => aikbService.getClientDocumentStats(c.id))
    );

    let totalDocuments = 0;
    let totalIndexed = 0;
    let totalFailed = 0;
    let aikbDataAvailable = true;

    aikbStats.forEach(result => {
      if (result.status === 'fulfilled' && result.value.documentCount !== null) {
        totalDocuments += result.value.documentCount;
        totalIndexed += result.value.indexedCount;
        totalFailed += result.value.failedCount;
      } else {
        aikbDataAvailable = false;
      }
    });

    res.json({
      clientCount: clients.length,
      totalIssues: issueSummary.total,
      openIssues: issueSummary.open,
      totalDocuments: aikbDataAvailable ? totalDocuments : null,
      totalIndexed: aikbDataAvailable ? totalIndexed : null,
      totalFailed: aikbDataAvailable ? totalFailed : null,
      // TODO: totalQuestions — needs a dedicated AIKB analytics endpoint
      totalQuestions: null,
    });
  } catch (err) {
    console.error('admin/analytics error:', err.message);
    res.status(500).json({ error: 'Failed to load analytics.' });
  }
});

router.get('/leads', adminAuth, async (req, res) => {
  try {
    const leads = await supabaseService.getAllLeads();
    res.json(leads);
  } catch (err) {
    console.error('admin/leads GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/leads/:leadId', adminAuth, async (req, res) => {
  const { leadId } = req.params;
  const { status, notes, archived } = req.body;

  try {
    if (archived === true) {
      await supabaseService.archiveLead(leadId);
    } else if (typeof notes === 'string') {
      await supabaseService.updateLeadNotes(leadId, notes);
    } else if (status) {
      await supabaseService.updateLeadStatus(leadId, status);
    } else {
      return res.status(400).json({ error: 'Provide status, notes, or archived:true' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('admin/leads PATCH error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/leads/:leadId', adminAuth, async (req, res) => {
  try {
    await supabaseService.deleteLead(req.params.leadId);
    res.json({ success: true });
  } catch (err) {
    console.error('admin/leads DELETE error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/issues', adminAuth, async (req, res) => {
  try {
    const issues = await supabaseService.getAllPortalIssues();
    res.json(issues);
  } catch (err) {
    console.error('admin/issues GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/issues/:issueId', adminAuth, async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['open', 'in_review', 'resolved'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
  }
  try {
    await supabaseService.updatePortalIssueStatus(req.params.issueId, status);
    res.json({ success: true });
  } catch (err) {
    console.error('admin/issues PATCH error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
