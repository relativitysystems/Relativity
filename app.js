require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const leadsRoutes = require('./routes/leads');
const teamRoutes = require('./routes/team');
const slackIntegrationRoutes = require('./routes/integrations/slack');

const app = express();

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
app.use('/api/integrations/slack', slackIntegrationRoutes);
app.use('/admin', adminRoutes);

module.exports = app;
