const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// GET /api/users/me
router.get('/me', async (req, res) => {
  res.json({ user: req.user });
});

// GET /api/users?search=janis -- darbinieku saraksts (piesķiršanas formām)
router.get('/', requireRole('agent', 'admin'), async (req, res) => {
  const { search } = req.query;
  const params = [];
  let where = '';
  if (search) { params.push(`%${search}%`); where = `WHERE display_name ILIKE $1 OR email ILIKE $1`; }
  const result = await pool.query(
    `SELECT id, display_name, email, department, job_title, auth_provider, role
     FROM users ${where} ORDER BY display_name LIMIT 100`,
    params
  );
  res.json({ users: result.rows });
});

// GET /api/users/:id/profile -- PILNS darbinieka profils vienuviet:
// iekārtas, aplikācijas, tālruņa numuri, piekļuves tiesības, ticketi.
// Šeit helpdesk kļūst pārskatāms -- redzams viss, kas saistīts ar cilvēku, vienā skatā.
// GET /api/users/me/items -- PAŠA lietotāja piesaistītās iekārtas, aplikācijas,
// tālruņa numuri un piekļuves tiesības. To sauc mobilā aplikācija uzreiz pēc
// pieteikšanās, lai parādītu sarakstu, no kura darbinieks izvēlas, PAR KO
// tieši ir problēma (nevis jāraksta viss no jauna katru reizi).
// Pieejams JEBKURAM pieteiktam lietotājam -- tikai par SAVIEM datiem.
router.get('/me/items', async (req, res) => {
  const userId = req.user.id;

  const assets = await pool.query(
    `SELECT a.id, a.name, a.asset_tag, a.qr_code, a.location, ac.code AS category_code, ac.name_lv AS category_name
     FROM asset_assignments aa
     JOIN assets a ON a.id = aa.asset_id
     JOIN asset_categories ac ON ac.id = a.category_id
     WHERE aa.user_id = $1 AND aa.is_current = true
     ORDER BY a.name`,
    [userId]
  );

  const applications = await pool.query(
    `SELECT ap.id, ap.name, ap.vendor
     FROM application_assignments aa
     JOIN applications ap ON ap.id = aa.application_id
     WHERE aa.user_id = $1 AND aa.is_current = true
     ORDER BY ap.name`,
    [userId]
  );

  const phoneNumbers = await pool.query(
    `SELECT p.id, p.number, p.carrier
     FROM phone_number_assignments pa
     JOIN phone_numbers p ON p.id = pa.phone_number_id
     WHERE pa.user_id = $1 AND pa.is_current = true
     ORDER BY p.number`,
    [userId]
  );

  const accessRights = await pool.query(
    `SELECT ar.id, s.code AS system_code, s.name AS system_name, ar.access_level
     FROM access_rights ar JOIN access_systems s ON s.id = ar.system_id
     WHERE ar.user_id = $1 AND ar.is_current = true
     ORDER BY s.name`,
    [userId]
  );

  res.json({
    assets: assets.rows,
    applications: applications.rows,
    phoneNumbers: phoneNumbers.rows,
    accessRights: accessRights.rows,
  });
});

router.get('/:id/profile', requireRole('agent', 'admin'), async (req, res) => {
  const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (userRes.rows.length === 0) return res.status(404).json({ error: 'Lietotājs nav atrasts' });

  const assets = await pool.query(
    `SELECT a.id, a.asset_tag, a.name, ac.name_lv AS category_name, aa.assigned_at
     FROM asset_assignments aa
     JOIN assets a ON a.id = aa.asset_id
     JOIN asset_categories ac ON ac.id = a.category_id
     WHERE aa.user_id = $1 AND aa.is_current = true
     ORDER BY aa.assigned_at DESC`,
    [req.params.id]
  );

  const applications = await pool.query(
    `SELECT ap.id, ap.name, ap.vendor, aa.assigned_at
     FROM application_assignments aa
     JOIN applications ap ON ap.id = aa.application_id
     WHERE aa.user_id = $1 AND aa.is_current = true
     ORDER BY aa.assigned_at DESC`,
    [req.params.id]
  );

  const phoneNumbers = await pool.query(
    `SELECT p.id, p.number, p.carrier, pa.assigned_at
     FROM phone_number_assignments pa
     JOIN phone_numbers p ON p.id = pa.phone_number_id
     WHERE pa.user_id = $1 AND pa.is_current = true`,
    [req.params.id]
  );

  const accessRights = await pool.query(
    `SELECT s.name AS system_name, ar.access_level, ar.granted_at
     FROM access_rights ar JOIN access_systems s ON s.id = ar.system_id
     WHERE ar.user_id = $1 AND ar.is_current = true`,
    [req.params.id]
  );

  const tickets = await pool.query(
    `SELECT id, ticket_number, title, status, created_at FROM tickets
     WHERE reporter_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [req.params.id]
  );

  res.json({
    user: userRes.rows[0],
    assets: assets.rows,
    applications: applications.rows,
    phoneNumbers: phoneNumbers.rows,
    accessRights: accessRights.rows,
    tickets: tickets.rows,
  });
});

module.exports = router;
