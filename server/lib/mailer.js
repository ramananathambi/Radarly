const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendEmail({ to, subject, html, attachments }) {
  if (process.env.DEV_MODE === 'true') {
    console.log(`[DEV] Email to ${to} | Subject: ${subject}`);
    return;
  }
  await transporter.sendMail({
    from: process.env.SMTP_FROM || `"Radarly" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html,
    ...(attachments ? { attachments } : {}),
  });
}

module.exports = { sendEmail };
