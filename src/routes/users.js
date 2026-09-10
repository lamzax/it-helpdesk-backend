const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

async function recordUserHistory(userId, action, fieldName, oldValue, newValue, changedBy, notes) {
  if (action === 'field_changed' && String(oldValue ?? '') === String(newValue ?? '')) return;
  try {
    await pool.query(
      `INSERT INTO record_history (entity_type, entity_id, action, field_name, old_value, new_value, changed_by, notes)
       VALUES ('user',$1,$2,$3,$4,$5,$6,$7)`,
      [userId, action, fieldName || null, oldValue ?? null, newValue ?? null, changedBy || null, notes || null]
    );
  } catch (err) {
    console.error('recordUserHistory kļūda:', err.message);
  }
}

// GET /api/users/me
router.get('/me', async (req, res) => {
  res.json({ user: req.user });
});

// GET /api/users/fields-module -- atgriež rezervētā "Lietotāji" sistēmas
// moduļa id, lai admin panelis var pievienot/pārvaldīt papildu kolonnas ar
// TIEM PAŠIEM /api/modules/:id/fields maršrutiem, ko lieto jebkuram citam modulim.
router.get('/fields-module', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const result = await pool.query(`SELECT id FROM modules WHERE system_key = 'users'`);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Sistēmas modulis nav atrasts' });
    res.json({ moduleId: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/users?search=...
router.get('/', requireRole('owner', 'admin'), async (req, res) => {
  const { search } = req.query;
  const params = [];
  let where = '';
  if (search) { params.push(`%${search}%`); where = `WHERE display_name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1`; }
  try {
    const result = await pool.query(
      `SELECT id, display_name, email, phone, role, is_blocked, is_active, data, last_login_at, created_at
       FROM users ${where} ORDER BY display_name`,
      params
    );
    res.json({ users: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/users/:id/history
router.get('/:id/history', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT rh.*, u.display_name AS changed_by_name FROM record_history rh
       LEFT JOIN users u ON u.id = rh.changed_by
       WHERE rh.entity_type = 'user' AND rh.entity_id = $1 ORDER BY rh.changed_at DESC`,
      [req.params.id]
    );
    res.json({ history: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/users/export -- CSV eksports (bāzes lauki + visi papildu lauki)
router.get('/export', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const fieldsRes = await pool.query(
      `SELECT field_key, label FROM module_fields WHERE module_id = (SELECT id FROM modules WHERE system_key = 'users') ORDER BY sort_order`
    );
    const usersRes = await pool.query(`SELECT * FROM users ORDER BY display_name`);
    const csvEscape = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const columns = ['Vārds', 'E-pasts', 'Telefons', 'Loma', 'Bloķēts', ...fieldsRes.rows.map((f) => f.label)];
    const rows = usersRes.rows.map((u) => [
      u.display_name, u.email, u.phone, u.role, u.is_blocked ? 'Jā' : 'Nē',
      ...fieldsRes.rows.map((f) => u.data?.[f.field_key]),
    ]);
    const csv = [columns.map(csvEscape).join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="lietotaji.csv"');
    res.send('\uFEFF' + csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/users -- izveidot jaunu lietotāju (Owner/Admin). Admin nevar
// izveidot owner vai admin lomu -- tikai owner to drīkst.
router.post('/', requireRole('owner', 'admin'), async (req, res) => {
  const { displayName, email, phone, role = 'user', authProvider, data = {} } = req.body;
  if (!displayName) return res.status(400).json({ error: 'displayName ir obligāts' });
  if (!email && !phone) return res.status(400).json({ error: 'Jānorāda e-pasts vai telefona numurs' });
  if (role !== 'user' && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Tikai Owner var piešķirt Admin vai Owner tiesības' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO users (organization_id, email, phone, display_name, auth_provider, external_id, role, data, created_by)
       VALUES ((SELECT organization_id FROM users WHERE id = $1), $2,$3,$4,$5,$6,$7,$8,$1) RETURNING *`,
      [req.user.id, email || null, phone || null, displayName,
       authProvider || (email && email.includes('@') ? 'microsoft' : null), `manual-${Date.now()}`, role, JSON.stringify(data)]
    );
    await recordUserHistory(result.rows[0].id, 'created', null, null, null, req.user.id, `Izveidots: ${displayName}`);
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Lietotājs ar šo e-pastu vai telefonu jau eksistē' });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/users/:id -- rediģēt (loma, bloķēšana, papildu lauki)
router.patch('/:id', requireRole('owner', 'admin'), async (req, res) => {
  const { displayName, email, phone, role, isBlocked, data } = req.body;
  if (role !== undefined && role !== 'user' && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Tikai Owner var piešķirt Admin vai Owner tiesības' });
  }
  try {
    const before = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (before.rows.length === 0) return res.status(404).json({ error: 'Lietotājs nav atrasts' });
    const prev = before.rows[0];
    if (prev.role === 'owner' && req.user.id !== req.params.id) {
      return res.status(403).json({ error: 'Owner kontu nevar rediģēt cits lietotājs' });
    }
    if (email !== undefined && !email && !phone && !prev.phone) {
      return res.status(400).json({ error: 'Jānorāda vismaz e-pasts vai telefona numurs' });
    }
    if (phone !== undefined && !phone && !email && !prev.email) {
      return res.status(400).json({ error: 'Jānorāda vismaz e-pasts vai telefona numurs' });
    }

    if (role !== undefined && role !== prev.role) await recordUserHistory(req.params.id, 'field_changed', 'role', prev.role, role, req.user.id);
    if (isBlocked !== undefined && isBlocked !== prev.is_blocked) {
      await recordUserHistory(req.params.id, 'field_changed', 'is_blocked', prev.is_blocked, isBlocked, req.user.id,
        isBlocked ? 'Konts bloķēts' : 'Konts atbloķēts');
    }
    if (email !== undefined && email !== prev.email) await recordUserHistory(req.params.id, 'field_changed', 'email', prev.email, email, req.user.id);
    if (phone !== undefined && phone !== prev.phone) await recordUserHistory(req.params.id, 'field_changed', 'phone', prev.phone, phone, req.user.id);
    let mergedData = prev.data;
    if (data !== undefined) {
      mergedData = { ...prev.data, ...data };
      for (const key of Object.keys(data)) {
        if (String(prev.data[key] ?? '') !== String(data[key] ?? '')) {
          await recordUserHistory(req.params.id, 'field_changed', key, prev.data[key], data[key], req.user.id);
        }
      }
    }

    const result = await pool.query(
      `UPDATE users SET display_name = COALESCE($1, display_name), role = COALESCE($2, role),
         is_blocked = COALESCE($3, is_blocked), data = $4,
         email = CASE WHEN $6 THEN $7 ELSE email END,
         phone = CASE WHEN $8 THEN $9 ELSE phone END
       WHERE id = $5 RETURNING *`,
      [displayName, role, isBlocked, JSON.stringify(mergedData), req.params.id,
       email !== undefined, email || null, phone !== undefined, phone || null]
    );
    res.json({ user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Šis e-pasts vai telefona numurs jau pieder citam lietotājam' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/users/:id
router.delete('/:id', requireRole('owner', 'admin'), async (req, res) => {
  try {
    const target = await pool.query('SELECT role, display_name FROM users WHERE id = $1', [req.params.id]);
    if (target.rows.length === 0) return res.status(404).json({ error: 'Lietotājs nav atrasts' });
    if (target.rows[0].role === 'owner') return res.status(403).json({ error: 'Owner kontu nevar dzēst' });
    await pool.query('UPDATE users SET is_active = false WHERE id = $1', [req.params.id]);
    await recordUserHistory(req.params.id, 'deleted', null, null, null, req.user.id, `Deaktivizēts: ${target.rows[0].display_name}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
