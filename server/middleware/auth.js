const { pool } = require('../lib/db');

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const [rows] = await pool.execute(
      `SELECT id, name, phone, email, is_verified
       FROM users
       WHERE session_token = ? AND session_expires_at > NOW()`,
      [token]
    );

    const user = rows[0] || null;

    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    user.is_verified = !!user.is_verified;
    req.user = user;
    next();
  } catch (err) {
    console.error('[Auth] DB error:', err.message);
    return res.status(500).json({ error: 'Authentication failed' });
  }
}

module.exports = { requireAuth };
