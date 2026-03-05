const express        = require('express');
const router         = express.Router();
const { supabaseAdmin } = require('../lib/supabase');

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
    // Find user by phone
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('id, name')
      .eq('phone', phone)
      .maybeSingle();

    if (user) {
      // Disable all alert preferences for this user
      const { error } = await supabaseAdmin
        .from('user_alert_preferences')
        .update({ is_enabled: false, updated_at: new Date().toISOString() })
        .eq('user_id', user.id);

      if (error) {
        console.error(`[Webhook] Failed to unsubscribe ${phone}:`, error.message);
      } else {
        console.log(`[Webhook] Unsubscribed ${phone} (user: ${user.name || user.id})`);
      }
    } else {
      console.log(`[Webhook] STOP from unknown phone: ${phone}`);
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
