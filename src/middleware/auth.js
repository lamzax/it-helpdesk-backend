/**
 * Autentifikacijas middleware.
 *
 * Realaja sistema mobila aplikacija iegust:
 *  - iekseja lietotaja gadijuma: MS365 (Azure AD / Entra ID) id_token, izmantojot MSAL
 *  - areja lietotaja gadijuma: Google id_token, izmantojot Google Sign-In
 * un sūta to kā "Authorization: Bearer <token>".
 *
 * Sī middleware atbalsta divus rezimus (skat. .env AUTH_MODE):
 *  - "dev"        -> tokens ir base64(JSON), lai varetu palaist prototipu bez
 *                     realas Azure/Google app registracijas (noklusejums).
 *  - "production"  -> tokens tiek pilnvertigi parbauditi (JWKS parakstu parbaude).
 *
 * Pec veiksmigas parbaudes lietotajs tiek "upsert"-ots users tabula un
 * pieejams ka req.user turpmakajos handleros.
 */

const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { OAuth2Client } = require('google-auth-library');
const pool = require('../db/pool');

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
      resolve({
        externalId: decoded.oid || decoded.sub,
        email: decoded.preferred_username || decoded.email,
        displayName: decoded.name,
      });
    });
  });
}

async function verifyGoogleToken(token) {
  const ticket = await googleClient.verifyIdToken({
    idToken: token,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  return {
    externalId: payload.sub,
    email: payload.email,
    displayName: payload.name || payload.email,
  };
}

// DEV rezims: klients sūta base64(JSON) token, piem:
// { "provider": "microsoft", "externalId": "dev-123", "email": "j.berzins@uznemums.lv", "displayName": "Janis Berzins" }
function verifyDevToken(token) {
  try {
    const json = Buffer.from(token, 'base64').toString('utf-8');
    const payload = JSON.parse(json);
    if (!payload.email || !payload.provider) throw new Error('trukst email/provider');
    return payload;
  } catch (e) {
    throw new Error('Nederigs dev token: ' + e.message);
  }
}

// E-pasti, kas norādīti .env mainīgajā ADMIN_EMAILS (atdalīti ar komatu),
// automātiski saņem "admin" lomu -- lai varētu pieteikties admin panelī
// pirmoreiz, kad datubāzē vēl nav neviena admin lietotāja.
function getAdminEmails() {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

async function upsertUser({ provider, externalId, email, displayName }) {
  // Organizacijas noteiksana: microsoft -> internal, google -> external
  const orgType = provider === 'microsoft' ? 'internal' : 'external';
  const domain = email.split('@')[1] || null;
  const isBootstrapAdmin = getAdminEmails().includes(email.toLowerCase());

  let org = await pool.query(
    'SELECT id FROM organizations WHERE org_type = $1 AND domain = $2',
    [orgType, domain]
  );
  if (org.rows.length === 0) {
    org = await pool.query(
      'INSERT INTO organizations (name, org_type, domain) VALUES ($1, $2, $3) RETURNING id',
      [domain || (orgType === 'internal' ? 'Ieksejie lietotaji' : 'Arejie lietotaji'), orgType, domain]
    );
  }
  const organizationId = org.rows[0].id;

  const existing = await pool.query(
    'SELECT * FROM users WHERE auth_provider = $1 AND external_id = $2',
    [provider, externalId]
  );
  if (existing.rows.length > 0) {
    const updated = await pool.query(
      `UPDATE users SET last_login_at = now(), display_name = $1,
              role = CASE WHEN $3 THEN 'admin' ELSE role END
       WHERE id = $2 RETURNING *`,
      [displayName, existing.rows[0].id, isBootstrapAdmin]
    );
    return updated.rows[0];
  }

  const created = await pool.query(
    `INSERT INTO users (organization_id, email, display_name, auth_provider, external_id, role, last_login_at)
     VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING *`,
    [organizationId, email, displayName, provider, externalId, isBootstrapAdmin ? 'admin' : 'requester']
  );
  return created.rows[0];
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Trukst Authorization: Bearer <token>' });

  try {
    let identity;
    if (AUTH_MODE === 'dev') {
      identity = verifyDevToken(token);
    } else {
      // Meginam verificet ka Microsoft tokenu, ja neizdodas -- ka Google
      try {
        const ms = await verifyMicrosoftToken(token);
        identity = { provider: 'microsoft', ...ms };
      } catch {
        const g = await verifyGoogleToken(token);
        identity = { provider: 'google', ...g };
      }
    }
    const user = await upsertUser(identity);
    if (!user.is_active) return res.status(403).json({ error: 'Konts deaktivizets' });
    req.user = user;
    next();
  } catch (err) {
    console.error('Auth kluda:', err.message);
    return res.status(401).json({ error: 'Neizdevas autentificet: ' + err.message });
  }
}

// Pieejas kontrole pec lomas (piem. tikai agent/admin var mainit statusu)
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Nepietiekamas tiesibas' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
