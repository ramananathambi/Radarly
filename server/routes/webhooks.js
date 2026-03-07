const express = require('express');
const router  = express.Router();
const { pool } = require('../lib/db');

/**
 * POST /api/webhooks/twilio
 * Handles inbound WhatsApp messages from Twilio.
 * If user replies STOP, disable all their alert preferences.
 *
 * Twilio sends form-encoded body with:
 *   From: whatsapp:+91XXXXXXXXXX
 *   Body: STOP
 */
router.post('/twilio', async (req, res) => {
  const from = req.body?.From || '';
  const body = (req.body?.Body || '').trim().toUpperCase();

  // Extract phone number — Twilio sends "whatsapp:+91XXXXXXXXXX"
  const phone = from.replace('whatsapp:', '').trim();

  console.log(`[Webhook] Inbound from ${phone}: "${body}"`);

  if (!phone) {
    return res.status(400).send('<Response></Response>');
  }

  if (body === 'STOP') {
    try {
      // Find user by phone
      const [rows] = await pool.execute(
        'SELECT id, name FROM users WHERE phone = ?',
        [phone]
      );
      const user = rows[0] || null;

      if (user) {
        // Disable all alert preferences for this user
        await pool.execute(
          `UPDATE user_alert_preferences SET is_enabled = 0, updated_at = NOW()
           WHERE user_id = ?`,
          [user.id]
        );
        console.log(`[Webhook] Unsubscribed ${phone} (user: ${user.name || user.id})`);
      } else {
        console.log(`[Webhook] STOP from unknown phone: ${phone}`);
      }
    } catch (err) {
      console.error(`[Webhook] Failed to unsubscribe ${phone}:`, err.message);
    }

    // Twilio expects TwiML response — send empty response to acknowledge
    res.set('Content-Type', 'text/xml');
    return res.send('<Response></Response>');
  }

  // For any other message, just acknowledge
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');
});

module.exports = router;
