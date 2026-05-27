require('dotenv').config();
const express = require('express');
const { port } = require('./config');
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');
const apiKeyMiddleware = require('./middleware/apiKey');

const app = express();

app.use(express.json());

// Serves portal.html, mainPg.css, etc. from the project root
// express.static will serve index.html at / automatically
app.use(express.static('.'));

// OAuth routes — no API key required (browser-facing)
app.use('/auth', authRoutes);

// n8n-facing API routes — protected by API key middleware
app.use('/api', apiKeyMiddleware, apiRoutes);

app.listen(port, () => {
  console.log(`Relativity backend running on http://localhost:${port}`);
});
