const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/asset-categories -- pilns koks (visi limeni), admin panelim
router.get('/', requireRole('agent', 'admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, parent_id, name_lv, name_en, sort_order FROM asset_categories_tree ORDER BY parent_id NULLS FIRST, sort_order, id`
    );
    res.json({ categories: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/asset-categories -- pievienot (jebkurā līmenī -- parentId var but null)
router.post('/', requireRole('admin'), async (req, res) => {
  const { nameLv, nameEn, parentId } = req.body;
  if (!nameLv) return res.status(400).json({ error: 'Nosaukums ir obligāts' });
  try {
    const resolvedParentId = parentId || null;
    const maxOrder = await pool.query(
      'SELECT COALESCE(MAX(sort_order),0) AS m FROM asset_categories_tree WHERE parent_id IS NOT DISTINCT FROM $1',
      [resolvedParentId]
    );
    const result = await pool.query(
      `INSERT INTO asset_categories_tree (name_lv, name_en, parent_id, sort_order) VALUES ($1,$2,$3,$4) RETURNING *`,
      [nameLv, nameEn && nameEn.trim() ? nameEn : nameLv, resolvedParentId, maxOrder.rows[0].m + 1]
    );
    res.status(201).json({ category: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/asset-categories/:id -- pārsaukt
router.patch('/:id', requireRole('admin'), async (req, res) => {
  const { nameLv, nameEn } = req.body;
  try {
    const result = await pool.query(
      `UPDATE asset_categories_tree SET name_lv = COALESCE($1, name_lv), name_en = COALESCE($2, name_en)
       WHERE id = $3 RETURNING *`,
      [nameLv, nameEn, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Kategorija nav atrasta' });
    res.json({ category: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/asset-categories/:id -- reāli dzēš (kaskādē dzēš arī apakšlīmeņus)
router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM asset_categories_tree WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Kategorija nav atrasta' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/asset-categories/reorder -- body: { parentId, orderedIds: [...] }
router.post('/reorder', requireRole('admin'), async (req, res) => {
  const { parentId, orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds ir obligats' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(
        'UPDATE asset_categories_tree SET sort_order = $1 WHERE id = $2 AND parent_id IS NOT DISTINCT FROM $3',
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

module.exports = router;
