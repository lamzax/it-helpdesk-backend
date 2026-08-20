const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Latviešu diakritisko zīmju vienkāršošana, lai ģenerētu lietojamu "code"
// pamatkategorijai no tās nosaukuma (admin panelī vairs nav jāievada kods rokām).
const DIACRITICS_MAP = { ā:'a', č:'c', ē:'e', ģ:'g', ī:'i', ķ:'k', ļ:'l', ņ:'n', š:'s', ū:'u', ž:'z' };
function slugify(text) {
  const lower = text.toLowerCase().split('').map((ch) => DIACRITICS_MAP[ch] || ch).join('');
  return lower.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'kategorija';
}
async function generateUniqueCode(baseText) {
  const base = slugify(baseText);
  let candidate = base;
  let i = 1;
  while (true) {
    const existing = await pool.query('SELECT id FROM categories WHERE code = $1', [candidate]);
    if (existing.rows.length === 0) return candidate;
    i += 1;
    candidate = `${base}_${i}`;
  }
}

// GET /api/categories -- PAMATKATEGORIJU saraksts ticketa formas 1. solim
// (kartotas pec sort_order -- admin panelī iestatāmā secība)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, code, name_lv, name_en, default_priority, sort_order
       FROM categories WHERE parent_id IS NULL AND is_active = true ORDER BY sort_order, id`
    );
    res.json({ categories: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/categories/:id/children -- apakškategorijas ticketa formas 2. solim
// ("Programmas" kategorijai apakškategorijas nav šeit -- tās nāk no
// /api/applications/list)
router.get('/:id/children', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name_lv, name_en, sort_order FROM categories
       WHERE parent_id = $1 AND is_active = true ORDER BY sort_order, id`,
      [req.params.id]
    );
    res.json({ categories: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/categories/all?search=laptop -- PILNS saraksts (pamatkategorijas
// UN apakškategorijas kopā vienā), admin panelim, ar neobligātu meklēšanu.
router.get('/all', requireRole('admin'), async (req, res) => {
  const { search } = req.query;
  const params = [];
  let where = '';
  if (search) {
    params.push(`%${search}%`);
    where = 'WHERE c.name_lv ILIKE $1 OR c.name_en ILIKE $1 OR p.name_lv ILIKE $1';
  }
  try {
    const result = await pool.query(
      `SELECT c.id, c.code, c.name_lv, c.name_en, c.parent_id, c.sort_order,
              p.name_lv AS parent_name, p.code AS parent_code
       FROM categories c
       LEFT JOIN categories p ON p.id = c.parent_id
       ${where}
       ORDER BY COALESCE(p.sort_order, c.sort_order), p.id NULLS FIRST, c.parent_id NULLS FIRST, c.sort_order, c.id`,
      params
    );
    res.json({ categories: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/categories -- pievienot PAMATKATEGORIJU (parentId nav norādīts)
// vai APAKŠKATEGORIJU (parentId norādīts)
router.post('/', requireRole('admin'), async (req, res) => {
  const { nameLv, nameEn, parentId } = req.body;
  if (!nameLv) return res.status(400).json({ error: 'Nosaukums ir obligāts' });

  try {
    const isChild = parentId !== undefined && parentId !== null && parentId !== '';
    const resolvedNameEn = nameEn && nameEn.trim() ? nameEn : nameLv;

    if (isChild) {
      const parentRes = await pool.query('SELECT id, code FROM categories WHERE id = $1 AND parent_id IS NULL', [parentId]);
      if (parentRes.rows.length === 0) return res.status(400).json({ error: 'Norādītā pamatkategorija neeksistē' });
      if (parentRes.rows[0].code === 'programs') {
        return res.status(400).json({ error: 'Programmas pievienojiet "Programmas" sadaļā, nevis šeit.' });
      }

      const maxOrder = await pool.query('SELECT COALESCE(MAX(sort_order),0) AS m FROM categories WHERE parent_id = $1', [parentId]);
      const result = await pool.query(
        `INSERT INTO categories (name_lv, name_en, parent_id, sort_order) VALUES ($1,$2,$3,$4) RETURNING *`,
        [nameLv, resolvedNameEn, parentId, maxOrder.rows[0].m + 1]
      );
      return res.status(201).json({ category: result.rows[0] });
    }

    const code = await generateUniqueCode(nameLv);
    const maxOrder = await pool.query('SELECT COALESCE(MAX(sort_order),0) AS m FROM categories WHERE parent_id IS NULL');
    const result = await pool.query(
      `INSERT INTO categories (code, name_lv, name_en, sort_order) VALUES ($1,$2,$3,$4) RETURNING *`,
      [code, nameLv, resolvedNameEn, maxOrder.rows[0].m + 1]
    );
    res.status(201).json({ category: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/categories/:id -- pārsaukt
router.patch('/:id', requireRole('admin'), async (req, res) => {
  const { nameLv, nameEn } = req.body;
  try {
    const check = await pool.query(
      `SELECT c.id, c.code, p.code AS parent_code FROM categories c
       LEFT JOIN categories p ON p.id = c.parent_id WHERE c.id = $1`,
      [req.params.id]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'Kategorija nav atrasta' });
    if (check.rows[0].code === 'programs' || check.rows[0].parent_code === 'programs') {
      return res.status(400).json({ error: 'Šo kategoriju pārvaldiet "Programmas" sadaļā, nevis šeit.' });
    }

    const result = await pool.query(
      `UPDATE categories SET name_lv = COALESCE($1, name_lv), name_en = COALESCE($2, name_en)
       WHERE id = $3 RETURNING *`,
      [nameLv, nameEn, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Kategorija nav atrasta' });
    res.json({ category: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/categories/:id -- REĀLI dzēš (gan pamatkategoriju, gan
// apakškategoriju). Pamatkategorijas dzēšana kaskādē dzēš arī tās
// apakškategorijas (datubāzes ON DELETE CASCADE). Vecajiem ticketiem, kas
// atsaucās uz dzēsto kategoriju, tā vienkārši kļūst tukša (nevis bloķē dzēšanu).
router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    // "Programmas" pamatkategorija un tās apakškategorijas tiek pārvaldītas
    // AUTOMĀTISKI no "Programmas" (aplikāciju) sadaļas -- tās šeit nedzēšam,
    // lai neradītu nesakritību starp abām vietām.
    const check = await pool.query(
      `SELECT c.id, c.code, p.code AS parent_code FROM categories c
       LEFT JOIN categories p ON p.id = c.parent_id WHERE c.id = $1`,
      [req.params.id]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'Kategorija nav atrasta' });
    if (check.rows[0].code === 'programs' || check.rows[0].parent_code === 'programs') {
      return res.status(400).json({ error: 'Šo kategoriju pārvaldiet "Programmas" sadaļā, nevis šeit.' });
    }

    const result = await pool.query('DELETE FROM categories WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Kategorija nav atrasta' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/categories/reorder -- body: { orderedIds: [...] } -- pamatkategorijām
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
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/categories/reorder-children -- body: { parentId, orderedIds: [...] }
router.post('/reorder-children', requireRole('admin'), async (req, res) => {
  const { parentId, orderedIds } = req.body;
  if (!parentId || !Array.isArray(orderedIds)) {
    return res.status(400).json({ error: 'parentId un orderedIds ir obligati' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(
        'UPDATE categories SET sort_order = $1 WHERE id = $2 AND parent_id = $3',
        [i + 1, orderedIds[i], parentId]
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
