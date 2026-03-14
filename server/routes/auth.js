const express = require('express');
const router  = express.Router();
const { pool } = require('../lib/db');
const { requireAuth } = require('../middleware/auth');
require('dotenv').config();

// ─── Helper: create default alert preferences for new users ──────────────────

async function createDefaultPreferences(userId) {
  const [activeTypes] = await pool.execute(
    'SELECT code FROM alert_types WHERE is_active = 1'
  );
  for (const { code } of activeTypes) {
    await pool.execute(
      `INSERT IGNORE INTO user_alert_preferences (user_id, alert_type, scope, is_enabled)
       VALUES (?, ?, 'all_stocks', 1)`,
      [userId, code]
    );
  }
}

// ─── POST /api/auth/sync ──────────────────────────────────────────────────────
// Called from frontend after any Supabase login (phone OTP, Google, Apple).
// Validates the Supabase token, creates/syncs the MySQL user record,
// and returns needsOnboarding so the frontend can redirect appropriately.

router.post('/sync', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  // Validate with Supabase
  let supaUser;
  try {
    const supaResp = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: process.env.SUPABASE_ANON_KEY,
      },
    });
    if (!supaResp.ok) return res.status(401).json({ error: 'Invalid token' });
    supaUser = await supaResp.json();
  } catch (err) {
    console.error('[Sync] Supabase validation error:', err.message);
    return res.status(500).json({ error: 'Auth validation failed' });
  }

  const supaId = supaUser.id;
  const phone  = supaUser.phone  || '';
  const email  = supaUser.email  || null;

  // Find or create MySQL user (Supabase UUID is the primary key)
  try {
    const [rows] = await pool.execute(
      'SELECT id, name, phone, email FROM users WHERE id = ?',
      [supaId]
    );

    let user = rows[0] || null;

    if (!user) {
      // New user — create MySQL record using Supabase UUID as id
      await pool.execute(
        `INSERT INTO users (id, phone, email, is_verified) VALUES (?, ?, ?, 1)`,
        [supaId, phone, email]
      );
      const [newRows] = await pool.execute(
        'SELECT id, name, phone, email FROM users WHERE id = ?',
        [supaId]
      );
      user = newRows[0];
      await createDefaultPreferences(supaId);
    } else {
      // Existing user — update phone/email if newly available from Supabase
      const updates = [];
      const values  = [];
      if (phone && !user.phone) { updates.push('phone = ?'); values.push(phone); }
      if (email && !user.email) { updates.push('email = ?'); values.push(email); }
      if (updates.length) {
        values.push(supaId);
        await pool.execute(
          `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
          values
        );
        if (phone && !user.phone) user.phone = phone;
        if (email && !user.email) user.email = email;
      }
    }

    res.json({
      success:         true,
      user:            { id: user.id, name: user.name, phone: user.phone, email: user.email },
      needsOnboarding: !user.name,
    });
  } catch (err) {
    console.error('[Sync] DB error:', err.message);
    return res.status(500).json({ error: 'Failed to sync user account' });
  }
});

// ─── POST /api/auth/onboarding ────────────────────────────────────────────────

router.post('/onboarding', requireAuth, async (req, res) => {
  const { name, phone } = req.body;
  const userId = req.user.id;

  if (!name?.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }

  try {
    if (phone) {
      await pool.execute(
        'UPDATE users SET name = ?, phone = ? WHERE id = ?',
        [name.trim(), phone, userId]
      );
    } else {
      await pool.execute(
        'UPDATE users SET name = ? WHERE id = ?',
        [name.trim(), userId]
      );
    }
    await createDefaultPreferences(userId);
    res.json({ success: true, name: name.trim() });
  } catch (err) {
    console.error('[Onboarding] DB error:', err.message);
    return res.status(500).json({ error: 'Failed to save name' });
  }
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────────
// Supabase handles session invalidation on the client side.
// This endpoint exists for compatibility; frontend also calls _supa.auth.signOut().

router.post('/logout', (req, res) => {
  res.json({ success: true });
});

module.exports = router;
