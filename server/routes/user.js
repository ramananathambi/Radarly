const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcrypt');
const { pool }          = require('../lib/db');
const { requireAuth }   = require('../middleware/auth');

// All routes require auth
router.use(requireAuth);

// ─── User Stocks ──────────────────────────────────────────────────────────────

// GET /api/user/stocks
router.get('/stocks', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT us.symbol, us.added_at,
              sm.company_name, sm.exchange, sm.sector, sm.last_price, sm.price_updated_at
       FROM user_stocks us
       JOIN stocks_master sm ON us.symbol = sm.symbol
       WHERE us.user_id = ?
       ORDER BY us.added_at DESC`,
      [req.user.id]
    );

    // Restructure to match Supabase nested format for API compatibility
    const stocks = rows.map(r => ({
      symbol:   r.symbol,
      added_at: r.added_at,
      stocks_master: {
        company_name:     r.company_name,
        exchange:         r.exchange,
        sector:           r.sector,
        last_price:       r.last_price,
        price_updated_at: r.price_updated_at,
      },
    }));

    res.json({ stocks });
  } catch (err) {
    console.error('[User] Get stocks error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch your stocks' });
  }
});

// POST /api/user/stocks — { symbol }
router.post('/stocks', async (req, res) => {
  const { symbol } = req.body;

  if (!symbol?.trim()) {
    return res.status(400).json({ error: 'Symbol is required' });
  }

  const sym = symbol.trim().toUpperCase();

  // Verify stock exists
  const [stockRows] = await pool.execute(
    'SELECT symbol FROM stocks_master WHERE symbol = ?',
    [sym]
  );

  if (stockRows.length === 0) {
    return res.status(404).json({ error: `Stock ${sym} not found` });
  }

  try {
    await pool.execute(
      `INSERT IGNORE INTO user_stocks (user_id, symbol) VALUES (?, ?)`,
      [req.user.id, sym]
    );
  } catch (err) {
    console.error('[User] Add stock error:', err.message);
    return res.status(500).json({ error: 'Failed to add stock' });
  }

  res.json({ success: true, symbol: sym });
});

// DELETE /api/user/stocks/:symbol
router.delete('/stocks/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase();

  try {
    await pool.execute(
      'DELETE FROM user_stocks WHERE user_id = ? AND symbol = ?',
      [req.user.id, sym]
    );
  } catch (err) {
    console.error('[User] Remove stock error:', err.message);
    return res.status(500).json({ error: 'Failed to remove stock' });
  }

  res.json({ success: true, symbol: sym });
});

// ─── Alert Preferences ────────────────────────────────────────────────────────

// GET /api/user/preferences
router.get('/preferences', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT uap.alert_type, uap.scope, uap.is_enabled, uap.updated_at,
              at.name, at.description, at.is_active
       FROM user_alert_preferences uap
       JOIN alert_types at ON uap.alert_type = at.code
       WHERE uap.user_id = ?`,
      [req.user.id]
    );

    // Restructure to match Supabase nested format
    const preferences = rows.map(r => ({
      alert_type: r.alert_type,
      scope:      r.scope,
      is_enabled: !!r.is_enabled,
      updated_at: r.updated_at,
      alert_types: {
        name:        r.name,
        description: r.description,
        is_active:   !!r.is_active,
      },
    }));

    res.json({ preferences });
  } catch (err) {
    console.error('[User] Get prefs error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

// PUT /api/user/preferences — { alert_type, scope, is_enabled }
router.put('/preferences', async (req, res) => {
  const { alert_type, scope, is_enabled } = req.body;

  if (!alert_type) {
    return res.status(400).json({ error: 'alert_type is required' });
  }

  // Validate scope if provided
  if (scope && !['all_stocks', 'selected_stocks'].includes(scope)) {
    return res.status(400).json({ error: 'scope must be all_stocks or selected_stocks' });
  }

  // Verify alert_type is valid and active
  const [atRows] = await pool.execute(
    'SELECT code FROM alert_types WHERE code = ? AND is_active = 1',
    [alert_type]
  );

  if (atRows.length === 0) {
    return res.status(400).json({ error: `Alert type ${alert_type} is not available` });
  }

  // Build dynamic update
  const setClauses = ['updated_at = NOW()'];
  const params     = [];

  if (scope !== undefined) {
    setClauses.push('scope = ?');
    params.push(scope);
  }
  if (is_enabled !== undefined) {
    setClauses.push('is_enabled = ?');
    params.push(is_enabled ? 1 : 0);
  }

  params.push(req.user.id, alert_type);

  try {
    await pool.execute(
      `UPDATE user_alert_preferences SET ${setClauses.join(', ')}
       WHERE user_id = ? AND alert_type = ?`,
      params
    );
  } catch (err) {
    console.error('[User] Update prefs error:', err.message);
    return res.status(500).json({ error: 'Failed to update preference' });
  }

  res.json({ success: true });
});

// GET /api/user/me — current user info (used by frontend to check session)
router.get('/me', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT password_hash FROM users WHERE id = ?',
      [req.user.id]
    );
    res.json({
      id:          req.user.id,
      name:        req.user.name,
      phone:       req.user.phone,
      email:       req.user.email,
      hasPassword: !!rows[0]?.password_hash,
    });
  } catch (err) {
    res.json({
      id:    req.user.id,
      name:  req.user.name,
      phone: req.user.phone,
      email: req.user.email,
    });
  }
});

