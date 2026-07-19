const crypto = require('crypto');

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function generateToken() {
  const payload = Buffer.from(JSON.stringify({ role: 'admin', iat: Date.now() })).toString('base64url');
  const sig = crypto
    .createHmac('sha256', process.env.ADMIN_JWT_SECRET)
    .update(payload)
    .digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return false;
  const lastDot = token.lastIndexOf('.');
  const payload = token.slice(0, lastDot);
  const sig = token.slice(lastDot + 1);
  const expected = crypto
    .createHmac('sha256', process.env.ADMIN_JWT_SECRET)
    .update(payload)
    .digest('base64url');
  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const safeEqual = sigBuf.length === expectedBuf.length
    && crypto.timingSafeEqual(sigBuf, expectedBuf);
  if (!safeEqual) return false;
  try {
    const { iat } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Date.now() - iat < TOKEN_TTL_MS;
  } catch {
    return false;
  }
}

function adminAuth(req, res, next) {
  if (!verifyToken(req.headers['x-admin-token'])) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

adminAuth.generateToken = generateToken;

module.exports = adminAuth;
