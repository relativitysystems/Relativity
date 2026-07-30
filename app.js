require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const corsPolicy = require('./middleware/corsPolicy');
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const leadsRoutes = require('./routes/leads');
const teamRoutes = require('./routes/team');
const collectionsRoutes = require('./routes/collections');
const slackIntegrationRoutes = require('./routes/integrations/slack');
const emailIntegrationRoutes = require('./routes/integrations/email');
const toolExecutionRoutes = require('./routes/toolExecution');

const app = express();

// Backlog M6 — explicit CORS allowlist, ahead of every route.
app.use(corsPolicy);

// Slack Events signature verification (routes/integrations/slack.js, POST
// /events and /deliver) needs the exact raw request bytes — re-serializing
// req.body with JSON.stringify can silently change key order/whitespace and
// invalidate a legitimate signature. This verify callback is the cheapest,
// lowest-risk way to retain those bytes: every other route already ignores
// req.rawBody, so this has no effect on any existing behavior.
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
}));

// Local dev only — Vercel serves public/ as static files directly from CDN
app.use(express.static(path.join(__dirname, 'public')));

// Root route: serve index.html if present, otherwise redirect to /portal.html
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.redirect('/portal.html');
  }
});

app.use('/auth', authRoutes);
app.use('/api', apiRoutes);
app.use('/api', leadsRoutes);
app.use('/api', teamRoutes);
app.use('/api', collectionsRoutes);
app.use('/api/integrations/slack', slackIntegrationRoutes);
app.use('/api/integrations/email', emailIntegrationRoutes);
// EL3 (Architecture/architecture/LIVE_EMAIL_LOOKUP.md) — the AIKB -> Relativity
// signed tool-execution callback. A new top-level namespace, not under
// /api/integrations/*, since a tool call isn't scoped to one provider.
app.use('/api/tools', toolExecutionRoutes);
app.use('/admin', adminRoutes);

module.exports = app;
