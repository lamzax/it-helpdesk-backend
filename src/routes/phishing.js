// ============================================================
// KIBERDROŠĪBA — pikšķerēšanas simulācija (iekšējs drošības apmācību rīks).
//
// AIZSARGPASĀKUMI (skat. HANDOFF 2.2 p.13) — OBLIGĀTI saglabāt:
//  - Pieejams TIKAI Owner/Admin.
//  - Mērķis ir paša uzņēmuma darbinieki (reģistrēti lietotāji), izglītošanas nolūkā.
//  - NEKĀDU paroļu/datu vākšanas. Izsekošana reģistrē tikai atvēršanu/klikšķi.
//  - Pēc klikšķa lietotājs uzreiz nonāk izglītojošā "šī bija simulācija" lapā.
//
// Divi maršruti eksportēti:
//  - router        → /api/phishing        (requireAuth + owner/admin)
//  - publicRouter  → /api/phishing-track  (PUBLISKS, bez auth: pikselis + klikšķa lapa)
// ============================================================

const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendMail } = require('../utils/mailer');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('owner', 'admin'));

const publicRouter = express.Router();

const csvEscape = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

// ============================================================
// KAMPAŅAS (owner/admin)
// ============================================================

// GET /api/phishing/campaigns — visas kampaņas ar īsu statistiku
router.get('/campaigns', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.name, c.subject, c.sender_name, c.status, c.created_at, c.sent_at,
              (SELECT COUNT(*) FROM phishing_campaign_targets t WHERE t.campaign_id = c.id) AS total,
              (SELECT COUNT(*) FROM phishing_campaign_targets t WHERE t.campaign_id = c.id AND t.opened_at IS NOT NULL) AS opened,
              (SELECT COUNT(*) FROM phishing_campaign_targets t WHERE t.campaign_id = c.id AND t.clicked_at IS NOT NULL) AS clicked
       FROM phishing_campaigns c
       ORDER BY c.created_at DESC`
    );
    res.json({ campaigns: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/phishing/campaigns — izveido melnrakstu ar mērķiem
// Body: { name, subject, bodyHtml, senderName, userIds: [...] }
router.post('/campaigns', async (req, res) => {
  const { name, subject, bodyHtml, senderName, userIds } = req.body;
  if (!name || !subject || !bodyHtml) return res.status(400).json({ error: 'Nepieciešams nosaukums, temats un e-pasta saturs' });
  if (!Array.isArray(userIds) || userIds.length === 0) return res.status(400).json({ error: 'Izvēlieties vismaz vienu darbinieku' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const campRes = await client.query(
      `INSERT INTO phishing_campaigns (name, subject, body_html, sender_name, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, subject, bodyHtml, senderName || null, req.user.id]
    );
    const campaign = campRes.rows[0];
    for (const userId of userIds) {
      const token = crypto.randomBytes(24).toString('hex');
      await client.query(
        `INSERT INTO phishing_campaign_targets (campaign_id, user_id, token) VALUES ($1,$2,$3)`,
        [campaign.id, userId, token]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ campaign });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/phishing/campaigns/:id/send — izsūta simulācijas e-pastus
