const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('owner', 'admin'));

// GET /api/access-requests?resolved=false
router.get('/', async (req, res) => {
  const { resolved } = req.query;
  const params = [];
  let where = '';
  if (resolved !== undefined) { params.push(resolved === 'true'); where = 'WHERE is_resolved = $1'; }
  try {
    const result = await pool.query(
      `SELECT ar.*, u.display_name AS resolved_by_name FROM access_requests ar
       LEFT JOIN users u ON u.id = ar.resolved_by
       ${where} ORDER BY ar.attempted_at DESC`,
      params
    );
    res.json({ requests: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/access-requests/:id/approve -- izveido lietotāju un atzīmē pieprasījumu kā atrisinātu
router.post('/:id/approve', async (req, res) => {
  const { role = 'user' } = req.body;
  if (role !== 'user' && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Tikai Owner var piešķirt Admin vai Owner tiesības' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reqRes = await client.query('SELECT * FROM access_requests WHERE id = $1', [req.params.id]);
    if (reqRes.rows.length === 0) throw new Error('Pieprasījums nav atrasts');
    const request = reqRes.rows[0];
    const isEmail = request.identifier.includes('@');

    const userRes = await client.query(
      `INSERT INTO users (organization_id, email, phone, display_name, auth_provider, external_id, role, created_by)
       VALUES ((SELECT organization_id FROM users WHERE id = $1), $2,$3,$4,$5,$6,$7,$1) RETURNING *`,
      [req.user.id, isEmail ? request.identifier : null, isEmail ? null : request.identifier,
       request.display_name || request.identifier, isEmail ? 'microsoft' : null, `approved-${Date.now()}`, role]
    );
    await client.query(
      `UPDATE access_requests SET is_resolved = true, resolved_by = $1, resolved_at = now() WHERE id = $2`,
      [req.user.id, req.params.id]
    );
    await client.query('COMMIT');
    res.status(201).json({ user: userRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/access-requests/:id/dismiss -- ignorē pieprasījumu (nepiešķir piekļuvi)
router.post('/:id/dismiss', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE access_requests SET is_resolved = true, resolved_by = $1, resolved_at = now() WHERE id = $2 RETURNING id`,
      [req.user.id, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Pieprasījums nav atrasts' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
