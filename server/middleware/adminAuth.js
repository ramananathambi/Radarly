/**
 * Admin auth middleware — checks hardcoded password from env.
 * Expects: Authorization: Bearer <ADMIN_PASSWORD>
 * or cookie: admin_token=<ADMIN_PASSWORD>
 */
require('dotenv').config();

function requireAdmin(req, res, next) {
  const token =
    req.cookies?.admin_token ||
    req.headers.authorization?.replace('Bearer ', '');

  if (!token || token !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Admin access denied' });
  }

  next();
}

module.exports = { requireAdmin };
