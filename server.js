require('dotenv').config();
const express = require('express');
const { serve } = require('inngest/express');
const { port } = require('./config');
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');
const apiKeyMiddleware = require('./middleware/apiKey');
const { inngest } = require('./inngest/client');
const { functions } = require('./inngest/functions');

const app = express();

app.use(express.json());

// Serves portal.html, login.html, mainPg.css, etc. from the project root
app.use(express.static('.'));

// Auth routes (Supabase config, OAuth, /me) — no API key required
app.use('/auth', authRoutes);

// Inngest serve handler — must be registered before the apiKey catch-all below
app.use('/api/inngest', serve({ client: inngest, functions }));

// Legacy n8n-facing routes — protected by API key middleware
app.use('/api', apiKeyMiddleware, apiRoutes);

app.listen(port, () => {
  console.log(`Relativity backend running on http://localhost:${port}`);
});
