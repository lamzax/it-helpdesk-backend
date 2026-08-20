const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sanitizeCustomFields } = require('../utils/customFields');

const router = express.Router();
router.use(requireAuth);

// GET /api/assets/qr/:qrCode -- mobila app so sauc pec QR skenesanas ticketa izveidei
router.get('/qr/:qrCode', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.id, a.name, a.asset_tag, a.location,
              COALESCE(parent_c.code, c.code) AS category_code,
              COALESCE(parent_c.name_lv, c.name_lv) AS category_name
       FROM assets a
       LEFT JOIN categories c ON c.id = a.category_id
       LEFT JOIN categories parent_c ON parent_c.id = c.parent_id
       WHERE a.qr_code = $1 AND a.is_active = true`,
      [req.params.qrCode]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Iekārta ar šo QR kodu nav reģistrēta sistēmā' });
    }
    res.json({ asset: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/assets?category=<categoryId>&status=in_use&assignedTo=<userId>&search=dell&page=1
router.get('/', requireRole('agent', 'admin'), async (req, res) => {
  const { category, status, assignedTo, search, page = 1, pageSize = 25 } = req.query;
  const conditions = [];
  const params = [];

  if (category) { params.push(category); conditions.push(`a.category_id = $${params.length}`); }
  if (status) { params.push(status); conditions.push(`a.status = $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(a.name ILIKE $${params.length} OR a.asset_tag ILIKE $${params.length} OR a.serial_number ILIKE $${params.length})`);
  }
  if (assignedTo) {
    params.push(assignedTo);
    conditions.push(`EXISTS (SELECT 1 FROM asset_assignments aa WHERE aa.asset_id = a.id AND aa.is_current = true AND aa.user_id = $${params.length})`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(parseInt(pageSize, 10) || 25, 100);
  const offset = (Math.max(parseInt(page, 10), 1) - 1) * limit;
  params.push(limit, offset);

  try {
    const result = await pool.query(
      `SELECT a.id, a.asset_tag, a.qr_code, a.name, a.manufacturer, a.model, a.serial_number,
              a.status, a.location, a.vendor, a.purchase_date, a.purchase_price, a.warranty_until,
              a.notes, a.attributes,
              a.category_id,
              COALESCE(parent_c.name_lv || ' / ' || c.name_lv, c.name_lv) AS category_name,
              cu.display_name AS current_holder
       FROM assets a
       LEFT JOIN categories c ON c.id = a.category_id
       LEFT JOIN categories parent_c ON parent_c.id = c.parent_id
       LEFT JOIN asset_assignments aa ON aa.asset_id = a.id AND aa.is_current = true
       LEFT JOIN users cu ON cu.id = aa.user_id
       ${whereClause}
       ORDER BY a.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ assets: result.rows, page: Number(page), pageSize: limit });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/assets/:id -- pilna detalizacija + piesķīrumu vēsture + dzīves cikla
