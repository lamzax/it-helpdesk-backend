/**
 * Autentifikācija v2.
 *
 * PRINCIPS: pieteikties var TIKAI JAU REĢISTRĒTS lietotājs (kuru Owner/Admin
 * izveidojis "Lietotāji" sadaļā admin panelī). Ja e-pasts vai telefona
 * numurs sistēmā nav atrasts:
 *  - izveido/atjaunina ierakstu "access_requests" tabulā,
 *  - mēģina nosūtīt e-pastu uz IT_ADMIN_NOTIFY_EMAIL (skat. .env),
 *  - atgriež 403 kļūdu ar skaidru ziņojumu.
 *
 * Reālajā (production) versijā šeit tiktu pilnvērtīgi pārbaudīts MS365/Google
 * id_token paraksts. Prototipa "dev" režīmā (AUTH_MODE=dev) klients sūta
 * base64(JSON) tokenu ar { identifier, displayName } -- identifier ir
 * e-pasts VAI telefona numurs, ko lietotājs ievadīja pieteikšanās logā.
 */

const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { OAuth2Client } = require('google-auth-library');
const pool = require('../db/pool');
const { sendAccessRequestEmail } = require('../utils/mailer');

const AUTH_MODE = process.env.AUTH_MODE || 'dev';

const msJwks = jwksClient({
  jwksUri: `https://login.microsoftonline.com/${process.env.MS_TENANT_ID || 'common'}/discovery/v2.0/keys`,
});
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

function getMsSigningKey(header, callback) {
  msJwks.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

async function verifyMicrosoftToken(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(token, getMsSigningKey, { algorithms: ['RS256'] }, (err, decoded) => {
      if (err) return reject(err);
      resolve({ identifier: decoded.preferred_username || decoded.email, displayName: decoded.name });
    });
  });
}

async function verifyGoogleToken(token) {
  const ticket = await googleClient.verifyIdToken({ idToken: token, audience: process.env.GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  return { identifier: payload.email, displayName: payload.name || payload.email };
}

// DEV rezims: klients sūta base64(JSON) token, piem:
// { "identifier": "guntis.liepins@otankimill.eu", "displayName": "Guntis Liepiņš" }
// "identifier" var but e-pasts VAI telefona numurs.
function verifyDevToken(token) {
  try {
    const json = Buffer.from(token, 'base64').toString('utf-8');
    const payload = JSON.parse(json);
    if (!payload.identifier) throw new Error('trūkst identifier');
    return payload;
  } catch (e) {
    throw new Error('Nederīgs dev token: ' + e.message);
  }
}

function isEmail(identifier) {
  return identifier.includes('@');
}

async function findUserByIdentifier(identifier) {
  const column = isEmail(identifier) ? 'email' : 'phone';
  const result = await pool.query(`SELECT * FROM users WHERE ${column} = $1`, [identifier]);
  return result.rows[0] || null;
}

async function recordAccessRequest(identifier, displayName) {
  const existing = await pool.query('SELECT id, attempt_count FROM access_requests WHERE identifier = $1 AND is_resolved = false', [identifier]);
  if (existing.rows.length > 0) {
    await pool.query(
      'UPDATE access_requests SET attempt_count = attempt_count + 1, attempted_at = now() WHERE id = $1',
      [existing.rows[0].id]
    );
    return;
  }
  const created = await pool.query(
    `INSERT INTO access_requests (identifier, display_name) VALUES ($1,$2) RETURNING id`,
    [identifier, displayName || null]
  );
  sendAccessRequestEmail(identifier, displayName).then((sent) => {
    if (sent) pool.query('UPDATE access_requests SET notified_email = true WHERE id = $1', [created.rows[0].id]);
  });
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Trūkst Authorization: Bearer <token>' });

  try {
    let identity;
    if (AUTH_MODE === 'dev') {
      identity = verifyDevToken(token);
    } else {
      try {
        identity = await verifyMicrosoftToken(token);
      } catch {
        identity = await verifyGoogleToken(token);
      }
    }

    const user = await findUserByIdentifier(identity.identifier);
    if (!user) {
      await recordAccessRequest(identity.identifier, identity.displayName);
      return res.status(403).json({
        error: 'Šis lietotājs nav reģistrēts sistēmā. Pieprasījums nosūtīts administratoram.',
        code: 'NOT_REGISTERED',
      });
    }
    if (user.is_blocked) {
      return res.status(403).json({ error: 'Šis konts ir bloķēts. Sazinieties ar IT administratoru.', code: 'BLOCKED' });
    }
    if (!user.is_active) {
      return res.status(403).json({ error: 'Konts deaktivizēts.', code: 'INACTIVE' });
    }

    await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    req.user = user;
    next();
  } catch (err) {
    console.error('Auth kļūda:', err.message);
    return res.status(401).json({ error: 'Neizdevās autentificēt: ' + err.message });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Nepietiekamas tiesības' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
