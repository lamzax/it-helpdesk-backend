const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const VALID_TABLES = ['assets', 'tickets', 'applications', 'phone_numbers'];
const VALID_TYPES = ['text', 'number', 'boolean', 'date', 'select'];

// GET /api/custom-fields?table=assets -- aktīvie lauki, lai formas (admin
// panelī UN mobilajā app) varētu tos parādīt. Pieejams jebkuram pieteiktam
// lietotājam, jo mobilajai app tas vajadzīgs ticketa formā.
router.get('/', async (req, res) => {
  const { table } = req.query;
  if (!VALID_TABLES.includes(table)) return res.status(400).json({ error: 'Nederīga tabula' });
  const result = await pool.query(
    `SELECT id, field_key, label, field_type, options, is_required, sort_order
     FROM custom_field_definitions WHERE table_name = $1 AND is_active = true ORDER BY sort_order, id`,
    [table]
  );
  res.json({ fields: result.rows });
});

// GET /api/custom-fields/all?table=assets -- admin panelim, ietver arī paslēptos
router.get('/all', requireRole('admin'), async (req, res) => {
  const { table } = req.query;
  if (!VALID_TABLES.includes(table)) return res.status(400).json({ error: 'Nederīga tabula' });
  const result = await pool.query(
    `SELECT * FROM custom_field_definitions WHERE table_name = $1 ORDER BY sort_order, id`,
    [table]
  );
  res.json({ fields: result.rows });
});

// POST /api/custom-fields -- pievienot jaunu pielāgotu lauku
router.post('/', requireRole('admin'), async (req, res) => {
  const { tableName, fieldKey, label, fieldType, options = [], isRequired = false } = req.body;
  if (!VALID_TABLES.includes(tableName)) return res.status(400).json({ error: 'Nederīga tabula' });
  if (!fieldKey || !label || !fieldType) return res.status(400).json({ error: 'fieldKey, label un fieldType ir obligāti' });
  if (!/^[a-z][a-z0-9_]*$/.test(fieldKey)) {
    return res.status(400).json({ error: 'Lauka kods drīkst saturēt tikai mazos latīņu burtus, ciparus un "_", un jāsākas ar burtu' });
  }
  if (!VALID_TYPES.includes(fieldType)) return res.status(400).json({ error: 'Nederīgs lauka tips' });
  if (fieldType === 'select' && (!Array.isArray(options) || options.length === 0)) {
    return res.status(400).json({ error: 'Izvēlnes tipam jānorāda vismaz viena izvēles vērtība' });
  }

  const maxOrder = await pool.query(
    'SELECT COALESCE(MAX(sort_order),0) AS m FROM custom_field_definitions WHERE table_name = $1', [tableName]
  );
  try {
    const result = await pool.query(
      `INSERT INTO custom_field_definitions (table_name, field_key, label, field_type, options, is_required, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [tableName, fieldKey, label, fieldType, JSON.stringify(options), isRequired, maxOrder.rows[0].m + 1]
    );
    res.status(201).json({ field: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Šāds lauka kods šai tabulai jau eksistē' });
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/custom-fields/:id -- rediģēt (nosaukumu, izvēles, statusu)
router.patch('/:id', requireRole('admin'), async (req, res) => {
  const { label, options, isRequired, isActive } = req.body;
  const result = await pool.query(
    `UPDATE custom_field_definitions SET
       label = COALESCE($1, label),
       options = COALESCE($2::jsonb, options),
       is_required = COALESCE($3, is_required),
       is_active = COALESCE($4, is_active)
     WHERE id = $5 RETURNING *`,
    [label || null, options ? JSON.stringify(options) : null, isRequired, isActive, req.params.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Lauks nav atrasts' });
  res.json({ field: result.rows[0] });
});

// DELETE /api/custom-fields/:id -- paslēpj lauku no formām; JAU IEVADĪTIE
// dati JSONB kolonnā PALIEK neskarti (netiek dzēsti, tikai vairs nerāda formā)
router.delete('/:id', requireRole('admin'), async (req, res) => {
  const result = await pool.query(
    'UPDATE custom_field_definitions SET is_active = false WHERE id = $1 RETURNING id', [req.params.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Lauks nav atrasts' });
  res.json({ success: true });
});

// POST /api/custom-fields/reorder -- body: { tableName, orderedIds: [...] }
router.post('/reorder', requireRole('admin'), async (req, res) => {
  const { tableName, orderedIds } = req.body;
  if (!VALID_TABLES.includes(tableName) || !Array.isArray(orderedIds)) {
    return res.status(400).json({ error: 'tableName un orderedIds ir obligāti' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(
        'UPDATE custom_field_definitions SET sort_order = $1 WHERE id = $2 AND table_name = $3',
        [i + 1, orderedIds[i], tableName]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
