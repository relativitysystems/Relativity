require('dotenv').config();
const express = require('express');
const path = require('path');
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

// Clean, extensionless client-facing URLs. Mirrors the rewrites/redirects in
// vercel.json (which is what production uses): each clean path serves the real
// file, and the old .html paths redirect to the clean one (query string kept).
const publicDir = path.join(__dirname, 'public');
const CLEAN_ROUTES = {
  '/': 'marketing/index.html',
  '/login': 'portal/login.html',
  '/portal': 'portal/portal.html',
  '/forgot-password': 'portal/forgot-password.html',
  '/reset-password': 'portal/reset-password.html',
  '/invite-team': 'portal/invite-team.html',
  '/invite-claim': 'portal/invite-claim.html',
  '/privacy': 'privacy.html',
  // Shares its path with the /admin API router; only GET /admin (exactly) is
  // the page, everything else falls through to adminRoutes.
  '/admin': 'admin/admin.html',
};
const LEGACY_REDIRECTS = {
  '/marketing/index.html': '/',
  '/marketing': '/',
  '/privacy.html': '/privacy',
  '/admin/admin.html': '/admin',
};
for (const name of ['login', 'portal', 'forgot-password', 'reset-password', 'invite-team', 'invite-claim']) {
  LEGACY_REDIRECTS[`/${name}.html`] = `/${name}`;
  LEGACY_REDIRECTS[`/portal/${name}.html`] = `/${name}`;
}
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const legacy = LEGACY_REDIRECTS[req.path];
  if (legacy) {
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    return res.redirect(legacy + qs);
  }
  const file = CLEAN_ROUTES[req.path];
  if (file) return res.sendFile(path.join(publicDir, file));
  next();
});

// Local dev only � Vercel serves public/ as static files directly from CDN
app.use(express.static(publicDir));

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
