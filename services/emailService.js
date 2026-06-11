const { email: emailConfig } = require('../config');

function buildSubject(lead) {
  return `New Lead: ${lead.name}`;
}

function buildTextBody(lead) {
  const date = lead.created_at ? new Date(lead.created_at).toUTCString() : new Date().toUTCString();
  return [
    `Name:    ${lead.name}`,
    `Email:   ${lead.email}`,
    `Phone:   ${lead.phone || '—'}`,
    `Company: ${lead.company || '—'}`,
    ``,
    `Message:`,
    lead.message,
    ``,
    `Submitted: ${date}`,
    `Source:    ${lead.source || 'website'}`,
  ].join('\n');
}

function buildHtmlBody(lead) {
  const e = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const date = lead.created_at ? new Date(lead.created_at).toUTCString() : new Date().toUTCString();
  return `
<table style="font-family:sans-serif;font-size:14px;color:#111;max-width:560px;border-collapse:collapse">
  <tr><td style="padding:6px 16px 6px 0;font-weight:600;white-space:nowrap">Name</td><td>${e(lead.name)}</td></tr>
  <tr><td style="padding:6px 16px 6px 0;font-weight:600;white-space:nowrap">Email</td><td>${e(lead.email)}</td></tr>
  <tr><td style="padding:6px 16px 6px 0;font-weight:600;white-space:nowrap">Phone</td><td>${e(lead.phone || '—')}</td></tr>
  <tr><td style="padding:6px 16px 6px 0;font-weight:600;white-space:nowrap">Company</td><td>${e(lead.company || '—')}</td></tr>
  <tr><td style="padding:6px 16px 6px 0;font-weight:600;white-space:nowrap">Submitted</td><td>${e(date)}</td></tr>
</table>
<br>
<p style="font-family:sans-serif;font-size:14px;font-weight:600;color:#111;margin:0 0 6px">Message:</p>
<p style="font-family:sans-serif;font-size:14px;color:#333;white-space:pre-wrap;margin:0">${e(lead.message)}</p>
  `.trim();
}

async function sendViaResend(lead) {
  const { Resend } = require('resend');
  const client = new Resend(emailConfig.resendApiKey);
  await client.emails.send({
    from: emailConfig.fromAddress,
    to: emailConfig.leadNotificationEmail,
    subject: buildSubject(lead),
    text: buildTextBody(lead),
    html: buildHtmlBody(lead),
  });
}

async function sendViaSMTP(lead) {
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: emailConfig.smtpHost,
    port: emailConfig.smtpPort,
    secure: emailConfig.smtpPort === 465,
    auth: {
      user: emailConfig.smtpUser,
      pass: emailConfig.smtpPass,
    },
  });
  await transporter.sendMail({
    from: emailConfig.fromAddress,
    to: emailConfig.leadNotificationEmail,
    subject: buildSubject(lead),
    text: buildTextBody(lead),
    html: buildHtmlBody(lead),
  });
}

async function sendLeadNotification(lead) {
  if (!emailConfig.leadNotificationEmail) {
    console.warn('[emailService] LEAD_NOTIFICATION_EMAIL not set — skipping notification');
    return;
  }

  try {
    if (emailConfig.resendApiKey) {
      await sendViaResend(lead);
      return;
    }
    if (emailConfig.smtpHost) {
      await sendViaSMTP(lead);
      return;
    }
    console.warn('[emailService] No email provider configured (set RESEND_API_KEY or SMTP_HOST) — skipping notification');
  } catch (err) {
    // Lead was already saved; don't let email failure affect the HTTP response
    console.error('[emailService] Failed to send lead notification:', err.message);
  }
}

module.exports = { sendLeadNotification };
