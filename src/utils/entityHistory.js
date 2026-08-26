const pool = require('../db/pool');

// Ieraksta lauka izmaiņu vēsturē -- izsauc no PATCH maršrutiem, kad kāds
// izsekojams lauks (statuss, datums, nosaukums u.c.) mainās. Šo vēsturi var
// apskatīt katras iekārtas/programmas/numura kartītē un eksportēt uz CSV.
async function recordFieldChange(entityType, entityId, fieldName, oldValue, newValue, userId, notes) {
  if (String(oldValue ?? '') === String(newValue ?? '')) return; // nekas nemainījās
  try {
    await pool.query(
      `INSERT INTO entity_history (entity_type, entity_id, action, field_name, old_value, new_value, changed_by, notes)
       VALUES ($1,$2,'field_changed',$3,$4,$5,$6,$7)`,
      [entityType, entityId, fieldName, oldValue ?? null, newValue ?? null, userId || null, notes || null]
    );
  } catch (err) {
    console.error('recordFieldChange kļūda:', err.message);
  }
}

async function recordAction(entityType, entityId, action, userId, notes) {
  try {
    await pool.query(
      `INSERT INTO entity_history (entity_type, entity_id, action, changed_by, notes)
       VALUES ($1,$2,$3,$4,$5)`,
      [entityType, entityId, action, userId || null, notes || null]
    );
  } catch (err) {
    console.error('recordAction kļūda:', err.message);
  }
}

async function getHistory(entityType, entityId) {
  const result = await pool.query(
    `SELECT eh.*, u.display_name AS changed_by_name
     FROM entity_history eh LEFT JOIN users u ON u.id = eh.changed_by
     WHERE eh.entity_type = $1 AND eh.entity_id = $2
     ORDER BY eh.changed_at DESC`,
    [entityType, entityId]
  );
  return result.rows;
}

module.exports = { recordFieldChange, recordAction, getHistory };
