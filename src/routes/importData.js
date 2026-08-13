const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sanitizeCustomFields } = require('../utils/customFields');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('admin'));

// Visi import maršruti sagaida JA JAU PĀRVĒRSTUS (mapētus) ierakstus no
// admin paneļa (CSV parsēšana un kolonnu mapēšana notiek pārlūkā ar PapaParse,
// lai backend nav jāuztraucas par failu augšupielādi -- vienkāršāk un droši).
// Katra rinda VAR papildus saturēt "customFields": { field_key: value, ... }
// priekš admin panelī definētajiem pielāgotajiem laukiem.

function chunkResult() {
  return { inserted: 0, updated: 0, skipped: 0, errors: [] };
}

// POST /api/import/assets
// body: { rows: [{ assetTag, categoryCode, name, manufacturer, model, serialNumber,
//                    location, purchaseDate, purchasePrice, vendor, warrantyUntil, status, notes,
//                    customFields }] }
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
      const sanitizedCustom = await sanitizeCustomFields('assets', r.customFields);

      const existing = await pool.query('SELECT id, qr_code, attributes FROM assets WHERE asset_tag = $1', [assetTag]);
      // Katrai iekārtai vajag QR kodu, lai vēlāk varētu izdrukāt uzlīmi -- ja CSV
      // (piem. no Monday) tādu nesatur, ģenerējam automātiski, tāpat kā admin panelī.
      const qrCode = existing.rows[0]?.qr_code
        || `AST-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

      if (existing.rows.length > 0) {
        const mergedAttributes = { ...(existing.rows[0].attributes || {}), ...sanitizedCustom };
        await pool.query(
          `UPDATE assets SET name=$1, category_id=$2, manufacturer=$3, model=$4, serial_number=$5,
             location=$6, purchase_date=$7, purchase_price=$8, vendor=$9, warranty_until=$10,
             status=$11, notes=$12, qr_code=COALESCE(qr_code, $14), attributes=$15
           WHERE id = $13`,
          [r.name, category.id, r.manufacturer || null, r.model || null, r.serialNumber || null,
           r.location || null, r.purchaseDate || null, r.purchasePrice || null, r.vendor || null,
           r.warrantyUntil || null, status, r.notes || null, existing.rows[0].id, qrCode, JSON.stringify(mergedAttributes)]
        );
        result.updated++;
      } else {
        await pool.query(
          `INSERT INTO assets (asset_tag, category_id, name, manufacturer, model, serial_number,
             location, purchase_date, purchase_price, vendor, warranty_until, status, notes, qr_code, attributes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [assetTag, category.id, r.name, r.manufacturer || null, r.model || null, r.serialNumber || null,
           r.location || null, r.purchaseDate || null, r.purchasePrice || null, r.vendor || null,
           r.warrantyUntil || null, status, r.notes || null, qrCode, JSON.stringify(sanitizedCustom)]
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
// body: { rows: [{ name, vendor, category, description, customFields }] }
router.post('/applications', async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows ir obligats masivs' });
  const result = chunkResult();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      if (!r.name || !String(r.name).trim()) throw new Error('trūkst "name"');
      const sanitizedCustom = await sanitizeCustomFields('applications', r.customFields);
      const existing = await pool.query('SELECT id, custom_fields FROM applications WHERE name = $1', [r.name]);
      if (existing.rows.length > 0) {
        const merged = { ...(existing.rows[0].custom_fields || {}), ...sanitizedCustom };
        await pool.query(
          `UPDATE applications SET vendor=$1, category=$2, description=$3, custom_fields=$5 WHERE id=$4`,
          [r.vendor || null, r.category || null, r.description || null, existing.rows[0].id, JSON.stringify(merged)]
        );
        result.updated++;
      } else {
        await pool.query(
          `INSERT INTO applications (name, vendor, category, description, custom_fields) VALUES ($1,$2,$3,$4,$5)`,
          [r.name, r.vendor || null, r.category || null, r.description || null, JSON.stringify(sanitizedCustom)]
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
// body: { rows: [{ number, carrier, planName, monthlyCost, customFields }] }
router.post('/phone-numbers', async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows ir obligats masivs' });
  const result = chunkResult();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      if (!r.number || !String(r.number).trim()) throw new Error('trūkst "number"');
      const sanitizedCustom = await sanitizeCustomFields('phone_numbers', r.customFields);
      const existing = await pool.query('SELECT id, custom_fields FROM phone_numbers WHERE number = $1', [r.number]);
      if (existing.rows.length > 0) {
        const merged = { ...(existing.rows[0].custom_fields || {}), ...sanitizedCustom };
        await pool.query(
          `UPDATE phone_numbers SET carrier=$1, plan_name=$2, monthly_cost=$3, custom_fields=$5 WHERE id=$4`,
          [r.carrier || null, r.planName || null, r.monthlyCost || null, existing.rows[0].id, JSON.stringify(merged)]
        );
        result.updated++;
      } else {
        await pool.query(
          `INSERT INTO phone_numbers (number, carrier, plan_name, monthly_cost, custom_fields) VALUES ($1,$2,$3,$4,$5)`,
          [r.number, r.carrier || null, r.planName || null, r.monthlyCost || null, JSON.stringify(sanitizedCustom)]
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
