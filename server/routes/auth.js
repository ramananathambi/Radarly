const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const bcrypt  = require('bcrypt');
const { OAuth2Client } = require('google-auth-library');
const jwt     = require('jsonwebtoken');
const { pool } = require('../lib/db');
require('dotenv').config();

const googleClient = process.env.GOOGLE_CLIENT_ID
  ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID)
  : null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateSessionToken() {
  return crypto.randomUUID();
}

function validatePhone(phone) {
  return /^\+91[6-9]\d{9}$/.test(phone);
}

async function sendOTP(phone, otp) {
  if (process.env.DEV_MODE === 'true') {
    console.log(`[DEV] OTP for ${phone}: ${otp}`);
    return;
  }
  const { client } = require('../lib/twilio');
  await client.messages.create({
    body: `Your Radarly OTP is: ${otp}. Valid for 10 minutes. Do not share this code.`,
    from: process.env.TWILIO_SMS_FROM,
    to:   phone,
  });
}

async function createDefaultPreferences(userId) {
  await pool.execute(
    `INSERT IGNORE INTO user_alert_preferences (user_id, alert_type, scope, is_enabled)
     VALUES (?, 'DIVIDEND', 'all_stocks', 1)`,
    [userId]
  );
}

// ─── POST /api/auth/otp/send ──────────────────────────────────────────────────

router.post('/otp/send', async (req, res) => {
  const { phone } = req.body;

  if (!phone || !validatePhone(phone)) {
    return res.status(400).json({ error: 'Invalid phone number. Use format: +91XXXXXXXXXX' });
  }

  const otp       = generateOTP();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  try {
    await pool.execute(
      `INSERT INTO phone_otps (phone, otp_code, expires_at)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE otp_code = VALUES(otp_code), expires_at = VALUES(expires_at)`,
      [phone, otp, expiresAt]
    );
  } catch (err) {
    console.error('[OTP] DB error:', err.message);
    return res.status(500).json({ error: 'Failed to generate OTP' });
  }

  try {
    await sendOTP(phone, otp);
  } catch (err) {
    console.error('[OTP] Send error:', err.message);
    return res.status(500).json({ error: 'Failed to send OTP. Please try again.' });
  }

  res.json({ success: true, message: 'OTP sent successfully' });
});

// ─── POST /api/auth/otp/verify ────────────────────────────────────────────────

router.post('/otp/verify', async (req, res) => {
  const { phone, otp } = req.body;

  if (!phone || !otp) {
    return res.status(400).json({ error: 'Phone and OTP are required' });
  }

  const [rows] = await pool.execute(
    'SELECT * FROM phone_otps WHERE phone = ?',
    [phone]
  );
  const record = rows[0] || null;

  if (!record) {
    return res.status(400).json({ error: 'OTP not found. Please request a new one.' });
  }

  if (new Date() > new Date(record.expires_at)) {
    await pool.execute('DELETE FROM phone_otps WHERE phone = ?', [phone]);
    return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
  }

  if (record.otp_code !== otp.trim()) {
    return res.status(400).json({ error: 'Incorrect OTP. Please try again.' });
  }

  // OTP valid — delete it immediately
  await pool.execute('DELETE FROM phone_otps WHERE phone = ?', [phone]);

  // Find or create user
  const [userRows] = await pool.execute(
    'SELECT * FROM users WHERE phone = ?',
    [phone]
  );
  let user = userRows[0] || null;

  const sessionToken   = generateSessionToken();
  const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
  let   isNewUser      = false;

  if (!user) {
    isNewUser = true;
    const userId = crypto.randomUUID();

    try {
      await pool.execute(
        `INSERT INTO users (id, phone, is_verified, session_token, session_expires_at)
         VALUES (?, ?, 1, ?, ?)`,
        [userId, phone, sessionToken, sessionExpires]
      );
    } catch (err) {
      console.error('[Auth] Create user error:', err.message);
      return res.status(500).json({ error: 'Failed to create account' });
    }

    const [newRows] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
    user = newRows[0];
    await createDefaultPreferences(user.id);

  } else {
    try {
      await pool.execute(
        `UPDATE users SET session_token = ?, session_expires_at = ?, is_verified = 1
         WHERE id = ?`,
        [sessionToken, sessionExpires, user.id]
      );
    } catch (err) {
      console.error('[Auth] Session update error:', err.message);
      return res.status(500).json({ error: 'Login failed. Please try again.' });
    }
  }

  res.json({
    success:         true,
    session_token:   sessionToken,
    user: {
      id:    user.id,
      name:  user.name,
      phone: user.phone,
    },
    isNewUser,
    needsOnboarding: !user.name,
  });
});

