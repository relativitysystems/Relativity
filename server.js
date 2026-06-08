require('dotenv').config();
const express = require('express');
const { port } = require('./config');
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');

const app = express();

app.use(express.json());

// Serves portal.html, login.html, mainPg.css, etc. from the project root
app.use(express.static('.'));

// Auth routes (Supabase config, OAuth, /me) — no API key required
app.use('/auth', authRoutes);

// API routes for n8n/Inngest consumption — protected by API key
app.use('/api', apiRoutes);

app.listen(port, () => {
  console.log(`Relativity backend running on http://localhost:${port}`);
});
