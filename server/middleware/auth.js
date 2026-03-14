const { pool } = require('../lib/db');

/**
 * requireAuth — validates Supabase JWT and attaches MySQL user to req.user
 * Supabase access_token is sent as: Authorization: Bearer <token>
 */
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Validate token against Supabase and get the user's Supabase ID
    const supaResp = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: process.env.SUPABASE_ANON_KEY,
      },
    });

    if (!supaResp.ok) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    const supaUser = await supaResp.json();

    // Look up our MySQL user by Supabase user ID
    const [rows] = await pool.execute(
      'SELECT id, name, phone, email, is_verified FROM users WHERE id = ?',
      [supaUser.id]
    );

    const user = rows[0] || null;

    if (!user) {
      return res.status(401).json({ error: 'Account not found. Please log in again.' });
    }

    user.is_verified = !!user.is_verified;
    req.user = user;
    next();
  } catch (err) {
    console.error('[Auth] Error:', err.message);
    return res.status(500).json({ error: 'Authentication failed' });
  }
}

module.exports = { requireAuth };
