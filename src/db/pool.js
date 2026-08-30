const { Pool } = require('pg');

// Viens shared connection pool visai aplikacijai -- pg jau iekseji
// paralel apstrada pieprasijumus, tapec nevajag katram request
// veidot jaunu savienojumu (tas but lenak).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('Negaidita PG pool kluda:', err);
});

module.exports = pool;
