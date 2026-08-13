const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/categories -- aplikacija so sauc, lai uzpildītu ticketa izveides ekrana izveles pogas,
// kartotas pec sort_order (admin panelī iestatāmā secība)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, code, name_lv, name_en, default_priority, sort_order
       FROM categories WHERE is_active = true ORDER BY sort_order, id`
    );
    res.json({ categories: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/categories/all -- admin panelim (ietver ari neaktivas, lai varetu atjaunot)
router.get('/all', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM categories ORDER BY sort_order, id`);
    res.json({ categories: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/categories -- pievienot jaunu kategoriju
router.post('/', requireRole('admin'), async (req, res) => {
  const { code, nameLv, nameEn, defaultPriority = 'medium' } = req.body;
  if (!code || !nameLv || !nameEn) return res.status(400).json({ error: 'code, nameLv un nameEn ir obligati' });

  try {
    const maxOrder = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories');
    const result = await pool.query(
      `INSERT INTO categories (code, name_lv, name_en, default_priority, sort_order)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [code, nameLv, nameEn, defaultPriority, maxOrder.rows[0].m + 1]
    );
    res.status(201).json({ category: result.rows[0] });
  } catch (err) {
    // 23505 = PostgreSQL unikalitates parkapuma kods (piem. kods jau eksiste)
    if (err.code === '23505') return res.status(400).json({ error: 'Kategorija ar šo kodu jau eksistē' });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/categories/:id -- redigesana (nosaukums, prioritate, aktivitate)
router.patch('/:id', requireRole('admin'), async (req, res) => {
  const { nameLv, nameEn, defaultPriority, isActive } = req.body;
  try {
    const result = await pool.query(
      `UPDATE categories SET
         name_lv = COALESCE($1, name_lv), name_en = COALESCE($2, name_en),
         default_priority = COALESCE($3, default_priority), is_active = COALESCE($4, is_active)
       WHERE id = $5 RETURNING *`,
      [nameLv, nameEn, defaultPriority, isActive, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Kategorija nav atrasta' });
    res.json({ category: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/categories/:id -- soft delete (paslēpj no ticketa formas, bet vecie ticketi paliek neskarti)
router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE categories SET is_active = false WHERE id = $1 RETURNING id', [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Kategorija nav atrasta' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/categories/reorder -- body: { orderedIds: [id1, id2, id3, ...] }
// Iestata sort_order pec masiva secibas -- to sauc admin panelis pec "uz augsu/uz leju" klikšķa.
router.post('/reorder', requireRole('admin'), async (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    return res.status(400).json({ error: 'orderedIds ir obligats masivs' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query('UPDATE categories SET sort_order = $1 WHERE id = $2', [i + 1, orderedIds[i]]);
    }
    await client.query('COMMIT');
    const result = await client.query('SELECT * FROM categories ORDER BY sort_order, id');
    res.json({ categories: result.rows });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
