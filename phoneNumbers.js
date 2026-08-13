const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sanitizeCustomFields } = require('../utils/customFields');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('agent', 'admin'));

// GET /api/phone-numbers
router.get('/', async (req, res) => {
  const result = await pool.query(
    `SELECT p.*, u.display_name AS current_holder, u.id AS current_holder_id
     FROM phone_numbers p
     LEFT JOIN phone_number_assignments pa ON pa.phone_number_id = p.id AND pa.is_current = true
     LEFT JOIN users u ON u.id = pa.user_id
     WHERE p.is_active = true
     ORDER BY p.number`
  );
  res.json({ phoneNumbers: result.rows });
});

// GET /api/phone-numbers/:id -- vesture
router.get('/:id', async (req, res) => {
  const numberRes = await pool.query('SELECT * FROM phone_numbers WHERE id = $1', [req.params.id]);
  if (numberRes.rows.length === 0) return res.status(404).json({ error: 'Numurs nav atrasts' });
  const history = await pool.query(
    `SELECT pa.id, pa.assigned_at, pa.unassigned_at, pa.is_current, u.display_name AS user_name, ast.name AS asset_name
     FROM phone_number_assignments pa
     JOIN users u ON u.id = pa.user_id
     LEFT JOIN assets ast ON ast.id = pa.asset_id
     WHERE pa.phone_number_id = $1 ORDER BY pa.assigned_at DESC`,
    [req.params.id]
  );
  res.json({ phoneNumber: numberRes.rows[0], history: history.rows });
});

// POST /api/phone-numbers -- add
router.post('/', async (req, res) => {
  const { number, carrier, simIccid, planName, monthlyCost, customFields } = req.body;
  if (!number) return res.status(400).json({ error: 'number ir obligats' });
  const sanitizedCustom = await sanitizeCustomFields('phone_numbers', customFields);
  const result = await pool.query(
    `INSERT INTO phone_numbers (number, carrier, sim_iccid, plan_name, monthly_cost, custom_fields)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [number, carrier || null, simIccid || null, planName || null, monthlyCost || null, JSON.stringify(sanitizedCustom)]
  );
  res.status(201).json({ phoneNumber: result.rows[0] });
});

// PATCH /api/phone-numbers/:id -- edit
router.patch('/:id', async (req, res) => {
  const { carrier, simIccid, planName, monthlyCost, customFields } = req.body;
  const sanitizedCustom = customFields !== undefined ? await sanitizeCustomFields('phone_numbers', customFields) : null;
  const result = await pool.query(
    `UPDATE phone_numbers SET carrier = COALESCE($1,carrier), sim_iccid = COALESCE($2,sim_iccid),
       plan_name = COALESCE($3,plan_name), monthly_cost = COALESCE($4,monthly_cost),
       custom_fields = CASE WHEN $6::jsonb IS NOT NULL THEN custom_fields || $6::jsonb ELSE custom_fields END
     WHERE id = $5 RETURNING *`,
    [carrier, simIccid, planName, monthlyCost, req.params.id, sanitizedCustom ? JSON.stringify(sanitizedCustom) : null]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Numurs nav atrasts' });
  res.json({ phoneNumber: result.rows[0] });
});

// DELETE /api/phone-numbers/:id -- soft delete
router.delete('/:id', async (req, res) => {
  const result = await pool.query(
    'UPDATE phone_numbers SET is_active = false WHERE id = $1 RETURNING id', [req.params.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Numurs nav atrasts' });
  res.json({ success: true });
});

// POST /api/phone-numbers/:id/assign
router.post('/:id/assign', async (req, res) => {
  const { userId, assetId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId ir obligats' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE phone_number_assignments SET is_current = false, unassigned_at = now()
       WHERE phone_number_id = $1 AND is_current = true`,
      [req.params.id]
    );
    const result = await client.query(
      `INSERT INTO phone_number_assignments (phone_number_id, user_id, asset_id) VALUES ($1,$2,$3) RETURNING *`,
      [req.params.id, userId, assetId || null]
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

module.exports = router;