router.post('/campaigns/:id/send', async (req, res) => {
  try {
    const campRes = await pool.query('SELECT * FROM phishing_campaigns WHERE id = $1', [req.params.id]);
    if (campRes.rows.length === 0) return res.status(404).json({ error: 'Kampaņa nav atrasta' });
    const campaign = campRes.rows[0];
    if (campaign.status === 'sent') return res.status(400).json({ error: 'Kampaņa jau nosūtīta' });

    const targets = await pool.query(
      `SELECT t.id, t.token, u.display_name, u.email
       FROM phishing_campaign_targets t
       JOIN users u ON u.id = t.user_id
       WHERE t.campaign_id = $1`,
      [req.params.id]
    );

    await pool.query('UPDATE phishing_campaigns SET status = $1 WHERE id = $2', ['sending', req.params.id]);

    const base = baseUrl(req);
    let sentCount = 0;
    let skipped = 0;
    for (const t of targets.rows) {
      if (!t.email) { skipped++; continue; } // bez e-pasta nevaram nosūtīt
      const clickLink = `${base}/api/phishing-track/${t.token}/click`;
      const pixel = `<img src="${base}/api/phishing-track/${t.token}/open" width="1" height="1" style="display:none" alt="" />`;
      const html = campaign.body_html
        .replace(/\{\{LINK\}\}/g, clickLink)
        .replace(/\{\{NAME\}\}/g, t.display_name || '') + pixel;

      const ok = await sendMail({
        to: t.email,
        subject: campaign.subject,
        html,
        fromName: campaign.sender_name || undefined,
      });
      if (ok) {
        sentCount++;
        await pool.query('UPDATE phishing_campaign_targets SET sent_at = now() WHERE id = $1', [t.id]);
      }
    }

    await pool.query('UPDATE phishing_campaigns SET status = $1, sent_at = now() WHERE id = $2', ['sent', req.params.id]);

    const smtpOk = sentCount > 0;
    res.json({
      success: true,
      sent: sentCount,
      skipped,
      total: targets.rows.length,
      note: smtpOk
        ? undefined
        : 'SMTP nav konfigurēts — e-pasti netika reāli nosūtīti. Konfigurējiet SMTP_* mainīgos Render vidē. Kampaņa un mērķi ir saglabāti.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/phishing/campaigns/:id/stats — per-lietotāja statistika
router.get('/campaigns/:id/stats', async (req, res) => {
  try {
    const campRes = await pool.query('SELECT id, name, subject, status, sent_at FROM phishing_campaigns WHERE id = $1', [req.params.id]);
    if (campRes.rows.length === 0) return res.status(404).json({ error: 'Kampaņa nav atrasta' });
    const targets = await pool.query(
      `SELECT u.display_name, u.email, u.phone, t.sent_at, t.opened_at, t.clicked_at
       FROM phishing_campaign_targets t
       JOIN users u ON u.id = t.user_id
       WHERE t.campaign_id = $1
       ORDER BY u.display_name`,
      [req.params.id]
    );
    const total = targets.rows.length;
    const opened = targets.rows.filter((r) => r.opened_at).length;
    const clicked = targets.rows.filter((r) => r.clicked_at).length;
    res.json({ campaign: campRes.rows[0], summary: { total, opened, clicked }, targets: targets.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/phishing/campaigns/:id/export — CSV
router.get('/campaigns/:id/export', async (req, res) => {
  try {
    const targets = await pool.query(
      `SELECT u.display_name, u.email, u.phone, t.sent_at, t.opened_at, t.clicked_at
       FROM phishing_campaign_targets t
       JOIN users u ON u.id = t.user_id
       WHERE t.campaign_id = $1
       ORDER BY u.display_name`,
      [req.params.id]
    );
    const columns = ['Vārds', 'E-pasts', 'Telefons', 'Nosūtīts', 'Atvēra', 'Uzklikšķināja'];
    const fmt = (d) => (d ? new Date(d).toLocaleString('lv-LV') : '');
    const data = targets.rows.map((r) => [
      r.display_name, r.email, r.phone, fmt(r.sent_at), fmt(r.opened_at), fmt(r.clicked_at),
    ]);
    const csv = [columns.map(csvEscape).join(','), ...data.map((r) => r.map(csvEscape).join(','))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="pikskeresanas_statistika.csv"');
    res.send('﻿' + csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/phishing/campaigns/:id
router.delete('/campaigns/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM phishing_campaigns WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Kampaņa nav atrasta' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PUBLISKĀ IZSEKOŠANA (bez auth) — /api/phishing-track/:token/...
// ============================================================

// 1x1 caurspīdīgs GIF pikselis (e-pasta atvēršanas reģistrēšana)
const TRANSPARENT_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

publicRouter.get('/:token/open', async (req, res) => {
  try {
    await pool.query(
      'UPDATE phishing_campaign_targets SET opened_at = COALESCE(opened_at, now()) WHERE token = $1',
      [req.params.token]
    );
  } catch (err) {
    console.error('[phishing-track open]', err.message);
  }
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.end(TRANSPARENT_GIF);
});

publicRouter.get('/:token/click', async (req, res) => {
  let displayName = '';
  try {
    const r = await pool.query(
      `UPDATE phishing_campaign_targets
       SET clicked_at = COALESCE(clicked_at, now()), opened_at = COALESCE(opened_at, now())
       WHERE token = $1
       RETURNING user_id`,
      [req.params.token]
    );
    if (r.rows.length > 0) {
      const u = await pool.query('SELECT display_name FROM users WHERE id = $1', [r.rows[0].user_id]);
      displayName = u.rows[0]?.display_name || '';
    }
  } catch (err) {
    console.error('[phishing-track click]', err.message);
  }

  // Izglītojošā "šī bija simulācija" lapa — NEKĀDU datu vākšanas.
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="lv"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Drošības apmācība — Otanku Dzirnavnieks</title>
<style>
  body { margin:0; font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif; background:#f5f6f8; color:#222; }
  .wrap { max-width:600px; margin:60px auto; background:#fff; border-radius:14px; padding:40px; box-shadow:0 2px 16px rgba(0,0,0,0.08); }
  .badge { display:inline-block; background:#131f6b; color:#fff; font-size:12px; font-weight:700; padding:5px 12px; border-radius:20px; letter-spacing:0.4px; }
  h1 { color:#131f6b; font-size:24px; margin:16px 0 8px; }
  .lead { font-size:16px; color:#444; }
  ul { line-height:1.7; color:#333; }
  .tip { background:#fbf6e8; border-left:4px solid #c9971f; padding:14px 16px; border-radius:8px; margin-top:20px; font-size:14px; }
  .foot { margin-top:28px; font-size:12px; color:#888; }
</style></head>
<body><div class="wrap">
  <span class="badge">DROŠĪBAS APMĀCĪBA</span>
  <h1>Šis bija pikšķerēšanas tests 🛡️</h1>
  <p class="lead">${displayName ? esc(displayName) + ', š' : 'Š'}is e-pasts bija <b>simulācija</b>, ko veica jūsu uzņēmuma IT nodaļa, lai palīdzētu iemācīties atpazīt pikšķerēšanas mēģinājumus. <b>Nekādi jūsu dati netika savākti</b>, un nekas slikts nav noticis.</p>
  <p>Reālā uzbrukumā šis klikšķis būtu varējis novest pie paroles nozagšanas vai ļaunatūras. Lūk, kā turpmāk pasargāt sevi:</p>
  <ul>
    <li>Pārbaudiet sūtītāja e-pasta adresi — vai domēns tiešām atbilst uzņēmumam?</li>
    <li>Neuzticieties steidzinājumam un draudiem ("konts tiks bloķēts!").</li>
    <li>Pirms klikšķa novietojiet peli virs saites un pārbaudiet reālo adresi.</li>
    <li>Ja šaubāties — jautājiet IT nodaļai pa citu, zināmu kanālu.</li>
  </ul>
  <div class="tip">💡 Padoms: IT nodaļa <b>nekad</b> nelūgs jūsu paroli e-pastā vai pa telefonu.</div>
  <p class="foot">Otanku Dzirnavnieks · IT HelpDesk · Šī lapa ir daļa no iekšējās drošības apmācības.</p>
</div></body></html>`);
});

// HTML-drošs teksts lietotāja vārdam izglītojošajā lapā
function esc(s) {
  return (s ?? '').toString().replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

module.exports = { router, publicRouter };
