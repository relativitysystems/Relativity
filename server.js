require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { port } = require('./config');
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');

const app = express();

app.use(express.json());

// Serves portal.html, login.html, mainPg.css, etc. from the project root
app.use(express.static(path.join(__dirname)));

// Root route: serve index.html if present, otherwise redirect to /portal.html
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.redirect('/portal.html');
  }
});

// Auth routes (Supabase config, OAuth, /me) — no API key required
app.use('/auth', authRoutes);

// API routes — protected by API key
app.use('/api', apiRoutes);

// Admin routes — protected by admin token
app.use('/admin', adminRoutes);

module.exports = app;

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Relativity backend running on http://localhost:${port}`);
  });
}
