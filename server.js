require('dotenv').config();
const express = require('express');
const { port } = require('./config');
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');

const app = express();

app.use(express.json());

// Serves portal.html, login.html, mainPg.css, etc. from the project root
app.use(express.static('.'));

// Auth routes (Supabase config, OAuth, /me) — no API key required
app.use('/auth', authRoutes);

// API routes — protected by API key
app.use('/api', apiRoutes);

// Admin routes — protected by admin token
app.use('/admin', adminRoutes);

app.listen(port, () => {
  console.log(`Relativity backend running on http://localhost:${port}`);
});
