// Palaist ar: npm run seed
// Pievieno dažas testa iekārtas (ar QR kodiem) un piemēra aplikācijas/tālruņus,
// lai prototipā uzreiz būtu ko apskatīt un skenēt.
require('dotenv').config();
const pool = require('../db/pool');

const assets = [
  { asset_tag: 'IT-000101', qr_code: 'DEV-AP-201', name: 'WiFi piekļuves punkts - 2.stāvs', category: 'network', location: '2. stāvs, gaitenis' },
  { asset_tag: 'IT-000102', qr_code: 'DEV-SW-101', name: 'Tīkla komutators - serveru telpa', category: 'network', location: '1. stāvs, serveru telpa' },
  { asset_tag: 'IT-000103', qr_code: 'DEV-CAM-05', name: 'Kamera - galvenā ieeja', category: 'camera', location: '1. stāvs, vestibils' },
  { asset_tag: 'IT-000104', qr_code: 'DEV-PR-03', name: 'Printeris - 3.stāva birojs', category: 'printer', location: '3. stāvs' },
  { asset_tag: 'IT-000105', qr_code: 'DEV-LT-042', name: 'Dell Latitude 5440', category: 'computer', location: 'Noliktava' },
  { asset_tag: 'IT-000106', qr_code: 'DEV-MON-018', name: 'Dell 24" monitors', category: 'monitor', location: 'Noliktava' },
];

const applications = [
  { name: 'Microsoft 365', vendor: 'Microsoft', category: 'productivity' },
  { name: 'Adobe Acrobat Pro', vendor: 'Adobe', category: 'productivity' },
];

(async () => {
  for (const a of assets) {
    const cat = await pool.query('SELECT id FROM asset_categories WHERE code = $1', [a.category]);
    if (cat.rows.length === 0) { console.warn('Kategorija nav atrasta:', a.category); continue; }
    await pool.query(
      `INSERT INTO assets (asset_tag, qr_code, name, category_id, location, status)
       VALUES ($1,$2,$3,$4,$5,'in_stock') ON CONFLICT (asset_tag) DO NOTHING`,
      [a.asset_tag, a.qr_code, a.name, cat.rows[0].id, a.location]
    );
    console.log('Pievienota iekārta:', a.qr_code, '-', a.name);
  }

  for (const app of applications) {
    await pool.query(
      `INSERT INTO applications (name, vendor, category) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [app.name, app.vendor, app.category]
    );
    console.log('Pievienota aplikācija:', app.name);
  }

  await pool.end();
  console.log('Gatavs.');
})();
