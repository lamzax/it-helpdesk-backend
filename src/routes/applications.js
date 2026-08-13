const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sanitizeCustomFields } = require('../utils/customFields');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('agent', 'admin'));

// GET /api/applications?search=office
router.get('/', async (req, res) => {
  const { search } = req.query;
  const params = [];
  let where = 'WHERE a.is_active = true';
  if (search) { params.push(`%${search}%`); where += ` AND a.name ILIKE $${params.length}`; }

  const result = await pool.query(
    `SELECT a.*,
            (SELECT COUNT(*) FROM application_assignments aa WHERE aa.application_id = a.id AND aa.is_current = true) AS active_assignments,
            (SELECT COALESCE(SUM(seats_total),0) FROM application_licenses l WHERE l.application_id = a.id) AS seats_total
     FROM applications a ${where} ORDER BY a.name`,
    params
  );
  res.json({ applications: result.rows });
});

// GET /api/applications/:id -- detalizacija + licences + pieskirsanas vesture
router.get('/:id', async (req, res) => {
  const appRes = await pool.query('SELECT * FROM applications WHERE id = $1', [req.params.id]);
  if (appRes.rows.length === 0) return res.status(404).json({ error: 'Aplikācija nav atrasta' });

  const licenses = await pool.query(
    'SELECT * FROM application_licenses WHERE application_id = $1 ORDER BY purchase_date DESC NULLS LAST',
    [req.params.id]
  );
  const assignments = await pool.query(
    `SELECT aa.id, aa.assigned_at, aa.unassigned_at, aa.is_current,
            u.display_name AS user_name, ast.name AS asset_name
     FROM application_assignments aa
     LEFT JOIN users u ON u.id = aa.user_id
     LEFT JOIN assets ast ON ast.id = aa.asset_id
     WHERE aa.application_id = $1 ORDER BY aa.assigned_at DESC`,
    [req.params.id]
  );
  res.json({ application: appRes.rows[0], licenses: licenses.rows, assignments: assignments.rows });
});

// POST /api/applications -- add
router.post('/', async (req, res) => {
  const { name, vendor, category, description, customFields } = req.body;
  if (!name) return res.status(400).json({ error: 'name ir obligats' });
  const sanitizedCustom = await sanitizeCustomFields('applications', customFields);
  const result = await pool.query(
    'INSERT INTO applications (name, vendor, category, description, custom_fields) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [name, vendor || null, category || null, description || null, JSON.stringify(sanitizedCustom)]
  );
  res.status(201).json({ application: result.rows[0] });
});

// PATCH /api/applications/:id -- edit
router.patch('/:id', async (req, res) => {
  const { name, vendor, category, description, customFields } = req.body;
  const sanitizedCustom = customFields !== undefined ? await sanitizeCustomFields('applications', customFields) : null;
  const result = await pool.query(
    `UPDATE applications SET
       name = COALESCE($1, name), vendor = COALESCE($2, vendor),
       category = COALESCE($3, category), description = COALESCE($4, description),
       custom_fields = CASE WHEN $6::jsonb IS NOT NULL THEN custom_fields || $6::jsonb ELSE custom_fields END
     WHERE id = $5 RETURNING *`,
    [name, vendor, category, description, req.params.id, sanitizedCustom ? JSON.stringify(sanitizedCustom) : null]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Aplikācija nav atrasta' });
  res.json({ application: result.rows[0] });
});

// DELETE /api/applications/:id -- soft delete
router.delete('/:id', async (req, res) => {
  const result = await pool.query(
    'UPDATE applications SET is_active = false WHERE id = $1 RETURNING id', [req.params.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Aplikācija nav atrasta' });
  res.json({ success: true });
});

// POST /api/applications/:id/licenses -- add licence
router.post('/:id/licenses', async (req, res) => {
  const { licenseKey, seatsTotal, purchaseDate, expiresAt, cost, vendor, notes } = req.body;
  const result = await pool.query(
    `INSERT INTO application_licenses (application_id, license_key, seats_total, purchase_date, expires_at, cost, vendor, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.params.id, licenseKey || null, seatsTotal || 1, purchaseDate || null, expiresAt || null, cost || null, vendor || null, notes || null]
  );
  res.status(201).json({ license: result.rows[0] });
});

// POST /api/applications/:id/assign -- pieskirt lietotajam un/vai iekartai (aizver iepr. aktivo, ja tas pats userId+appId)
router.post('/:id/assign', async (req, res) => {
  const { userId, assetId, licenseId, notes } = req.body;
  if (!userId && !assetId) return res.status(400).json({ error: 'userId vai assetId ir obligats' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (userId) {
      await client.query(
        `UPDATE application_assignments SET is_current = false, unassigned_at = now()
         WHERE application_id = $1 AND user_id = $2 AND is_current = true`,
        [req.params.id, userId]
      );
    }
    const result = await client.query(
      `INSERT INTO application_assignments (application_id, license_id, user_id, asset_id, assigned_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, licenseId || null, userId || null, assetId || null, req.user.id, notes || null]
    );
    await client.query('COMMIT');
    res.status(201).json({ assignment: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/applications/assignments/:assignmentId/revoke -- atsaukt (delete no vestures skata, bet ieraksts paliek)
router.post('/assignments/:assignmentId/revoke', async (req, res) => {
  const result = await pool.query(
    `UPDATE application_assignments SET is_current = false, unassigned_at = now()
     WHERE id = $1 RETURNING *`,
    [req.params.assignmentId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Piešķīrums nav atrasts' });
  res.json({ assignment: result.rows[0] });
});

module.exports = router;
