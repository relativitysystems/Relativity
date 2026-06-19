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

// ─────────────────────────────────────────────
// Team invite email
// ─────────────────────────────────────────────

function buildInviteSubject(companyName) {
  return `You've been invited to join ${companyName} on Relativity Systems`;
}

function buildInviteHtml({ companyName, inviterName, role, acceptUrl }) {
  const e = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
  return `
<div style="font-family:sans-serif;font-size:15px;color:#111;max-width:520px">
  <p style="margin:0 0 16px">
    <strong>${e(inviterName)}</strong> has invited you to join
    <strong>${e(companyName)}</strong> on Relativity Systems as a <strong>${e(roleLabel)}</strong>.
  </p>
  <p style="margin:0 0 24px">
    Click the button below to accept your invitation and set up your account.
    This link expires in 7 days.
  </p>
  <a href="${e(acceptUrl)}"
     style="display:inline-block;padding:12px 24px;background:#FF6B2B;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">
    Accept Invitation
  </a>
  <p style="margin:24px 0 0;font-size:13px;color:#666">
    If you weren't expecting this invitation you can safely ignore this email.
  </p>
</div>
  `.trim();
}

function buildInviteText({ companyName, inviterName, role, acceptUrl }) {
  return [
    `${inviterName} has invited you to join ${companyName} on Relativity Systems as a ${role}.`,
    ``,
    `Accept your invitation here (link expires in 7 days):`,
    acceptUrl,
    ``,
    `If you weren't expecting this, you can safely ignore this email.`,
  ].join('\n');
}

async function sendTeamInviteEmail({ toEmail, companyName, inviterName, role, acceptUrl }) {
  const subject = buildInviteSubject(companyName);
  const html = buildInviteHtml({ companyName, inviterName, role, acceptUrl });
  const text = buildInviteText({ companyName, inviterName, role, acceptUrl });

  try {
    if (emailConfig.resendApiKey) {
      const { Resend } = require('resend');
      const client = new Resend(emailConfig.resendApiKey);
      const result = await client.emails.send({ from: emailConfig.fromAddress, to: toEmail, subject, text, html });
      console.log('[emailService] Team invite email sent via Resend:', result?.data?.id || result?.id || result);
      return;
    }
    if (emailConfig.smtpHost) {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: emailConfig.smtpHost,
        port: emailConfig.smtpPort,
        secure: emailConfig.smtpPort === 465,
        auth: { user: emailConfig.smtpUser, pass: emailConfig.smtpPass },
      });
      await transporter.sendMail({ from: emailConfig.fromAddress, to: toEmail, subject, text, html });
      return;
    }
    throw new Error('No email provider configured for team invite email. Set RESEND_API_KEY or SMTP_HOST.');
  } catch (err) {
    console.error('[emailService] Failed to send team invite email:', err.message);
    throw err;
  }
}

module.exports = { sendLeadNotification, sendTeamInviteEmail };
