'use strict';
/* Sends the account emails (recovery codes, "your password changed"). Switched on by one env var:
 *   SMTP_URL   e.g. smtps://USER:PASSWORD@smtp-relay.brevo.com:465   (any SMTP provider: Brevo, Gmail app password, Resend, Mailgun ...)
 *   MAIL_FROM  e.g. Daymap <you@example.com>   (the address your provider lets you send from; defaults to the SMTP user name)
 * Without SMTP_URL email recovery is simply off and the site says nothing about it. */
const SITE = 'Daymap';

function fromEnv(env = process.env) {
  if (!env.SMTP_URL) return null;
  let tx, from;
  try {
    const nodemailer = require('nodemailer');
    tx = nodemailer.createTransport(env.SMTP_URL, { connectionTimeout: 10e3, greetingTimeout: 10e3, socketTimeout: 15e3 });
    from = env.MAIL_FROM || decodeURIComponent(new URL(env.SMTP_URL).username || '');
  } catch (e) { console.warn('SMTP_URL is set but email could not start:', e.message); return null; }
  if (!from) { console.warn('SMTP_URL is set but MAIL_FROM is missing: email recovery stays off.'); return null; }
  return { async send(m) { await tx.sendMail({ from, to: m.to, subject: m.subject, text: m.text, html: m.html }); } };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const shell = (title, inner) => `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1530"><h2 style="margin:0 0 12px">${esc(title)}</h2>${inner}<p style="color:#6b6788;font-size:13px;margin-top:24px">${SITE}</p></div>`;

/** accounts: [{ username, code }]. One email can carry several accounts when they share an address. */
function recoveryEmail(accounts, minutes) {
  const lines = accounts.map((a) => `Username: ${a.username}\nCode: ${a.code}`).join('\n\n');
  const text = `Someone asked to recover ${accounts.length > 1 ? 'these accounts' : 'an account'} on ${SITE}.\n\n${lines}\n\nEnter the username and code on the site to set a new password. The code works for ${minutes} minutes.\n\nIf this was not you, ignore this email: nothing changes unless the code is used.`;
  const rows = accounts.map((a) => `<p style="margin:14px 0 4px;font-size:14px">Username: <b>${esc(a.username)}</b></p><p style="margin:0;font-size:32px;letter-spacing:6px;font-weight:800">${esc(a.code)}</p>`).join('');
  const html = shell('Your recovery code', `<p>Someone asked to recover ${accounts.length > 1 ? 'these accounts' : 'an account'} on ${SITE}. Enter the username and code on the site to set a new password.</p>${rows}<p style="font-size:14px">The code works for ${minutes} minutes.</p><p style="font-size:14px;color:#6b6788">If this was not you, ignore this email. Nothing changes unless the code is used.</p>`);
  return { subject: `${SITE}: your recovery code`, text, html };
}

function changedEmail(username) {
  const text = `The password for "${username}" on ${SITE} was just changed using an emailed recovery code.\n\nIf that was you, there is nothing to do. If it was not, reply to the person who runs the game and request a recovery again right away.`;
  return { subject: `${SITE}: your password was changed`, text, html: shell('Your password was changed', `<p>The password for <b>${esc(username)}</b> on ${SITE} was just changed using an emailed recovery code.</p><p style="font-size:14px">If that was you, there is nothing to do. If it was not, tell the person who runs the game.</p>`) };
}

module.exports = { fromEnv, recoveryEmail, changedEmail };
