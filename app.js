require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const leadsRoutes = require('./routes/leads');

const app = express();

app.use(express.json());

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
app.use('/admin', adminRoutes);

module.exports = app;