// PUT /api/user/profile — update name and/or phone
router.put('/profile', async (req, res) => {
  const { name, phone } = req.body;

  if (name === undefined && phone === undefined) {
    return res.status(400).json({ error: 'Nothing to update' });
  }

  if (name !== undefined && !name?.trim()) {
    return res.status(400).json({ error: 'Name cannot be empty' });
  }

  if (phone !== undefined && phone !== '' && !/^\+91[6-9]\d{9}$/.test(phone)) {
    return res.status(400).json({ error: 'Invalid phone number. Use format: +91XXXXXXXXXX' });
  }

  // Check phone uniqueness
  if (phone && phone !== '') {
    const [existing] = await pool.execute(
      'SELECT id FROM users WHERE phone = ? AND id != ?',
      [phone, req.user.id]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'This phone number is already linked to another account' });
    }
  }

  const setClauses = [];
  const params = [];

  if (name !== undefined) {
    setClauses.push('name = ?');
    params.push(name.trim());
  }
  if (phone !== undefined) {
    setClauses.push('phone = ?');
    params.push(phone);
  }

  params.push(req.user.id);

  try {
    await pool.execute(
      `UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`,
      params
    );
    res.json({ success: true, message: 'Profile updated successfully' });
  } catch (err) {
    console.error('[User] Profile update error:', err.message);
    return res.status(500).json({ error: 'Failed to update profile' });
  }
});

// PUT /api/user/password — change password
router.put('/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  try {
    const [rows] = await pool.execute(
      'SELECT password_hash FROM users WHERE id = ?',
      [req.user.id]
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    // If user has existing password, verify current one
    if (user.password_hash) {
      if (!currentPassword) {
        return res.status(400).json({ error: 'Current password is required' });
      }
      const match = await bcrypt.compare(currentPassword, user.password_hash);
      if (!match) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, req.user.id]);
    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    console.error('[User] Password change error:', err.message);
    return res.status(500).json({ error: 'Failed to update password' });
  }
});

// DELETE /api/user/account — permanently delete account and all data
router.delete('/account', async (req, res) => {
  const { confirmation } = req.body;
  if (confirmation !== 'DELETE') {
    return res.status(400).json({ error: 'Please type DELETE to confirm account deletion' });
  }

  const userId = req.user.id;
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();
    await conn.execute('DELETE FROM alert_log WHERE user_id = ?', [userId]);
    await conn.execute('DELETE FROM user_alert_preferences WHERE user_id = ?', [userId]);
    await conn.execute('DELETE FROM user_stocks WHERE user_id = ?', [userId]);
    await conn.execute('DELETE FROM users WHERE id = ?', [userId]);
    await conn.commit();
    res.json({ success: true, message: 'Account deleted' });
  } catch (err) {
    await conn.rollback();
    console.error('[User] Account deletion error:', err.message);
    return res.status(500).json({ error: 'Failed to delete account' });
  } finally {
    conn.release();
  }
});

module.exports = router;
