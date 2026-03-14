const express = require('express');
const router = express.Router();
const multer = require('multer');
const { sendEmail } = require('../lib/mailer');

// Store uploads in memory (no disk writes), max 5MB per file
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed.'));
  },
});

router.post('/', upload.single('attachment'), async (req, res) => {
  const { name, email, message } = req.body;
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  try {
    const mailOptions = {
      to: 'feedback@radarly.in',
      subject: `Feedback from ${name} <${email}>`,
      html: `
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Message:</strong></p>
        <p>${message.replace(/\n/g, '<br>')}</p>
      `,
    };

    if (req.file) {
      mailOptions.attachments = [{
        filename: req.file.originalname,
        content: req.file.buffer,
        contentType: req.file.mimetype,
      }];
    }

    await sendEmail(mailOptions);
    res.json({ success: true });
  } catch (err) {
    console.error('[Contact] Failed to send email:', err.message);
    res.status(500).json({ error: 'Failed to send message. Please try again.' });
  }
});

module.exports = router;