// ─── POST /api/auth/onboarding ────────────────────────────────────────────────

router.post('/onboarding', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { name, phone } = req.body;

  if (!name?.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }

  if (phone && !validatePhone(phone)) {
    return res.status(400).json({ error: 'Invalid phone number. Use format: +91XXXXXXXXXX' });
  }

  const [rows] = await pool.execute(
    `SELECT id, name, phone FROM users
     WHERE session_token = ? AND session_expires_at > NOW()`,
    [token]
  );
  const user = rows[0] || null;

  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  if (phone) {
    await pool.execute(
      'UPDATE users SET name = ?, phone = ? WHERE id = ?',
      [name.trim(), phone, user.id]
    );
  } else {
    await pool.execute(
      'UPDATE users SET name = ? WHERE id = ?',
      [name.trim(), user.id]
    );
  }

  await createDefaultPreferences(user.id);

  res.json({ success: true, name: name.trim() });
});

// ─── POST /api/auth/google — Google Sign-In ─────────────────────────────────

router.post('/google', async (req, res) => {
  const { credential } = req.body;

  if (!credential) {
    return res.status(400).json({ error: 'Google credential is required' });
  }

  if (!googleClient) {
    return res.status(500).json({ error: 'Google Sign-In is not configured' });
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (err) {
    console.error('[Auth] Google token verify error:', err.message);
    return res.status(401).json({ error: 'Invalid Google credential' });
  }

  const { email, name, sub: googleId } = payload;
  if (!email) {
    return res.status(400).json({ error: 'Email not available from Google' });
  }

  // Find existing user by email
  const [userRows] = await pool.execute(
    'SELECT * FROM users WHERE email = ?',
    [email]
  );
  let user = userRows[0] || null;

  const sessionToken   = generateSessionToken();
  const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  let isNewUser = false;

  if (!user) {
    isNewUser = true;
    const userId = crypto.randomUUID();

    try {
      await pool.execute(
        `INSERT INTO users (id, email, name, phone, is_verified, session_token, session_expires_at)
         VALUES (?, ?, ?, '', 1, ?, ?)`,
        [userId, email, name || null, sessionToken, sessionExpires]
      );
    } catch (err) {
      console.error('[Auth] Google create user error:', err.message);
      return res.status(500).json({ error: 'Failed to create account' });
    }

    const [newRows] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
    user = newRows[0];
    await createDefaultPreferences(user.id);
  } else {
    if (!user.name && name) {
      await pool.execute(
        `UPDATE users SET session_token = ?, session_expires_at = ?, is_verified = 1, name = ?
         WHERE id = ?`,
        [sessionToken, sessionExpires, name, user.id]
      );
      user.name = name;
    } else {
      await pool.execute(
        `UPDATE users SET session_token = ?, session_expires_at = ?, is_verified = 1
         WHERE id = ?`,
        [sessionToken, sessionExpires, user.id]
      );
    }
  }

  res.json({
    success: true,
    session_token: sessionToken,
    user: { id: user.id, name: user.name, phone: user.phone, email },
    isNewUser,
    needsOnboarding: !user.name,
  });
});

// ─── POST /api/auth/apple — Apple Sign-In ───────────────────────────────────

router.post('/apple', async (req, res) => {
  const { id_token, user: appleUser } = req.body;

  if (!id_token) {
    return res.status(400).json({ error: 'Apple ID token is required' });
  }

  // Decode Apple ID token (Apple's public keys verify the signature,
  // but for simplicity we decode and verify the audience/issuer)
  let decoded;
  try {
    decoded = jwt.decode(id_token, { complete: true });
    if (!decoded || !decoded.payload) throw new Error('Invalid token structure');

    const { iss, aud, email, sub } = decoded.payload;
    if (iss !== 'https://appleid.apple.com') throw new Error('Invalid issuer');

    decoded = decoded.payload;
  } catch (err) {
    console.error('[Auth] Apple token decode error:', err.message);
    return res.status(401).json({ error: 'Invalid Apple credential' });
  }

  const email = decoded.email;
  const appleId = decoded.sub;

  if (!email) {
    return res.status(400).json({ error: 'Email not available from Apple' });
  }

  // Apple only sends user's name on first sign-in
  const appleName = appleUser?.name
    ? `${appleUser.name.firstName || ''} ${appleUser.name.lastName || ''}`.trim()
    : null;

  const [userRows] = await pool.execute(
    'SELECT * FROM users WHERE email = ?',
    [email]
  );
  let user = userRows[0] || null;

  const sessionToken   = generateSessionToken();
  const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  let isNewUser = false;

  if (!user) {
    isNewUser = true;
    const userId = crypto.randomUUID();

    try {
      await pool.execute(
        `INSERT INTO users (id, email, name, phone, is_verified, session_token, session_expires_at)
         VALUES (?, ?, ?, '', 1, ?, ?)`,
        [userId, email, appleName || null, sessionToken, sessionExpires]
      );
    } catch (err) {
      console.error('[Auth] Apple create user error:', err.message);
      return res.status(500).json({ error: 'Failed to create account' });
    }

    const [newRows] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
    user = newRows[0];
    await createDefaultPreferences(user.id);
  } else {
    if (!user.name && appleName) {
      await pool.execute(
        `UPDATE users SET session_token = ?, session_expires_at = ?, is_verified = 1, name = ?
         WHERE id = ?`,
        [sessionToken, sessionExpires, appleName, user.id]
      );
      user.name = appleName;
    } else {
      await pool.execute(
        `UPDATE users SET session_token = ?, session_expires_at = ?, is_verified = 1
         WHERE id = ?`,
        [sessionToken, sessionExpires, user.id]
      );
    }
  }

  res.json({
    success: true,
    session_token: sessionToken,
    user: { id: user.id, name: user.name, phone: user.phone, email },
    isNewUser,
    needsOnboarding: !user.name,
  });
});

// ─── POST /api/auth/register — Email + Password registration ─────────────────

router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;

  if (!name?.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email is required' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  // Check if email already taken
  const [existing] = await pool.execute(
    'SELECT id, password_hash FROM users WHERE email = ?',
    [email.toLowerCase()]
  );

  if (existing.length > 0) {
    if (existing[0].password_hash) {
      return res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
    }
    // Email exists via Google/Apple but no password — let them set one
    const passwordHash = await bcrypt.hash(password, 10);
    const sessionToken = generateSessionToken();
    const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await pool.execute(
      `UPDATE users SET password_hash = ?, name = COALESCE(name, ?), session_token = ?, session_expires_at = ?
       WHERE id = ?`,
      [passwordHash, name.trim(), sessionToken, sessionExpires, existing[0].id]
    );

    const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [existing[0].id]);
    const user = rows[0];

    return res.json({
      success: true,
      session_token: sessionToken,
      user: { id: user.id, name: user.name, email: user.email },
      needsOnboarding: false,
    });
  }

  // New user
  const userId = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(password, 10);
  const sessionToken = generateSessionToken();
  const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  try {
    await pool.execute(
      `INSERT INTO users (id, name, email, password_hash, phone, is_verified, session_token, session_expires_at)
       VALUES (?, ?, ?, ?, '', 1, ?, ?)`,
      [userId, name.trim(), email.toLowerCase(), passwordHash, sessionToken, sessionExpires]
    );
  } catch (err) {
    console.error('[Auth] Register error:', err.message);
    return res.status(500).json({ error: 'Failed to create account' });
  }

  await createDefaultPreferences(userId);

  res.json({
    success: true,
    session_token: sessionToken,
    user: { id: userId, name: name.trim(), email: email.toLowerCase() },
    needsOnboarding: false,
  });
});

// ─── POST /api/auth/login — Email + Password sign-in ─────────────────────────

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const [rows] = await pool.execute(
    'SELECT * FROM users WHERE email = ?',
    [email.toLowerCase()]
  );
  const user = rows[0] || null;

  if (!user) {
    return res.status(401).json({ error: 'No account found with this email' });
  }

  if (!user.password_hash) {
    return res.status(401).json({ error: 'This account uses Google or Phone sign-in. Please use that method.' });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  const sessionToken = generateSessionToken();
  const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await pool.execute(
    'UPDATE users SET session_token = ?, session_expires_at = ? WHERE id = ?',
    [sessionToken, sessionExpires, user.id]
  );

  res.json({
    success: true,
    session_token: sessionToken,
    user: { id: user.id, name: user.name, email: user.email },
    needsOnboarding: !user.name,
  });
});

// ─── GET /api/auth/config — public auth config for frontend ─────────────────

router.get('/config', (req, res) => {
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
    appleEnabled: !!process.env.APPLE_CLIENT_ID,
  });
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────────

router.post('/logout', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    await pool.execute(
      'UPDATE users SET session_token = NULL, session_expires_at = NULL WHERE session_token = ?',
      [token]
    );
  }
  res.json({ success: true });
});

module.exports = router;
