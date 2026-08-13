const pool = require('../db/pool');

// Atgriez TIKAI tas customFields atslegas, kas šai tabulai PATIEŠĀM ir
// definetas admin panelī -- tas pasarga JSONB lauku no patvaļīga/negaidīta
// satura, ko kāds varētu mēģināt iesūtīt caur API tieši.
async function sanitizeCustomFields(tableName, submitted) {
  if (!submitted || typeof submitted !== 'object') return {};
  const defs = await pool.query(
    'SELECT field_key, field_type FROM custom_field_definitions WHERE table_name = $1 AND is_active = true',
    [tableName]
  );
  const allowed = {};
  for (const def of defs.rows) {
    if (Object.prototype.hasOwnProperty.call(submitted, def.field_key)) {
      let value = submitted[def.field_key];
      if (def.field_type === 'number') value = value === '' || value === null ? null : Number(value);
      if (def.field_type === 'boolean') value = Boolean(value);
      allowed[def.field_key] = value;
    }
  }
  return allowed;
}

module.exports = { sanitizeCustomFields };
