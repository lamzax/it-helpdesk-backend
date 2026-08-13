const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('agent', 'admin'));

// GET /api/access-rights/systems -- sistemu saraksts (VPN, ERP, u.c.)
router.get('/systems', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM access_systems ORDER BY id');
    res.json({ systems: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/access-rights?userId=... -- konkreta lietotaja pieklives tiesibas (aktivas + vesture)
router.get('/', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId ir obligats query parametrs' });
  try {
    const result = await pool.query(
      `SELECT ar.id, ar.access_level, ar.granted_at, ar.revoked_at, ar.is_current, ar.notes,
              s.code AS system_code, s.name AS system_name,
              gb.display_name AS granted_by_name
       FROM access_rights ar
       JOIN access_systems s ON s.id = ar.system_id
       LEFT JOIN users gb ON gb.id = ar.granted_by
       WHERE ar.user_id = $1
       ORDER BY ar.granted_at DESC`,
      [userId]
    );
    res.json({ accessRights: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/access-rights -- piešķirt piekļuvi (add)
router.post('/', async (req, res) => {
  const { userId, systemCode, accessLevel = 'user', notes } = req.body;
  if (!userId || !systemCode) return res.status(400).json({ error: 'userId un systemCode ir obligati' });

  try {
    const sysRes = await pool.query('SELECT id FROM access_systems WHERE code = $1', [systemCode]);
    if (sysRes.rows.length === 0) return res.status(400).json({ error: 'Nezinama sistema: ' + systemCode });

    const result = await pool.query(
      `INSERT INTO access_rights (user_id, system_id, access_level, granted_by, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [userId, sysRes.rows[0].id, accessLevel, req.user.id, notes || null]
    );
    res.status(201).json({ accessRight: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/access-rights/:id/revoke -- atsaukt piekļuvi (paliek vēsturē ar revoked_at)
router.patch('/:id/revoke', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE access_rights SET is_current = false, revoked_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Ieraksts nav atrasts' });
    res.json({ accessRight: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
