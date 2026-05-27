require('dotenv').config();
const express = require('express');
const { port } = require('./config');
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');
const apiKeyMiddleware = require('./middleware/apiKey');

const app = express();

app.use(express.json());

// Explicit root route so mainPg.html is served at / (express.static defaults to index.html)
app.get('/', (req, res) => res.sendFile('mainPg.html', { root: '.' }));

// Serves mainPg.html, portal.html, mainPg.css, etc. from the project root
app.use(express.static('.'));

// OAuth routes — no API key required (browser-facing)
app.use('/auth', authRoutes);

// n8n-facing API routes — protected by API key middleware
app.use('/api', apiKeyMiddleware, apiRoutes);

app.listen(port, () => {
  console.log(`Relativity backend running on http://localhost:${port}`);
});
