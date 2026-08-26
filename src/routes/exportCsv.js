const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getHistory } = require('../utils/entityHistory');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('agent', 'admin'));

// Vienkārša CSV rindas veidošana -- pareizi apstrādā komatus/pēdiņas/jaunrindas
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}
function toCsv(rows, columns) {
  const header = columns.map((c) => csvEscape(c.label)).join(',');
  const lines = rows.map((row) => columns.map((c) => csvEscape(row[c.key])).join(','));
  return [header, ...lines].join('\r\n');
}
function sendCsv(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + csv); // BOM -- lai Excel pareizi rāda latviešu burtus
}

// GET /api/export/assets
router.get('/assets', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.asset_tag, a.name, a.manufacturer, a.model, a.serial_number, a.status,
              a.location, a.vendor, a.purchase_date, a.warranty_until, a.notes,
              COALESCE(parent_c.name_lv || ' / ' || c.name_lv, c.name_lv) AS category_name,
              cu.display_name AS current_holder
       FROM assets a
       LEFT JOIN asset_categories_tree c ON c.id = a.category_id
       LEFT JOIN asset_categories_tree parent_c ON parent_c.id = c.parent_id
       LEFT JOIN asset_assignments aa ON aa.asset_id = a.id AND aa.is_current = true
       LEFT JOIN users cu ON cu.id = aa.user_id
       WHERE a.is_active = true ORDER BY a.asset_tag`
    );
    const csv = toCsv(result.rows, [
      { key: 'asset_tag', label: 'Inventāra Nr' }, { key: 'name', label: 'Nosaukums' },
      { key: 'category_name', label: 'Kategorija' }, { key: 'manufacturer', label: 'Ražotājs' },
      { key: 'model', label: 'Modelis' }, { key: 'serial_number', label: 'Sērijas Nr' },
      { key: 'status', label: 'Statuss' }, { key: 'current_holder', label: 'Turētājs' },
      { key: 'location', label: 'Atrašanās vieta' }, { key: 'vendor', label: 'Piegādātājs' },
      { key: 'purchase_date', label: 'Iepirkuma datums' }, { key: 'warranty_until', label: 'Garantija līdz' },
      { key: 'notes', label: 'Piezīmes' },
    ]);
    sendCsv(res, 'iekartas.csv', csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/export/assets/:id/history -- vienas iekārtas pilna vēsture
router.get('/assets/:id/history', async (req, res) => {
  try {
    const lifecycle = await pool.query(
      `SELECT ale.event_at, ale.event_type, ale.description, u.display_name AS performed_by
       FROM asset_lifecycle_events ale LEFT JOIN users u ON u.id = ale.performed_by
       WHERE ale.asset_id = $1 ORDER BY ale.event_at DESC`,
      [req.params.id]
    );
    const assignments = await pool.query(
      `SELECT aa.assigned_at, aa.unassigned_at, u.display_name AS user_name, ab.display_name AS assigned_by
       FROM asset_assignments aa JOIN users u ON u.id = aa.user_id
       LEFT JOIN users ab ON ab.id = aa.assigned_by
       WHERE aa.asset_id = $1 ORDER BY aa.assigned_at DESC`,
      [req.params.id]
    );
    const rows = [
      ...lifecycle.rows.map((r) => ({ datums: r.event_at, notikums: r.event_type, apraksts: r.description, veica: r.performed_by })),
      ...assignments.rows.map((r) => ({ datums: r.assigned_at, notikums: 'assigned', apraksts: `${r.user_name}${r.unassigned_at ? ' -> atgriezts ' + r.unassigned_at : ' (pašlaik)'}`, veica: r.assigned_by })),
    ].sort((a, b) => new Date(b.datums) - new Date(a.datums));
    const csv = toCsv(rows, [
      { key: 'datums', label: 'Datums' }, { key: 'notikums', label: 'Notikums' },
      { key: 'apraksts', label: 'Apraksts' }, { key: 'veica', label: 'Veica' },
    ]);
    sendCsv(res, 'iekartas-vesture.csv', csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/export/applications
router.get('/applications', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT name, vendor, description,
              (SELECT COUNT(*) FROM application_assignments aa WHERE aa.application_id = a.id AND aa.is_current = true) AS active_assignments
       FROM applications a WHERE is_active = true ORDER BY name`
    );
    const csv = toCsv(result.rows, [
      { key: 'name', label: 'Nosaukums' }, { key: 'vendor', label: 'Ražotājs' },
      { key: 'active_assignments', label: 'Aktīvie lietotāji' }, { key: 'description', label: 'Apraksts' },
    ]);
    sendCsv(res, 'programmas.csv', csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/export/phone-numbers
router.get('/phone-numbers', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.number, p.carrier, p.plan_name, p.monthly_cost, u.display_name AS current_holder
       FROM phone_numbers p
       LEFT JOIN phone_number_assignments pa ON pa.phone_number_id = p.id AND pa.is_current = true
       LEFT JOIN users u ON u.id = pa.user_id
       WHERE p.is_active = true ORDER BY p.number`
    );
    const csv = toCsv(result.rows, [
      { key: 'number', label: 'Numurs' }, { key: 'carrier', label: 'Operators' },
      { key: 'plan_name', label: 'Plāns' }, { key: 'monthly_cost', label: 'Mēneša maksa' },
      { key: 'current_holder', label: 'Turētājs' },
    ]);
    sendCsv(res, 'talruna-numuri.csv', csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/export/employees
router.get('/employees', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT display_name, email, department, job_title, auth_provider, role FROM users ORDER BY display_name`
    );
    const csv = toCsv(result.rows, [
      { key: 'display_name', label: 'Vārds' }, { key: 'email', label: 'E-pasts' },
      { key: 'department', label: 'Nodaļa' }, { key: 'job_title', label: 'Amats' },
      { key: 'auth_provider', label: 'Konta veids' }, { key: 'role', label: 'Loma' },
    ]);
    sendCsv(res, 'darbinieki.csv', csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/export/access-rights?userId=... -- viena darbinieka piekļuves vēsture
router.get('/access-rights', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId ir obligats' });
  try {
    const result = await pool.query(
      `SELECT s.name AS system_name, ar.access_level, ar.granted_at, ar.revoked_at, ar.is_current,
              gb.display_name AS granted_by
       FROM access_rights ar JOIN access_systems s ON s.id = ar.system_id
       LEFT JOIN users gb ON gb.id = ar.granted_by
       WHERE ar.user_id = $1 ORDER BY ar.granted_at DESC`,
      [userId]
    );
    const csv = toCsv(result.rows, [
      { key: 'system_name', label: 'Sistēma' }, { key: 'access_level', label: 'Līmenis' },
      { key: 'granted_at', label: 'Piešķirts' }, { key: 'revoked_at', label: 'Atsaukts' },
      { key: 'is_current', label: 'Aktīva' }, { key: 'granted_by', label: 'Piešķīra' },
    ]);
    sendCsv(res, 'piekluves-tiesibas.csv', csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
