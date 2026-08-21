const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sanitizeCustomFields } = require('../utils/customFields');

const router = express.Router();
router.use(requireAuth);

// GET /api/applications/list -- vienkāršs saraksts (id, name), pieejams JEBKURAM
// pieteiktam lietotājam (ne tikai agent/admin) -- to izmanto ticketa forma,
// lai darbinieks varētu izvēlēties reģistrētu programmu, kad kategorija ir
// "Cits jautājums". Šis maršruts ir novietots PIRMS requireRole('agent','admin')
// rindas apzināti, lai uz to šis ierobežojums neattiektos.
router.get('/list', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name FROM applications WHERE is_active = true ORDER BY name'
    );
    res.json({ applications: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.use(requireRole('agent', 'admin'));

// Katrai programmai automātiski uztur ATBILSTOŠU apakškategoriju zem
// "Programmas" pamatkategorijas -- lai tā ir redzama arī Kategoriju sadaļā,
// nevis tikai šeit. Atgriež izveidotās/atrastās kategorijas id.
// Sinhronizācijas kļūda NEDRĪKST bloķēt pašu programmas izveidi/rediģēšanu --
// ja tā neizdodas, pieraksta žurnālā un turpina, nevis "pakaras" pieprasījumu
// bez atbildes (tas iepriekš izskatījās, it kā sinhronizācija klusībā nestrādātu).
async function syncProgramCategory(appId, name) {
  try {
    const rootRes = await pool.query(`SELECT id FROM categories WHERE code = 'programs'`);
    if (rootRes.rows.length === 0) {
      console.error('syncProgramCategory: nav atrasta kategorija ar code="programs"');
      return null;
    }
    const rootId = rootRes.rows[0].id;

    const existing = await pool.query(
      'SELECT id FROM categories WHERE parent_id = $1 AND name_lv = $2', [rootId, name]
    );
    let categoryId;
    if (existing.rows.length > 0) {
      categoryId = existing.rows[0].id;
    } else {
      const created = await pool.query(
        `INSERT INTO categories (name_lv, name_en, parent_id) VALUES ($1,$1,$2) RETURNING id`,
        [name, rootId]
      );
      categoryId = created.rows[0].id;
    }
    await pool.query('UPDATE applications SET category_id = $1 WHERE id = $2', [categoryId, appId]);
    return categoryId;
  } catch (err) {
    console.error('syncProgramCategory kļūda:', err.message);
    return null;
  }
}

// GET /api/applications?search=office
router.get('/', async (req, res) => {
  const { search } = req.query;
  const params = [];
  let where = 'WHERE a.is_active = true';
  if (search) { params.push(`%${search}%`); where += ` AND a.name ILIKE $${params.length}`; }

  try {
    const result = await pool.query(
      `SELECT a.*,
              (SELECT COUNT(*) FROM application_assignments aa WHERE aa.application_id = a.id AND aa.is_current = true) AS active_assignments,
              (SELECT COALESCE(SUM(seats_total),0) FROM application_licenses l WHERE l.application_id = a.id) AS seats_total
       FROM applications a ${where} ORDER BY a.name`,
      params
    );
    res.json({ applications: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/applications/:id -- detalizacija + licences + pieskirsanas vesture
router.get('/:id', async (req, res) => {
  try {
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/applications -- add. Kategorija VIENMĒR ir "Programma"
// (Pamatkategorija) -- katrai programmai automātiski izveido/piesaista
// atbilstošu apakškategoriju "Programmas" kokā.
router.post('/', async (req, res) => {
  const { name, vendor, description, customFields } = req.body;
  if (!name) return res.status(400).json({ error: 'name ir obligats' });
  try {
    const sanitizedCustom = await sanitizeCustomFields('applications', customFields);
    const result = await pool.query(
      `INSERT INTO applications (name, vendor, category, description, custom_fields)
       VALUES ($1,$2,'Programma',$3,$4) RETURNING *`,
      [name, vendor || null, description || null, JSON.stringify(sanitizedCustom)]
    );
    const app = result.rows[0];
    await syncProgramCategory(app.id, app.name);
    res.status(201).json({ application: app });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/applications/:id -- edit (kategorija vienmēr paliek "Programma")
router.patch('/:id', async (req, res) => {
  const { name, vendor, description, customFields } = req.body;
  try {
    const sanitizedCustom = customFields !== undefined ? await sanitizeCustomFields('applications', customFields) : null;
    const result = await pool.query(
      `UPDATE applications SET
         name = COALESCE($1, name), vendor = COALESCE($2, vendor),
         description = COALESCE($3, description),
         custom_fields = CASE WHEN $5::jsonb IS NOT NULL THEN custom_fields || $5::jsonb ELSE custom_fields END
       WHERE id = $4 RETURNING *`,
      [name, vendor, description, req.params.id, sanitizedCustom ? JSON.stringify(sanitizedCustom) : null]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Programma nav atrasta' });
    const app = result.rows[0];
    if (name) await syncProgramCategory(app.id, app.name); // pārsauc arī saistīto kategoriju
    res.json({ application: app });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/applications/:id -- soft delete + izdzēš saistīto apakškategoriju
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE applications SET is_active = false WHERE id = $1 RETURNING id, category_id', [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Programma nav atrasta' });
    if (result.rows[0].category_id) {
      await pool.query('DELETE FROM categories WHERE id = $1', [result.rows[0].category_id]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/applications/:id/licenses -- add licence
router.post('/:id/licenses', async (req, res) => {
  const { licenseKey, seatsTotal, purchaseDate, expiresAt, cost, vendor, notes } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO application_licenses (application_id, license_key, seats_total, purchase_date, expires_at, cost, vendor, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, licenseKey || null, seatsTotal || 1, purchaseDate || null, expiresAt || null, cost || null, vendor || null, notes || null]
    );
    res.status(201).json({ license: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  try {
    const result = await pool.query(
      `UPDATE application_assignments SET is_current = false, unassigned_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.assignmentId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Piešķīrums nav atrasts' });
    res.json({ assignment: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
