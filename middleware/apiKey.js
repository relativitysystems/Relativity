const { n8nApiKey } = require('../config');

// Guards all /api/* routes — only requests with the correct Bearer token pass through.
// n8n sends this in the Authorization header of its HTTP Request nodes.
module.exports = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!token || token !== n8nApiKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
};
