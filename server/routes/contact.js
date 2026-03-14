const express = require('express');
const router = express.Router();
const { sendEmail } = require('../lib/mailer');

router.post('/', async (req, res) => {
  const { name, email, message } = req.body;
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  try {
    await sendEmail({
      to: 'feedback@radarly.in',
      subject: `Feedback from ${name} <${email}>`,
      html: `
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Message:</strong></p>
        <p>${message.replace(/\n/g, '<br>')}</p>
      `,
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[Contact] Failed to send email:', err.message);
    res.status(500).json({ error: 'Failed to send message. Please try again.' });
  }
});

module.exports = router;
