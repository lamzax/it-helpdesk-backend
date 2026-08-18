const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/subcategories?categoryId=3 -- aktīvās apakškategorijas, ticketa
// formai (pieejams jebkuram pieteiktam lietotājam). "Programmas" kategorijai
// apakškategorijas NAV šeit -- tās nāk no /api/applications/public-list.
router.get('/', async (req, res) => {
  const { categoryId } = req.query;
  if (!categoryId) return res.status(400).json({ error: 'categoryId ir obligats' });
  try {
    const result = await pool.query(
      `SELECT id, name_lv, name_en, sort_order FROM subcategories
       WHERE category_id = $1 AND is_active = true ORDER BY sort_order, id`,
      [categoryId]
    );
    res.json({ subcategories: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/subcategories/all?categoryId=3 -- admin panelim (ietver neaktīvās)
router.get('/all', requireRole('admin'), async (req, res) => {
  const { categoryId } = req.query;
  if (!categoryId) return res.status(400).json({ error: 'categoryId ir obligats' });
  try {
    const result = await pool.query(
      `SELECT * FROM subcategories WHERE category_id = $1 ORDER BY sort_order, id`,
      [categoryId]
    );
    res.json({ subcategories: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/subcategories -- pievienot
router.post('/', requireRole('admin'), async (req, res) => {
  const { categoryId, nameLv, nameEn } = req.body;
  if (!categoryId || !nameLv || !nameEn) {
    return res.status(400).json({ error: 'categoryId, nameLv un nameEn ir obligati' });
  }
  try {
    const maxOrder = await pool.query(
      'SELECT COALESCE(MAX(sort_order),0) AS m FROM subcategories WHERE category_id = $1', [categoryId]
    );
    const result = await pool.query(
      `INSERT INTO subcategories (category_id, name_lv, name_en, sort_order)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [categoryId, nameLv, nameEn, maxOrder.rows[0].m + 1]
    );
    res.status(201).json({ subcategory: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Šāda apakškategorija šai kategorijai jau eksistē' });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/subcategories/:id -- rediģēt
router.patch('/:id', requireRole('admin'), async (req, res) => {
  const { nameLv, nameEn, isActive } = req.body;
  try {
    const result = await pool.query(
      `UPDATE subcategories SET
         name_lv = COALESCE($1, name_lv), name_en = COALESCE($2, name_en),
         is_active = COALESCE($3, is_active)
       WHERE id = $4 RETURNING *`,
      [nameLv, nameEn, isActive, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Apakškategorija nav atrasta' });
    res.json({ subcategory: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/subcategories/:id -- soft delete
router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE subcategories SET is_active = false WHERE id = $1 RETURNING id', [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Apakškategorija nav atrasta' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/subcategories/reorder -- body: { categoryId, orderedIds: [...] }
router.post('/reorder', requireRole('admin'), async (req, res) => {
  const { categoryId, orderedIds } = req.body;
  if (!categoryId || !Array.isArray(orderedIds)) {
    return res.status(400).json({ error: 'categoryId un orderedIds ir obligati' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(
        'UPDATE subcategories SET sort_order = $1 WHERE id = $2 AND category_id = $3',
        [i + 1, orderedIds[i], categoryId]
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
