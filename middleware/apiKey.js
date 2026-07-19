const crypto = require('crypto');

module.exports = (req, res, next) => {
  const key = req.headers['x-api-key'];
  if (!key || typeof key !== 'string') {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  const keyBuf = Buffer.from(key, 'utf8');
  const expectedBuf = Buffer.from(process.env.API_KEY || '', 'utf8');
  const safeEqual = keyBuf.length === expectedBuf.length
    && crypto.timingSafeEqual(keyBuf, expectedBuf);
  if (!safeEqual) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
};
