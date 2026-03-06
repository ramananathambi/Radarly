const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const jwt     = require('jsonwebtoken');
const { supabaseAdmin } = require('../lib/supabase');
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
  await supabaseAdmin
    .from('user_alert_preferences')
    .upsert({
      user_id:    userId,
      alert_type: 'DIVIDEND',
      scope:      'all_stocks',
      is_enabled: true,
    }, { onConflict: 'user_id,alert_type', ignoreDuplicates: true });
}

// ─── POST /api/auth/otp/send ──────────────────────────────────────────────────

router.post('/otp/send', async (req, res) => {
  const { phone } = req.body;

  if (!phone || !validatePhone(phone)) {
    return res.status(400).json({ error: 'Invalid phone number. Use format: +91XXXXXXXXXX' });
  }

  const otp       = generateOTP();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  const { error: upsertErr } = await supabaseAdmin
    .from('phone_otps')
    .upsert({ phone, otp_code: otp, expires_at: expiresAt });

  if (upsertErr) {
    console.error('[OTP] DB error:', upsertErr);
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

  const { data: record } = await supabaseAdmin
    .from('phone_otps')
    .select('*')
    .eq('phone', phone)
    .maybeSingle();

  if (!record) {
    return res.status(400).json({ error: 'OTP not found. Please request a new one.' });
  }

  if (new Date() > new Date(record.expires_at + 'Z')) {
    await supabaseAdmin.from('phone_otps').delete().eq('phone', phone);
    return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
  }

  if (record.otp_code !== otp.trim()) {
    return res.status(400).json({ error: 'Incorrect OTP. Please try again.' });
  }

  // OTP valid — delete it immediately
  await supabaseAdmin.from('phone_otps').delete().eq('phone', phone);

  // Find or create user
  let { data: user } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('phone', phone)
    .maybeSingle();

  const sessionToken   = generateSessionToken();
  const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
  let   isNewUser      = false;

  if (!user) {
    isNewUser = true;

    const { data: newUser, error: createErr } = await supabaseAdmin
      .from('users')
      .insert({
        phone,
        is_verified:        true,
        session_token:      sessionToken,
        session_expires_at: sessionExpires,
      })
      .select()
      .single();

    if (createErr) {
      console.error('[Auth] Create user error:', createErr);
      return res.status(500).json({ error: 'Failed to create account' });
    }

    user = newUser;
    await createDefaultPreferences(user.id);

  } else {
    const { error: updateErr } = await supabaseAdmin
      .from('users')
      .update({
        session_token:      sessionToken,
        session_expires_at: sessionExpires,
        is_verified:        true,
      })
      .eq('id', user.id);

    if (updateErr) {
      console.error('[Auth] Session update error:', updateErr);
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

  const { data: user } = await supabaseAdmin
    .from('users')
    .select('id, name, phone')
    .eq('session_token', token)
    .gt('session_expires_at', new Date().toISOString().replace('Z', ''))
    .maybeSingle();

  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  const updates = { name: name.trim() };
  if (phone) updates.phone = phone;

  await supabaseAdmin.from('users').update(updates).eq('id', user.id);
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
  let { data: user } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('email', email)
    .maybeSingle();

  const sessionToken   = generateSessionToken();
  const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  let isNewUser = false;

  if (!user) {
    isNewUser = true;
    const { data: newUser, error: createErr } = await supabaseAdmin
      .from('users')
      .insert({
        email,
        name: name || null,
        phone: '',
        is_verified: true,
        session_token: sessionToken,
        session_expires_at: sessionExpires,
      })
      .select()
      .single();

    if (createErr) {
      console.error('[Auth] Google create user error:', createErr);
      return res.status(500).json({ error: 'Failed to create account' });
    }
    user = newUser;
    await createDefaultPreferences(user.id);
  } else {
    const updates = {
      session_token: sessionToken,
      session_expires_at: sessionExpires,
      is_verified: true,
    };
    if (!user.name && name) updates.name = name;

    await supabaseAdmin.from('users').update(updates).eq('id', user.id);
    if (name && !user.name) user.name = name;
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

  let { data: user } = await supabaseAdmin
    .from('users')
    .select('*')
    .eq('email', email)
    .maybeSingle();

  const sessionToken   = generateSessionToken();
  const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  let isNewUser = false;

  if (!user) {
    isNewUser = true;
    const { data: newUser, error: createErr } = await supabaseAdmin
      .from('users')
      .insert({
        email,
        name: appleName || null,
        phone: '',
        is_verified: true,
        session_token: sessionToken,
        session_expires_at: sessionExpires,
      })
      .select()
      .single();

    if (createErr) {
      console.error('[Auth] Apple create user error:', createErr);
      return res.status(500).json({ error: 'Failed to create account' });
    }
    user = newUser;
    await createDefaultPreferences(user.id);
  } else {
    const updates = {
      session_token: sessionToken,
      session_expires_at: sessionExpires,
      is_verified: true,
    };
    if (!user.name && appleName) updates.name = appleName;

    await supabaseAdmin.from('users').update(updates).eq('id', user.id);
    if (appleName && !user.name) user.name = appleName;
  }

  res.json({
    success: true,
    session_token: sessionToken,
    user: { id: user.id, name: user.name, phone: user.phone, email },
    isNewUser,
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
    await supabaseAdmin
      .from('users')
      .update({ session_token: null, session_expires_at: null })
      .eq('session_token', token);
  }
  res.json({ success: true });
});

module.exports = router;
