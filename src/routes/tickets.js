const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

async function generateTicketNumber(client) {
  const year = new Date().getFullYear();
  const res = await client.query(`SELECT COUNT(*)::int AS cnt FROM tickets WHERE ticket_number LIKE $1`, [`HD-${year}-%`]);
  const next = (res.rows[0].cnt + 1).toString().padStart(6, '0');
  return `HD-${year}-${next}`;
}

// Rekursīvi uzbūvē pilnu moduļa ceļu, piem. "Iekārtas / Personīgās iekārtas / Pele"
async function getModulePath(moduleId) {
  if (!moduleId) return null;
  const result = await pool.query(
    `WITH RECURSIVE path AS (
       SELECT id, parent_id, name, 0 AS depth FROM modules WHERE id = $1
       UNION ALL
       SELECT m.id, m.parent_id, m.name, p.depth + 1 FROM modules m JOIN path p ON m.id = p.parent_id
     )
     SELECT name FROM path ORDER BY depth DESC`,
    [moduleId]
  );
  return result.rows.map((r) => r.name).join(' / ');
}

// GET /api/tickets?status=new&moduleId=...&mine=true&page=1&pageSize=20
router.get('/', async (req, res) => {
  const { status, moduleId, mine, page = 1, pageSize = 20 } = req.query;
  const conditions = [];
  const params = [];

  if (req.user.role === 'user' || mine === 'true') {
    params.push(req.user.id);
    conditions.push(`t.reporter_id = $${params.length}`);
  }
  if (status) { params.push(status); conditions.push(`t.status = $${params.length}`); }
  if (moduleId) { params.push(moduleId); conditions.push(`t.module_id = $${params.length}`); }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(parseInt(pageSize, 10) || 20, 100);
  const offset = (Math.max(parseInt(page, 10), 1) - 1) * limit;
  params.push(limit, offset);

  try {
    const result = await pool.query(
      `SELECT t.id, t.ticket_number, t.title, t.description, t.status, t.priority, t.source,
              t.created_at, t.updated_at, t.module_id, t.record_id,
              r.name AS record_name,
              ru.display_name AS reporter_name, au.display_name AS assignee_name,
              (SELECT COUNT(*)::int FROM ticket_attachments ta WHERE ta.ticket_id = t.id) AS attachment_count,
              (SELECT COALESCE(bool_or(mime_type LIKE 'image/%'), false) FROM ticket_attachments ta WHERE ta.ticket_id = t.id) AS has_image,
              (SELECT COALESCE(bool_or(mime_type LIKE 'video/%'), false) FROM ticket_attachments ta WHERE ta.ticket_id = t.id) AS has_video,
              (SELECT COALESCE(bool_or(mime_type LIKE 'audio/%'), false) FROM ticket_attachments ta WHERE ta.ticket_id = t.id) AS has_audio
       FROM tickets t
       LEFT JOIN records r ON r.id = t.record_id
       JOIN users ru ON ru.id = t.reporter_id
       LEFT JOIN users au ON au.id = t.assignee_id
       ${whereClause}
       ORDER BY t.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    for (const row of result.rows) row.module_name = await getModulePath(row.module_id);
    res.json({ tickets: result.rows, page: Number(page), pageSize: limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tickets/:id
router.get('/:id', async (req, res) => {
  try {
    const ticketRes = await pool.query(
      `SELECT t.*, r.name AS record_name,
              ru.display_name AS reporter_name, ru.email AS reporter_email,
              au.display_name AS assignee_name
       FROM tickets t
       LEFT JOIN records r ON r.id = t.record_id
       JOIN users ru ON ru.id = t.reporter_id
       LEFT JOIN users au ON au.id = t.assignee_id
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (ticketRes.rows.length === 0) return res.status(404).json({ error: 'Tickets nav atrasts' });
    const ticket = ticketRes.rows[0];
    ticket.module_name = await getModulePath(ticket.module_id);

    if (req.user.role === 'user' && ticket.reporter_id !== req.user.id) {
      return res.status(403).json({ error: 'Nav piekļuves šim ticketam' });
    }

    const comments = await pool.query(
      `SELECT tc.id, tc.body, tc.is_internal, tc.created_at, u.display_name AS author_name
       FROM ticket_comments tc JOIN users u ON u.id = tc.author_id
       WHERE tc.ticket_id = $1 AND (tc.is_internal = false OR $2 != 'user')
       ORDER BY tc.created_at ASC`,
      [req.params.id, req.user.role]
    );
    const attachments = await pool.query(
      `SELECT id, file_url, file_name, mime_type, created_at FROM ticket_attachments WHERE ticket_id = $1`,
      [req.params.id]
    );

    res.json({ ticket, comments: comments.rows, attachments: attachments.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tickets -- moduleId ir OBLIGĀTS (izvēlētais kategorijas ceļa gala
// punkts); recordId neobligāts (konkrēts ieraksts tajā modulī, piem. konkrēta
// iekārta no saraksta).
router.post('/', async (req, res) => {
  const { title, description, moduleId, recordId, priority = 'medium', attachmentUrls = [] } = req.body;
  if (!title || !moduleId) return res.status(400).json({ error: 'title un moduleId ir obligāti' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const moduleCheck = await client.query('SELECT id FROM modules WHERE id = $1', [moduleId]);
    if (moduleCheck.rows.length === 0) throw new Error('Nezināma kategorija');

    let validRecordId = null;
    if (recordId) {
      const recCheck = await client.query('SELECT id FROM records WHERE id = $1', [recordId]);
      if (recCheck.rows.length > 0) validRecordId = recCheck.rows[0].id;
    }

    const ticketNumber = await generateTicketNumber(client);
    const ticketRes = await client.query(
      `INSERT INTO tickets (ticket_number, title, description, module_id, record_id, reporter_id, priority, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'mobile') RETURNING *`,
      [ticketNumber, title, description || null, moduleId, validRecordId, req.user.id, priority]
    );
    const ticket = ticketRes.rows[0];

    await client.query(
      `INSERT INTO ticket_status_history (ticket_id, old_status, new_status, changed_by) VALUES ($1, NULL, 'new', $2)`,
      [ticket.id, req.user.id]
    );
    for (const url of attachmentUrls) {
      await client.query(`INSERT INTO ticket_attachments (ticket_id, file_url, uploaded_by) VALUES ($1,$2,$3)`, [ticket.id, url, req.user.id]);
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

// PATCH /api/tickets/:id/status
router.patch('/:id/status', requireRole('owner', 'admin'), async (req, res) => {
  const { status } = req.body;
  const allowed = ['new', 'in_progress', 'waiting', 'resolved', 'closed'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Nederīgs statuss' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT status FROM tickets WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (current.rows.length === 0) throw new Error('Tickets nav atrasts');
    const extra = status === 'resolved' ? ', resolved_at = now()' : status === 'closed' ? ', closed_at = now()' : '';
    const updated = await client.query(`UPDATE tickets SET status = $1 ${extra} WHERE id = $2 RETURNING *`, [status, req.params.id]);
    await client.query(
      `INSERT INTO ticket_status_history (ticket_id, old_status, new_status, changed_by) VALUES ($1,$2,$3,$4)`,
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
  if (!body) return res.status(400).json({ error: 'body ir obligāts' });
  if (isInternal && req.user.role === 'user') {
    return res.status(403).json({ error: 'Parasti lietotāji nevar veidot iekšējos komentārus' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO ticket_comments (ticket_id, author_id, body, is_internal) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, req.user.id, body, isInternal]
    );
    res.status(201).json({ comment: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
