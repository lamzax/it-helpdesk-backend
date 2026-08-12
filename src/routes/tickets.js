const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Ticket numura generesana: HD-<gads>-<secigais nr>
async function generateTicketNumber(client) {
  const year = new Date().getFullYear();
  const res = await client.query(
    `SELECT COUNT(*)::int AS cnt FROM tickets WHERE ticket_number LIKE $1`,
    [`HD-${year}-%`]
  );
  const next = (res.rows[0].cnt + 1).toString().padStart(6, '0');
  return `HD-${year}-${next}`;
}

// GET /api/tickets?status=new&category=lan&mine=true&page=1&pageSize=20
router.get('/', async (req, res) => {
  const { status, category, mine, page = 1, pageSize = 20 } = req.query;
  const conditions = [];
  const params = [];

  // Requester loma redz tikai savus ticketus; agent/admin redz visus (var filtret ar mine=true)
  if (req.user.role === 'requester' || mine === 'true') {
    params.push(req.user.id);
    conditions.push(`t.reporter_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`t.status = $${params.length}`);
  }
  if (category) {
    params.push(category);
    conditions.push(`c.code = $${params.length}`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(parseInt(pageSize, 10) || 20, 100);
  const offset = (Math.max(parseInt(page, 10), 1) - 1) * limit;
  params.push(limit, offset);

  const query = `
    SELECT t.id, t.ticket_number, t.title, t.status, t.priority, t.source,
           t.created_at, t.updated_at,
           c.code AS category_code, c.name_lv AS category_name,
           d.name AS device_name, d.qr_code AS device_qr_code,
           ru.display_name AS reporter_name,
           au.display_name AS assignee_name
    FROM tickets t
    JOIN categories c ON c.id = t.category_id
    LEFT JOIN assets d ON d.id = t.asset_id
    JOIN users ru ON ru.id = t.reporter_id
    LEFT JOIN users au ON au.id = t.assignee_id
    ${whereClause}
    ORDER BY t.created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `;
  const result = await pool.query(query, params);
  res.json({ tickets: result.rows, page: Number(page), pageSize: limit });
});

// GET /api/tickets/:id  -- pilna detalizacija + komentari + pielikumi
router.get('/:id', async (req, res) => {
  const ticketRes = await pool.query(
    `SELECT t.*, c.code AS category_code, c.name_lv AS category_name,
            d.name AS device_name, d.qr_code AS device_qr_code, d.location AS device_location,
            ru.display_name AS reporter_name, ru.email AS reporter_email,
            au.display_name AS assignee_name
     FROM tickets t
     JOIN categories c ON c.id = t.category_id
     LEFT JOIN assets d ON d.id = t.asset_id
     JOIN users ru ON ru.id = t.reporter_id
     LEFT JOIN users au ON au.id = t.assignee_id
     WHERE t.id = $1`,
    [req.params.id]
  );
  if (ticketRes.rows.length === 0) return res.status(404).json({ error: 'Tickets nav atrasts' });
  const ticket = ticketRes.rows[0];

  if (req.user.role === 'requester' && ticket.reporter_id !== req.user.id) {
    return res.status(403).json({ error: 'Nav piekluves sim ticketam' });
  }

  const comments = await pool.query(
    `SELECT tc.id, tc.body, tc.is_internal, tc.created_at, u.display_name AS author_name
     FROM ticket_comments tc JOIN users u ON u.id = tc.author_id
     WHERE tc.ticket_id = $1
       AND (tc.is_internal = false OR $2 != 'requester')
     ORDER BY tc.created_at ASC`,
    [req.params.id, req.user.role]
  );

  const attachments = await pool.query(
    `SELECT id, file_url, file_name, mime_type, created_at FROM ticket_attachments WHERE ticket_id = $1`,
    [req.params.id]
  );

  res.json({ ticket, comments: comments.rows, attachments: attachments.rows });
});

// POST /api/tickets -- jauna ticketa registresana no mobilas aplikacijas
// body: { title, description, categoryCode, qrCode?, priority?, attachmentUrls?: [] }
router.post('/', async (req, res) => {
  const { title, description, categoryCode, qrCode, assetId: assetIdInput, priority, attachmentUrls = [] } = req.body;
  if (!title || !categoryCode) {
    return res.status(400).json({ error: 'title un categoryCode ir obligati' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const categoryRes = await client.query('SELECT * FROM categories WHERE code = $1', [categoryCode]);
    if (categoryRes.rows.length === 0) throw new Error('Nezinama kategorija: ' + categoryCode);
    const category = categoryRes.rows[0];

    // Iekārtu ticketam var piesaistīt DIVOS veidos: ja zināms tiešais assetId
    // (piem. lietotājs izvēlējās iekārtu no "Manas piesaistes" saraksta),
    // vai caur qrCode (skenējot uzlīmi) -- tiešais assetId ir prioritārs.
    let assetId = null;
    if (assetIdInput) {
      const checkRes = await client.query('SELECT id FROM assets WHERE id = $1', [assetIdInput]);
      if (checkRes.rows.length > 0) assetId = checkRes.rows[0].id;
    } else if (qrCode) {
      const assetRes = await client.query('SELECT id FROM assets WHERE qr_code = $1', [qrCode]);
      if (assetRes.rows.length > 0) assetId = assetRes.rows[0].id;
      // Ja QR kods nav atrasts DB -- ticketu tapat izveidojam, bet bez asset_id piesaistes,
      // lai lietotajs netiek bloketes ja uzlima vel nav reistreta sistema.
    }

    const ticketNumber = await generateTicketNumber(client);
    const ticketRes = await client.query(
      `INSERT INTO tickets (ticket_number, title, description, category_id, asset_id,
                             reporter_id, priority, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'mobile') RETURNING *`,
      [ticketNumber, title, description || null, category.id, assetId,
       req.user.id, priority || category.default_priority]
    );
    const ticket = ticketRes.rows[0];

    await client.query(
      `INSERT INTO ticket_status_history (ticket_id, old_status, new_status, changed_by)
       VALUES ($1, NULL, 'new', $2)`,
      [ticket.id, req.user.id]
    );

    for (const url of attachmentUrls) {
      await client.query(
        `INSERT INTO ticket_attachments (ticket_id, file_url, uploaded_by) VALUES ($1,$2,$3)`,
        [ticket.id, url, req.user.id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ ticket });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/tickets/:id/status -- tikai agent/admin
router.patch('/:id/status', requireRole('agent', 'admin'), async (req, res) => {
  const { status } = req.body;
  const allowed = ['new', 'in_progress', 'waiting', 'resolved', 'closed'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Nederigs statuss' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT status FROM tickets WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (current.rows.length === 0) throw new Error('Tickets nav atrasts');

    const extra = status === 'resolved' ? ', resolved_at = now()'
                : status === 'closed' ? ', closed_at = now()' : '';
    const updated = await client.query(
      `UPDATE tickets SET status = $1 ${extra} WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    await client.query(
      `INSERT INTO ticket_status_history (ticket_id, old_status, new_status, changed_by)
       VALUES ($1,$2,$3,$4)`,
      [req.params.id, current.rows[0].status, status, req.user.id]
    );
    await client.query('COMMIT');
    res.json({ ticket: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/tickets/:id/comments
router.post('/:id/comments', async (req, res) => {
  const { body, isInternal = false } = req.body;
  if (!body) return res.status(400).json({ error: 'body ir obligats' });
  if (isInternal && req.user.role === 'requester') {
    return res.status(403).json({ error: 'Requesteri nevar veidot ieksejos komentarus' });
  }
  const result = await pool.query(
    `INSERT INTO ticket_comments (ticket_id, author_id, body, is_internal)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [req.params.id, req.user.id, body, isInternal]
  );
  res.status(201).json({ comment: result.rows[0] });
});

module.exports = router;
