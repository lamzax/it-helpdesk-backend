const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

async function recordHistory(entityId, action, fieldName, oldValue, newValue, userId, notes, entityType = 'record') {
  if (action === 'field_changed' && String(oldValue ?? '') === String(newValue ?? '')) return;
  try {
    await pool.query(
      `INSERT INTO record_history (entity_type, entity_id, action, field_name, old_value, new_value, changed_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [entityType, entityId, action, fieldName || null, oldValue ?? null, newValue ?? null, userId || null, notes || null]
    );
  } catch (err) {
    console.error('recordHistory kļūda:', err.message);
  }
}

// ============================================================
// MODUĻI (kategorijas/tabulas) -- bezgalīgi ligzdojami
// ============================================================

// GET /api/modules -- PILNS koks (visi līmeņi), jebkuram pieteiktam lietotājam
// (vajadzīgs gan admin panelim, gan ticketa formai)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, parent_id, name, sort_order, icon FROM modules ORDER BY parent_id NULLS FIRST, sort_order, name`
    );
    res.json({ modules: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/modules -- pievienot jaunu moduli (jebkurā līmenī). Owner/Admin.
router.post('/', requireRole('owner', 'admin'), async (req, res) => {
  const { name, parentId, icon } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nosaukums ir obligāts' });
  try {
    const resolvedParentId = parentId || null;
    const maxOrder = await pool.query(
      'SELECT COALESCE(MAX(sort_order),0) AS m FROM modules WHERE parent_id IS NOT DISTINCT FROM $1',
      [resolvedParentId]
    );
    const result = await pool.query(
      `INSERT INTO modules (parent_id, name, icon, sort_order, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [resolvedParentId, name.trim(), icon || null, maxOrder.rows[0].m + 1, req.user.id]
    );
    res.status(201).json({ module: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/modules/:id -- pārsaukt
router.patch('/:id', requireRole('owner', 'admin'), async (req, res) => {
  const { name, icon } = req.body;
  try {
    const result = await pool.query(
      `UPDATE modules SET name = COALESCE($1, name), icon = COALESCE($2, icon) WHERE id = $3 RETURNING *`,
      [name, icon, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Modulis nav atrasts' });
    res.json({ module: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/modules/:id -- dzēš moduli, tā apakšmoduļus (kaskādē) UN visus tā ierakstus
router.delete('/:id', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM modules WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Modulis nav atrasts' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/modules/reorder -- body: { parentId, orderedIds: [...] }
router.post('/reorder', requireRole('owner', 'admin'), async (req, res) => {
  const { parentId, orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds ir obligāts' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(
        'UPDATE modules SET sort_order = $1 WHERE id = $2 AND parent_id IS NOT DISTINCT FROM $3',
        [i + 1, orderedIds[i], parentId || null]
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

// ============================================================
// MODUĻA LAUKI (pielāgotās kolonnas katram modulim)
// ============================================================

// GET /api/modules/:id/fields
router.get('/:id/fields', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM module_fields WHERE module_id = $1 ORDER BY sort_order, id`,
      [req.params.id]
    );
    res.json({ fields: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/modules/:id/fields -- pievienot lauku
router.post('/:id/fields', requireRole('owner', 'admin'), async (req, res) => {
  const { fieldKey, label, fieldType, options = [], isRequired = false } = req.body;
  if (!fieldKey || !label || !fieldType) return res.status(400).json({ error: 'fieldKey, label un fieldType ir obligāti' });
  if (!/^[a-z][a-z0-9_]*$/.test(fieldKey)) {
    return res.status(400).json({ error: 'Lauka kods drīkst saturēt tikai mazos latīņu burtus, ciparus un "_", jāsākas ar burtu' });
  }
  const validTypes = ['text', 'number', 'boolean', 'date', 'select'];
  if (!validTypes.includes(fieldType)) return res.status(400).json({ error: 'Nederīgs lauka tips' });

  try {
    const maxOrder = await pool.query('SELECT COALESCE(MAX(sort_order),0) AS m FROM module_fields WHERE module_id = $1', [req.params.id]);
    const result = await pool.query(
      `INSERT INTO module_fields (module_id, field_key, label, field_type, options, is_required, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, fieldKey, label, fieldType, JSON.stringify(options), isRequired, maxOrder.rows[0].m + 1]
    );
    res.status(201).json({ field: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Šāds lauka kods šim modulim jau eksistē' });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/modules/fields/:fieldId
router.patch('/fields/:fieldId', requireRole('owner', 'admin'), async (req, res) => {
  const { label, options, isRequired } = req.body;
  try {
    const result = await pool.query(
      `UPDATE module_fields SET label = COALESCE($1, label), options = COALESCE($2::jsonb, options),
         is_required = COALESCE($3, is_required) WHERE id = $4 RETURNING *`,
      [label || null, options ? JSON.stringify(options) : null, isRequired, req.params.fieldId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Lauks nav atrasts' });
    res.json({ field: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/modules/fields/:fieldId
router.delete('/fields/:fieldId', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM module_fields WHERE id = $1 RETURNING id', [req.params.fieldId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Lauks nav atrasts' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// IERAKSTI (rindas) katrā modulī
// ============================================================

// GET /api/modules/:id/records?search=...
router.get('/:id/records', async (req, res) => {
  const { search } = req.query;
  const params = [req.params.id];
  let where = 'WHERE module_id = $1 AND is_active = true';
  if (search) {
    params.push(`%${search}%`);
    where += ` AND (name ILIKE $${params.length} OR data::text ILIKE $${params.length})`;
  }
  try {
    const result = await pool.query(`SELECT * FROM records ${where} ORDER BY name`, params);
    res.json({ records: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/modules/records/:recordId -- pilna detalizācija + vēsture
router.get('/records/:recordId', async (req, res) => {
  try {
    const recordRes = await pool.query('SELECT * FROM records WHERE id = $1', [req.params.recordId]);
    if (recordRes.rows.length === 0) return res.status(404).json({ error: 'Ieraksts nav atrasts' });
    const historyRes = await pool.query(
      `SELECT rh.*, u.display_name AS changed_by_name FROM record_history rh
       LEFT JOIN users u ON u.id = rh.changed_by
       WHERE rh.entity_type = 'record' AND rh.entity_id = $1 ORDER BY rh.changed_at DESC`,
      [req.params.recordId]
    );
    const ticketsRes = await pool.query(
      `SELECT id, ticket_number, title, status, priority, created_at FROM tickets WHERE record_id = $1 ORDER BY created_at DESC`,
      [req.params.recordId]
    );
    res.json({ record: recordRes.rows[0], history: historyRes.rows, tickets: ticketsRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/modules/:id/records -- pievienot jaunu ierakstu
router.post('/:id/records', requireRole('owner', 'admin'), async (req, res) => {
  const { name, data = {} } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nosaukums ir obligāts' });
  try {
    const result = await pool.query(
      `INSERT INTO records (module_id, name, data, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, name.trim(), JSON.stringify(data), req.user.id]
    );
    await recordHistory(result.rows[0].id, 'created', null, null, null, req.user.id, `Izveidots: ${name}`);
    res.status(201).json({ record: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/modules/records/:recordId -- rediģēt (un pierakstīt vēsturē katru mainīto lauku)
router.patch('/records/:recordId', requireRole('owner', 'admin'), async (req, res) => {
  const { name, data } = req.body;
  try {
    const before = await pool.query('SELECT * FROM records WHERE id = $1', [req.params.recordId]);
    if (before.rows.length === 0) return res.status(404).json({ error: 'Ieraksts nav atrasts' });
    const prev = before.rows[0];

    if (name !== undefined && name !== prev.name) {
      await recordHistory(req.params.recordId, 'field_changed', 'name', prev.name, name, req.user.id);
    }
    let mergedData = prev.data;
    if (data !== undefined) {
      mergedData = { ...prev.data, ...data };
      for (const key of Object.keys(data)) {
        if (String(prev.data[key] ?? '') !== String(data[key] ?? '')) {
          await recordHistory(req.params.recordId, 'field_changed', key, prev.data[key], data[key], req.user.id);
        }
      }
    }

    const result = await pool.query(
      `UPDATE records SET name = COALESCE($1, name), data = $2 WHERE id = $3 RETURNING *`,
      [name, JSON.stringify(mergedData), req.params.recordId]
    );
    res.json({ record: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/modules/records/:recordId -- soft delete
router.delete('/records/:recordId', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE records SET is_active = false WHERE id = $1 RETURNING id, name`, [req.params.recordId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Ieraksts nav atrasts' });
    await recordHistory(req.params.recordId, 'deleted', null, null, null, req.user.id, `Dzēsts: ${result.rows[0].name}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// MEKLĒŠANA
// ============================================================

// GET /api/modules/search/global?q=... -- meklē VISOS moduļos reizē
router.get('/search/global', async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.json({ results: [] });
  try {
    const result = await pool.query(
      `SELECT r.id, r.name, r.module_id, m.name AS module_name
       FROM records r JOIN modules m ON m.id = r.module_id
       WHERE r.is_active = true AND (r.name ILIKE $1 OR r.data::text ILIKE $1)
       ORDER BY r.name LIMIT 50`,
      [`%${q}%`]
    );
    res.json({ results: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CSV IMPORTS/EKSPORTS
// ============================================================

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}
function toCsv(rows, columns) {
  const header = columns.map((c) => csvEscape(c)).join(',');
  const lines = rows.map((row) => columns.map((c) => csvEscape(row[c])).join(','));
  return [header, ...lines].join('\r\n');
}

// GET /api/modules/:id/export -- CSV eksports (name + visi module_fields)
router.get('/:id/export', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const fieldsRes = await pool.query('SELECT field_key, label FROM module_fields WHERE module_id = $1 ORDER BY sort_order', [req.params.id]);
    const recordsRes = await pool.query('SELECT * FROM records WHERE module_id = $1 AND is_active = true ORDER BY name', [req.params.id]);
    const moduleRes = await pool.query('SELECT name FROM modules WHERE id = $1', [req.params.id]);

    const rows = recordsRes.rows.map((r) => {
      const row = { Nosaukums: r.name };
      for (const f of fieldsRes.rows) row[f.label] = r.data[f.field_key];
      return row;
    });
    const columns = ['Nosaukums', ...fieldsRes.rows.map((f) => f.label)];
    const csv = toCsv(rows, columns);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${(moduleRes.rows[0]?.name || 'export')}.csv"`);
    res.send('\uFEFF' + csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/modules/records/:recordId/history/export -- viena ieraksta vēstures CSV
router.get('/records/:recordId/history/export', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT rh.changed_at, rh.action, rh.field_name, rh.old_value, rh.new_value, u.display_name AS changed_by_name, rh.notes
       FROM record_history rh LEFT JOIN users u ON u.id = rh.changed_by
       WHERE rh.entity_type = 'record' AND rh.entity_id = $1 ORDER BY rh.changed_at DESC`,
      [req.params.recordId]
    );
    const rows = result.rows.map((r) => ({
      Datums: r.changed_at, Darbība: r.action, Lauks: r.field_name,
      'Vecā vērtība': r.old_value, 'Jaunā vērtība': r.new_value, Veica: r.changed_by_name, Piezīmes: r.notes,
    }));
    const csv = toCsv(rows, ['Datums', 'Darbība', 'Lauks', 'Vecā vērtība', 'Jaunā vērtība', 'Veica', 'Piezīmes']);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="vesture.csv"');
    res.send('\uFEFF' + csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/modules/:id/import -- CSV imports (rindas jau sagatavotas/mapētas pārlūkā)
// body: { rows: [{ name, data: { field_key: value, ... } }] }
router.post('/:id/import', requireRole('owner', 'admin'), async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows ir obligāts masīvs' });
  const result = { inserted: 0, updated: 0, errors: [] };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      if (!r.name || !String(r.name).trim()) throw new Error('trūkst "name"');
      const existing = await pool.query('SELECT id, data FROM records WHERE module_id = $1 AND name = $2', [req.params.id, r.name]);
      if (existing.rows.length > 0) {
        const merged = { ...(existing.rows[0].data || {}), ...(r.data || {}) };
        await pool.query('UPDATE records SET data = $1 WHERE id = $2', [JSON.stringify(merged), existing.rows[0].id]);
        result.updated++;
      } else {
        const created = await pool.query(
          `INSERT INTO records (module_id, name, data, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
          [req.params.id, r.name, JSON.stringify(r.data || {}), req.user.id]
        );
        await recordHistory(created.rows[0].id, 'created', null, null, null, req.user.id, 'Importēts no CSV');
        result.inserted++;
      }
    } catch (err) {
      result.errors.push({ row: i + 1, error: err.message });
    }
  }
  res.json(result);
});

module.exports = router;
