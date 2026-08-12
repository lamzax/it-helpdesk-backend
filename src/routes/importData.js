const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('admin'));

// Visi import maršruti sagaida JA JAU PĀRVĒRSTUS (mapētus) ierakstus no
// admin paneļa (CSV parsēšana un kolonnu mapēšana notiek pārlūkā ar PapaParse,
// lai backend nav jāuztraucas par failu augšupielādi -- vienkāršāk un droši).

function chunkResult() {
  return { inserted: 0, updated: 0, skipped: 0, errors: [] };
}

// POST /api/import/assets
// body: { rows: [{ assetTag, categoryCode, name, manufacturer, model, serialNumber,
//                    location, purchaseDate, purchasePrice, vendor, warrantyUntil, status, notes }] }
router.post('/assets', async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows ir obligats masivs' });

  const result = chunkResult();
  const categoriesRes = await pool.query('SELECT id, code, name_lv, name_en FROM asset_categories');
  const categories = categoriesRes.rows;
  const fallbackCategory = categories.find((c) => c.code === 'other');

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      if (!r.name || !String(r.name).trim()) throw new Error('trūkst "name"');

      let category = categories.find(
        (c) => [c.code, c.name_lv, c.name_en].some(
          (v) => v && r.categoryCode && v.toLowerCase() === String(r.categoryCode).toLowerCase()
        )
      );
      if (!category) category = fallbackCategory;

      const assetTag = r.assetTag && String(r.assetTag).trim()
        ? String(r.assetTag).trim()
        : `IMPORT-${Date.now().toString(36)}-${i}`.toUpperCase();

      const validStatuses = ['in_stock', 'in_use', 'in_repair', 'retired', 'disposed'];
      const status = validStatuses.includes(r.status) ? r.status : 'in_stock';

      const existing = await pool.query('SELECT id, qr_code FROM assets WHERE asset_tag = $1', [assetTag]);
      // Katrai iekārtai vajag QR kodu, lai vēlāk varētu izdrukāt uzlīmi -- ja CSV
      // (piem. no Monday) tādu nesatur, ģenerējam automātiski, tāpat kā admin panelī.
      const qrCode = existing.rows[0]?.qr_code
        || `AST-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

      if (existing.rows.length > 0) {
        await pool.query(
          `UPDATE assets SET name=$1, category_id=$2, manufacturer=$3, model=$4, serial_number=$5,
             location=$6, purchase_date=$7, purchase_price=$8, vendor=$9, warranty_until=$10,
             status=$11, notes=$12, qr_code=COALESCE(qr_code, $14)
           WHERE id = $13`,
          [r.name, category.id, r.manufacturer || null, r.model || null, r.serialNumber || null,
           r.location || null, r.purchaseDate || null, r.purchasePrice || null, r.vendor || null,
           r.warrantyUntil || null, status, r.notes || null, existing.rows[0].id, qrCode]
        );
        result.updated++;
      } else {
        await pool.query(
          `INSERT INTO assets (asset_tag, category_id, name, manufacturer, model, serial_number,
             location, purchase_date, purchase_price, vendor, warranty_until, status, notes, qr_code)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [assetTag, category.id, r.name, r.manufacturer || null, r.model || null, r.serialNumber || null,
           r.location || null, r.purchaseDate || null, r.purchasePrice || null, r.vendor || null,
           r.warrantyUntil || null, status, r.notes || null, qrCode]
        );
        result.inserted++;
      }
    } catch (err) {
      result.errors.push({ row: i + 1, error: err.message });
    }
  }
  res.json(result);
});

// POST /api/import/applications
// body: { rows: [{ name, vendor, category, description }] }
router.post('/applications', async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows ir obligats masivs' });
  const result = chunkResult();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      if (!r.name || !String(r.name).trim()) throw new Error('trūkst "name"');
      const existing = await pool.query('SELECT id FROM applications WHERE name = $1', [r.name]);
      if (existing.rows.length > 0) {
        await pool.query(
          `UPDATE applications SET vendor=$1, category=$2, description=$3 WHERE id=$4`,
          [r.vendor || null, r.category || null, r.description || null, existing.rows[0].id]
        );
        result.updated++;
      } else {
        await pool.query(
          `INSERT INTO applications (name, vendor, category, description) VALUES ($1,$2,$3,$4)`,
          [r.name, r.vendor || null, r.category || null, r.description || null]
        );
        result.inserted++;
      }
    } catch (err) {
      result.errors.push({ row: i + 1, error: err.message });
    }
  }
  res.json(result);
});

// POST /api/import/phone-numbers
// body: { rows: [{ number, carrier, planName, monthlyCost }] }
router.post('/phone-numbers', async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows ir obligats masivs' });
  const result = chunkResult();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      if (!r.number || !String(r.number).trim()) throw new Error('trūkst "number"');
      const existing = await pool.query('SELECT id FROM phone_numbers WHERE number = $1', [r.number]);
      if (existing.rows.length > 0) {
        await pool.query(
          `UPDATE phone_numbers SET carrier=$1, plan_name=$2, monthly_cost=$3 WHERE id=$4`,
          [r.carrier || null, r.planName || null, r.monthlyCost || null, existing.rows[0].id]
        );
        result.updated++;
      } else {
        await pool.query(
          `INSERT INTO phone_numbers (number, carrier, plan_name, monthly_cost) VALUES ($1,$2,$3,$4)`,
          [r.number, r.carrier || null, r.planName || null, r.monthlyCost || null]
        );
        result.inserted++;
      }
    } catch (err) {
      result.errors.push({ row: i + 1, error: err.message });
    }
  }
  res.json(result);
});

module.exports = router;
