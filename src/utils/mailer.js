/**
 * Vienkāršs e-pasta nosūtītājs, izmantojot SMTP (nodemailer).
 *
 * SVARĪGI: šis darbosies TIKAI tad, kad .env failā (vai Render Environment
 * Variables) būs norādīti SMTP_* mainīgie. Kamēr tie nav iestatīti, e-pasti
 * NETIEK nosūtīti, bet KĻŪDA netiek mesta -- pieprasījums tik un tā tiek
 * saglabāts "access_requests" tabulā un redzams admin panelī, tāpēc nekas
 * nepazūd, ja e-pasts vēl nav konfigurēts.
 *
 * Bezmaksas SMTP iespējas (izvēlieties vienu):
 *  - Gmail/Google Workspace: SMTP_HOST=smtp.gmail.com, SMTP_PORT=465,
 *    SMTP_USER=<jūsu-adrese>, SMTP_PASS=<lietotnes parole, nevis parastā>
 *  - Brevo (bijušais Sendinblue): bezmaksas 300 e-pasti/dienā, smtp-relay.brevo.com
 *  - Resend.com: bezmaksas līmenis, smtp.resend.com
 */

const nodemailer = require('nodemailer');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

async function sendAccessRequestEmail(identifier, displayName) {
  const t = getTransporter();
  const notifyTo = process.env.IT_ADMIN_NOTIFY_EMAIL || 'it@otankimill.eu';
  if (!t) {
    console.log(`[mailer] SMTP nav konfigurēts -- e-pasts par piekļuves pieprasījumu (${identifier}) NETIKA nosūtīts, bet ir saglabāts admin panelī.`);
    return false;
  }
  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: notifyTo,
      subject: `IT Helpdesk: piekļuves pieprasījums no ${identifier}`,
      text: `Lietotājs ar identifikatoru "${identifier}"${displayName ? ` (${displayName})` : ''} mēģināja pieteikties IT Helpdesk sistēmā, bet nav reģistrēts.\n\nApmeklējiet admin paneli, sadaļu "Piekļuves pieprasījumi", lai izveidotu kontu vai ignorētu pieprasījumu.`,
    });
    return true;
  } catch (err) {
    console.error('[mailer] Neizdevās nosūtīt e-pastu:', err.message);
    return false;
  }
}

/**
 * Vispārīgs e-pasta sūtītājs (izmanto pikšķerēšanas simulācijas kampaņas).
 * Atgriež true, ja e-pasts reāli nosūtīts; false, ja SMTP nav konfigurēts
 * vai sūtīšana neizdevās — izsaucējs pats izlemj, ko darīt tālāk.
 *
 * @param {{to:string, subject:string, html:string, text?:string, fromName?:string}} opts
 */
async function sendMail(opts) {
  const t = getTransporter();
  if (!t) {
    console.log(`[mailer] SMTP nav konfigurēts — e-pasts uz ${opts.to} ("${opts.subject}") NETIKA nosūtīts.`);
    return false;
  }
  try {
    const fromAddr = process.env.SMTP_FROM || process.env.SMTP_USER;
    const from = opts.fromName ? `"${opts.fromName}" <${fromAddr}>` : fromAddr;
    await t.sendMail({
      from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    });
    return true;
  } catch (err) {
    console.error('[mailer] Neizdevās nosūtīt e-pastu:', err.message);
    return false;
  }
}

module.exports = { sendAccessRequestEmail, sendMail };