// vēsture (ietver arī atrašanās vietas izmaiņas) + saistītie ticketi
router.get('/:id', requireRole('agent', 'admin'), async (req, res) => {
  try {
    const assetRes = await pool.query(
      `SELECT a.*,
              a.category_id,
              COALESCE(parent_c.name_lv || ' / ' || c.name_lv, c.name_lv) AS category_name
       FROM assets a
       LEFT JOIN categories c ON c.id = a.category_id
       LEFT JOIN categories parent_c ON parent_c.id = c.parent_id
       WHERE a.id = $1`,
      [req.params.id]
    );
    if (assetRes.rows.length === 0) return res.status(404).json({ error: 'Iekārta nav atrasta' });

    const assignments = await pool.query(
      `SELECT aa.id, aa.assigned_at, aa.unassigned_at, aa.is_current, aa.notes,
              u.display_name AS user_name, u.email AS user_email,
              ab.display_name AS assigned_by_name
       FROM asset_assignments aa JOIN users u ON u.id = aa.user_id
       LEFT JOIN users ab ON ab.id = aa.assigned_by
       WHERE aa.asset_id = $1 ORDER BY aa.assigned_at DESC`,
      [req.params.id]
    );

    const lifecycle = await pool.query(
      `SELECT ale.id, ale.event_type, ale.description, ale.event_at, u.display_name AS performed_by_name
       FROM asset_lifecycle_events ale LEFT JOIN users u ON u.id = ale.performed_by
       WHERE ale.asset_id = $1 ORDER BY ale.event_at DESC`,
      [req.params.id]
    );

    const tickets = await pool.query(
      `SELECT t.id, t.ticket_number, t.title, t.status, t.priority, t.created_at,
              c.name_lv AS category_name
       FROM tickets t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.asset_id = $1 ORDER BY t.created_at DESC`,
      [req.params.id]
    );

    res.json({
      asset: assetRes.rows[0],
      assignments: assignments.rows,
      lifecycle: lifecycle.rows,
      tickets: tickets.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/assets -- admin reistre jaunu iekartu (add)
router.post('/', requireRole('admin'), async (req, res) => {
  const {
    assetTag, categoryId, name, manufacturer, model, serialNumber, location,
    ipAddress, macAddress, purchaseDate, purchasePrice, vendor, warrantyUntil,
    attributes, customFields, notes, generateQr = true,
  } = req.body;
  if (!assetTag || !name) {
    return res.status(400).json({ error: 'assetTag un name ir obligati' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let validCategoryId = null;
    if (categoryId) {
      const catRes = await client.query('SELECT id FROM categories WHERE id = $1', [categoryId]);
      if (catRes.rows.length === 0) throw new Error('Nezinama kategorija');
      validCategoryId = catRes.rows[0].id;
    }

    const sanitizedCustom = await sanitizeCustomFields('assets', customFields);
    const mergedAttributes = { ...(attributes || {}), ...sanitizedCustom };

    const qrCode = generateQr
      ? `AST-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase()
      : null;

    const assetRes = await client.query(
      `INSERT INTO assets (asset_tag, qr_code, category_id, name, manufacturer, model, serial_number,
                            location, ip_address, mac_address, purchase_date, purchase_price, vendor,
                            warranty_until, attributes, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'in_stock') RETURNING *`,
      [assetTag, qrCode, validCategoryId, name, manufacturer || null, model || null, serialNumber || null,
       location || null, ipAddress || null, macAddress || null, purchaseDate || null, purchasePrice || null,
       vendor || null, warrantyUntil || null, JSON.stringify(mergedAttributes), notes || null]
    );
    const asset = assetRes.rows[0];

    await client.query(
      `INSERT INTO asset_lifecycle_events (asset_id, event_type, description, performed_by)
       VALUES ($1, 'purchased', $2, $3)`,
      [asset.id, `Iekārta reģistrēta sistēmā${vendor ? ' (piegādātājs: ' + vendor + ')' : ''}${location ? '. Atrašanās vieta: ' + location : ''}`, req.user.id]
    );

    await client.query('COMMIT');
    res.status(201).json({ asset });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/assets/:id -- rediget iekartas datus (edit)
router.patch('/:id', requireRole('admin'), async (req, res) => {
  const allowedFields = {
    name: 'name', manufacturer: 'manufacturer', model: 'model', serialNumber: 'serial_number',
    location: 'location', ipAddress: 'ip_address', macAddress: 'mac_address',
    purchaseDate: 'purchase_date', purchasePrice: 'purchase_price', vendor: 'vendor',
    warrantyUntil: 'warranty_until', notes: 'notes', status: 'status', categoryId: 'category_id',
  };
  const sets = [];
  const params = [];
  for (const [key, column] of Object.entries(allowedFields)) {
    if (req.body[key] !== undefined) {
      params.push(req.body[key]);
      sets.push(`${column} = $${params.length}`);
    }
  }
  if (req.body.customFields !== undefined) {
    const sanitizedCustom = await sanitizeCustomFields('assets', req.body.customFields);
    params.push(JSON.stringify(sanitizedCustom));
    sets.push(`attributes = attributes || $${params.length}::jsonb`);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'Nav ko atjaunot' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prev = await client.query('SELECT status, location FROM assets WHERE id = $1', [req.params.id]);
    if (prev.rows.length === 0) throw new Error('Iekārta nav atrasta');

    if (req.body.status !== undefined && prev.rows[0].status !== req.body.status) {
      await client.query(
        `INSERT INTO asset_lifecycle_events (asset_id, event_type, description, performed_by)
         VALUES ($1, 'status_changed', $2, $3)`,
        [req.params.id, `Statuss mainīts: ${prev.rows[0].status} -> ${req.body.status}`, req.user.id]
      );
    }
    // Atrašanās vietas maiņa arī tiek ierakstīta vēsturē (piem. migrācija starp
    // birojiem/stāviem) -- ar datumu un to, kurš lietotājs to veica.
    if (req.body.location !== undefined && (prev.rows[0].location || '') !== (req.body.location || '')) {
      await client.query(
        `INSERT INTO asset_lifecycle_events (asset_id, event_type, description, performed_by)
         VALUES ($1, 'transferred', $2, $3)`,
        [req.params.id, `Atrašanās vieta mainīta: "${prev.rows[0].location || '—'}" -> "${req.body.location || '—'}"`, req.user.id]
      );
    }

    params.push(req.params.id);
    const result = await client.query(
      `UPDATE assets SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (result.rows.length === 0) throw new Error('Iekārta nav atrasta');
    await client.query('COMMIT');
    res.json({ asset: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/assets/:id -- soft delete (iekarta paliek DB veturei, bet vairs neparadas sarakstos)
router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE assets SET is_active = false, status = 'retired' WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Iekārta nav atrasta' });
    await pool.query(
      `INSERT INTO asset_lifecycle_events (asset_id, event_type, description, performed_by)
       VALUES ($1, 'disposed', 'Iekārta izņemta no aktīvās lietošanas', $2)`,
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/assets/:id/assign -- piesķirt iekārtu darbiniekam (aizver iepriekšējo automātiski, DB trigeris)
router.post('/:id/assign', requireRole('agent', 'admin'), async (req, res) => {
  const { userId, notes } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId ir obligats' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const assignRes = await client.query(
      `INSERT INTO asset_assignments (asset_id, user_id, assigned_by, notes)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, userId, req.user.id, notes || null]
    );
    await client.query(`UPDATE assets SET status = 'in_use' WHERE id = $1`, [req.params.id]);
    await client.query(
      `INSERT INTO asset_lifecycle_events (asset_id, event_type, description, performed_by)
       VALUES ($1, 'deployed', $2, $3)`,
      [req.params.id, `Piešķirts lietotājam`, req.user.id]
    );
    await client.query('COMMIT');
    res.status(201).json({ assignment: assignRes.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/assets/:id/unassign -- atgriezt iekārtu (vairs nav piešķirta nevienam)
router.post('/:id/unassign', requireRole('agent', 'admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE asset_assignments SET is_current = false, unassigned_at = now()
       WHERE asset_id = $1 AND is_current = true`,
      [req.params.id]
    );
    await client.query(`UPDATE assets SET status = 'in_stock' WHERE id = $1`, [req.params.id]);
    await client.query(
      `INSERT INTO asset_lifecycle_events (asset_id, event_type, description, performed_by)
       VALUES ($1, 'returned', 'Iekārta atgriezta noliktavā', $2)`,
      [req.params.id, req.user.id]
    );
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/assets/categories/list -- grupēts kategoriju koks (Pamatkategorija
// + tās apakškategorijas) iekārtas pievienošanas/rediģēšanas formai admin
// panelī. IZSLĒDZ "Programmas" zaru -- tā ir programmatūra, nevis fiziska
// iekārta, un tiek pārvaldīta atsevišķi "Programmas" sadaļā.
router.get('/categories/list', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name_lv, name_en, parent_id, sort_order,
              (SELECT code FROM categories root WHERE root.id = COALESCE(c.parent_id, c.id)) AS root_code
       FROM categories c
       WHERE is_active = true
       ORDER BY COALESCE(parent_id, id), parent_id NULLS FIRST, sort_order, id`
    );
    const filtered = result.rows.filter((r) => r.root_code !== 'programs');
    res.json({ categories: filtered });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
