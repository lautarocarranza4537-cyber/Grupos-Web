'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { Pool } = require('pg');

const app = express();
const port = Number(process.env.PORT || 3000);
const databaseUrl = process.env.DATABASE_URL;
const pool = databaseUrl ? new Pool({
  connectionString: databaseUrl,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
}) : null;
const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = 'gw_session';
const SESSION_DAYS = 30;
const passwordAttempts = new Map();
const postAttempts = new Map();
const commentAttempts = new Map();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '3mb' }));
app.use((req, res, next) => {
  req.cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key) { try { req.cookies[key] = decodeURIComponent(rest.join('=')); } catch { req.cookies[key] = ''; } }
  }
  next();
});
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Cache-Control', req.path.startsWith('/api/') ? 'no-store' : 'public, max-age=0, must-revalidate');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

let dbReady = false;
let initializing = false;
if (pool) pool.on('error', error => {
  dbReady = false;
  console.error('PostgreSQL perdió la conexión:', error.message);
});

function normalizeGroupUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString().replace(/\/$/, '');
  } catch { return ''; }
}

async function initializeDatabase() {
  if (initializing || dbReady) return;
  initializing = true;
  try {
    if (!pool) {
      console.error('DATABASE_URL no está configurada. Conectá PostgreSQL en Render.');
      return;
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_users (
        id BIGSERIAL PRIMARY KEY,
        username VARCHAR(24) NOT NULL UNIQUE,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        display_name VARCHAR(40),
        avatar_data TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_sessions (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        token_hash CHAR(64) NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      )
    `);
    await pool.query('ALTER TABLE app_users ADD COLUMN IF NOT EXISTS display_name VARCHAR(40)');
    await pool.query('ALTER TABLE app_users ADD COLUMN IF NOT EXISTS avatar_data TEXT');
    await pool.query('UPDATE app_users SET display_name=username WHERE display_name IS NULL');
    await pool.query('CREATE INDEX IF NOT EXISTS app_sessions_expiry_idx ON app_sessions (expires_at)');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS groups_public (
        id BIGSERIAL PRIMARY KEY,
        name VARCHAR(70) NOT NULL,
        category VARCHAR(32) NOT NULL DEFAULT 'General',
        description VARCHAR(500) NOT NULL,
        image_data TEXT,
        group_url VARCHAR(1000) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Additive-only migration: no existing publication is altered or deleted here.
    await pool.query('ALTER TABLE groups_public ADD COLUMN IF NOT EXISTS group_url_key TEXT');
    await pool.query('ALTER TABLE groups_public ADD COLUMN IF NOT EXISTS owner_token_hash TEXT');
    await pool.query('ALTER TABLE groups_public ADD COLUMN IF NOT EXISTS contact_url TEXT');
    await pool.query('ALTER TABLE groups_public ADD COLUMN IF NOT EXISTS owner_user_id BIGINT REFERENCES app_users(id) ON DELETE SET NULL');
    await pool.query('CREATE INDEX IF NOT EXISTS groups_public_url_key_idx ON groups_public (group_url_key)');
    await pool.query('CREATE INDEX IF NOT EXISTS groups_public_owner_idx ON groups_public (owner_user_id)');
    await pool.query(`CREATE TABLE IF NOT EXISTS group_comments (
      id BIGSERIAL PRIMARY KEY, group_id BIGINT NOT NULL REFERENCES groups_public(id) ON DELETE CASCADE,
      user_id BIGINT REFERENCES app_users(id) ON DELETE SET NULL,
      display_name VARCHAR(40) NOT NULL, avatar_data TEXT, comment_text VARCHAR(500) NOT NULL,
      is_anonymous BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query('ALTER TABLE group_comments ADD COLUMN IF NOT EXISTS image_data TEXT');
    await pool.query('CREATE INDEX IF NOT EXISTS group_comments_listing_idx ON group_comments (group_id, created_at DESC)');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS group_ratings (
        id BIGSERIAL PRIMARY KEY,
        group_id BIGINT NOT NULL REFERENCES groups_public(id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
        rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (group_id, user_id)
      )
    `);
    const legacy = await pool.query('SELECT id, group_url FROM groups_public WHERE group_url_key IS NULL');
    for (const row of legacy.rows) {
      const key = normalizeGroupUrl(row.group_url);
      await pool.query('UPDATE groups_public SET group_url_key = $1 WHERE id = $2 AND group_url_key IS NULL', [key, row.id]);
    }
    await pool.query('DELETE FROM app_sessions WHERE expires_at < NOW()');
    // One-time reset authorized by the site owner on 2026-11-26. Match the two
    // exact pre-account records only; never delete posts created after this reset.
    await pool.query('CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    const migrationClient = await pool.connect();
    try {
      await migrationClient.query('BEGIN');
      await migrationClient.query("SELECT pg_advisory_xact_lock(hashtext('gw_reset_20261126_v2')::bigint)");
      const done = await migrationClient.query("SELECT name FROM app_migrations WHERE name='gw_reset_20261126_v2'");
      if (!done.rowCount) {
        const removed = await migrationClient.query(`DELETE FROM groups_public WHERE owner_user_id IS NULL AND
          ((id=1 AND date_trunc('milliseconds', created_at)='2026-11-26T03:25:53.886Z'::timestamptz) OR
           (id=2 AND date_trunc('milliseconds', created_at)='2026-11-26T04:14:25.469Z'::timestamptz)) RETURNING id`);
        await migrationClient.query("INSERT INTO app_migrations (name) VALUES ('gw_reset_20261126_v2')");
        console.log('Reset único de publicaciones antiguas:', removed.rowCount);
      }
      await migrationClient.query('COMMIT');
    } catch (error) {
      try { await migrationClient.query('ROLLBACK'); } catch {}
      throw error;
    } finally { migrationClient.release(); }
    // Owner-requested one-time reset: only data created before the request.
    // A post-request publication protects its older owner from deletion.
    const resetClient = await pool.connect();
    try {
      await resetClient.query('BEGIN');
      await resetClient.query("SELECT pg_advisory_xact_lock(hashtext('gw_reset_accounts_20261126')::bigint)");
      const done = await resetClient.query("SELECT name FROM app_migrations WHERE name='gw_reset_accounts_20261126'");
      if (!done.rowCount) {
        const groups = await resetClient.query("DELETE FROM groups_public WHERE created_at < '2026-11-26T11:32:00Z'::timestamptz RETURNING id");
        const users = await resetClient.query(`DELETE FROM app_users u WHERE u.created_at < '2026-11-26T11:32:00Z'::timestamptz AND NOT EXISTS (SELECT 1 FROM groups_public g WHERE g.owner_user_id=u.id) RETURNING u.id`);
        await resetClient.query("INSERT INTO app_migrations (name) VALUES ('gw_reset_accounts_20261126')");
        console.log('Reset solicitado: grupos=', groups.rowCount, 'cuentas=', users.rowCount);
      }
      await resetClient.query('COMMIT');
    } catch (error) {
      try { await resetClient.query('ROLLBACK'); } catch {}
      throw error;
    } finally { resetClient.release(); }
    // Clean up only the two isolated test accounts created by the developer.
    const cleanupClient = await pool.connect();
    try {
      await cleanupClient.query('BEGIN');
      await cleanupClient.query("SELECT pg_advisory_xact_lock(hashtext('gw_comments_test_cleanup_20261126')::bigint)");
      const done = await cleanupClient.query("SELECT name FROM app_migrations WHERE name='gw_comments_test_cleanup_20261126'");
      if (!done.rowCount) {
        const removed = await cleanupClient.query(`DELETE FROM app_users u WHERE u.username IN ('gwtest_d80fc08d74', 'gwui_8b8a0d29f9') AND NOT EXISTS (SELECT 1 FROM groups_public g WHERE g.owner_user_id=u.id) RETURNING u.id`);
        await cleanupClient.query("INSERT INTO app_migrations(name) VALUES ('gw_comments_test_cleanup_20261126')");
        console.log('Cuentas técnicas de prueba limpiadas:', removed.rowCount);
      }
      await cleanupClient.query('COMMIT');
    } catch (error) {
      try { await cleanupClient.query('ROLLBACK'); } catch {}
      throw error;
    } finally { cleanupClient.release(); }
    dbReady = true;
    console.log('PostgreSQL listo.');
  } catch (error) {
    console.error('No se pudo preparar PostgreSQL:', error.message);
  } finally { initializing = false; }
}

function requireDatabase(req, res, next) {
  if (!pool || !dbReady) return res.status(503).json({ error: 'La base de datos todavía no está lista. Revisá la configuración de Render.' });
  next();
}
function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  const expected = `${req.protocol}://${req.get('host')}`;
  if (!origin || origin !== expected) return res.status(403).json({ error: 'Solicitud rechazada por seguridad. Recargá la página e intentá de nuevo.' });
  next();
}
function hashToken(value) { return crypto.createHash('sha256').update(value, 'utf8').digest('hex'); }
function safeEqualHex(a, b) {
  if (!/^[a-f0-9]{128}$/.test(a || '') || !/^[a-f0-9]{128}$/.test(b || '')) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
function cookieOptions() {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000 };
}
async function optionalAuth(req, res, next) {
  req.user = null;
  const raw = req.cookies[SESSION_COOKIE] || '';
  if (!/^[a-f0-9]{64}$/.test(raw)) return next();
  try {
    const result = await pool.query(`
      SELECT u.id, u.username, COALESCE(u.display_name,u.username) AS display_name, u.avatar_data FROM app_sessions s JOIN app_users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>NOW() LIMIT 1
    `, [hashToken(raw)]);
    req.user = result.rows[0] || null;
  } catch (error) { return next(error); }
  next();
}
function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Iniciá sesión para publicar, calificar o borrar tus publicaciones.' });
  next();
}
function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, max) : '';
}
function validPublicUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : null;
  } catch { return null; }
}
function validContactUrl(value) {
  if (!value) return '';
  const digits = value.replace(/\D/g, '');
  if (/^\+?[\d\s().-]{8,24}$/.test(value) && digits.length >= 8 && digits.length <= 15) return `https://wa.me/${digits}`;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    if (url.hostname.toLowerCase() === 'wa.me' && /^\/?\d{8,15}\/?$/.test(url.pathname)) return `https://wa.me/${url.pathname.replace(/\D/g, '')}`;
    if (url.hostname.toLowerCase() === 'api.whatsapp.com' && url.pathname === '/send') {
      const phone = (url.searchParams.get('phone') || '').replace(/\D/g, '');
      if (phone.length >= 8 && phone.length <= 15) return `https://wa.me/${phone}`;
    }
    return null;
  } catch { return null; }
}
function limitPosts(req, res, next) {
  const now = Date.now(), key = req.ip || 'unknown';
  let entry = postAttempts.get(key);
  if (!entry || entry.until < now) entry = { count: 0, until: now + 60 * 60 * 1000 };
  if (entry.count >= 8) return res.status(429).json({ error: 'Se alcanzó el límite de publicaciones desde esta conexión. Probá más tarde.' });
  entry.count++; postAttempts.set(key, entry);
  if (postAttempts.size > 5000) for (const [k, v] of postAttempts) if (v.until < now) postAttempts.delete(k);
  next();
}
function limited(req, res, next) {
  const now = Date.now(), key = req.ip || 'unknown';
  let row = passwordAttempts.get(key);
  if (!row || row.until < now) row = { count: 0, until: now + 10 * 60 * 1000 };
  if (row.count >= 15) return res.status(429).json({ error: 'Demasiados intentos. Esperá unos minutos y probá de nuevo.' });
  row.count++; passwordAttempts.set(key, row);
  if (passwordAttempts.size > 5000) for (const [k, v] of passwordAttempts) if (v.until < now) passwordAttempts.delete(k);
  next();
}

app.get('/health', (req, res) => res.status(dbReady ? 200 : 503).json({ ok: dbReady, database: dbReady ? 'ready' : 'waiting' }));

app.get('/api/auth/me', requireDatabase, optionalAuth, (req, res) => res.json({ user: req.user ? { id: req.user.id, username: req.user.username, display_name: req.user.display_name, avatar_data: req.user.avatar_data } : null }));

async function createSession(userId, res) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await pool.query('INSERT INTO app_sessions (user_id, token_hash, expires_at) VALUES ($1,$2,$3)', [userId, hashToken(token), expiresAt]);
  res.cookie(SESSION_COOKIE, token, cookieOptions());
}

app.post('/api/auth/register', requireDatabase, requireSameOrigin, limited, async (req, res) => {
  const username = cleanText(req.body && req.body.username, 24).toLowerCase();
  const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
  if (!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'El usuario debe tener entre 3 y 24 caracteres: letras sin tilde, números o guion bajo.' });
  if (password.length < 12 || password.length > 200) return res.status(400).json({ error: 'La contraseña debe tener entre 12 y 200 caracteres. No la reutilices en otros sitios.' });
  try {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const result = await pool.query('INSERT INTO app_users (username, password_salt, password_hash, display_name) VALUES ($1,$2,$3,$1) RETURNING id, username, display_name, avatar_data', [username, salt, derived.toString('hex')]);
    await createSession(result.rows[0].id, res);
    res.status(201).json({ user: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Ese nombre de usuario ya está ocupado.' });
    console.error('Error creando cuenta:', error.message);
    res.status(500).json({ error: 'No se pudo crear la cuenta. Probá de nuevo.' });
  }
});

app.post('/api/auth/login', requireDatabase, requireSameOrigin, limited, async (req, res) => {
  const username = cleanText(req.body && req.body.username, 24).toLowerCase();
  const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
  if (!/^[a-z0-9_]{3,24}$/.test(username) || password.length > 200) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  try {
    const result = await pool.query('SELECT id, username, display_name, avatar_data, password_salt, password_hash FROM app_users WHERE username=$1 LIMIT 1', [username]);
    if (!result.rowCount) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    const user = result.rows[0];
    const derived = await scrypt(password, user.password_salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    if (!safeEqualHex(derived.toString('hex'), user.password_hash)) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    await createSession(user.id, res);
    res.json({ user: { id: user.id, username: user.username, display_name: user.display_name || user.username, avatar_data: user.avatar_data || null } });
  } catch (error) {
    console.error('Error iniciando sesión:', error.message);
    res.status(500).json({ error: 'No se pudo iniciar sesión. Probá de nuevo.' });
  }
});

app.patch('/api/account/profile', requireDatabase, requireSameOrigin, optionalAuth, requireUser, async (req, res, next) => {
  const displayName = cleanText(req.body && req.body.displayName, 40);
  const avatarData = typeof (req.body && req.body.avatarData) === 'string' ? req.body.avatarData : '';
  if (displayName.length < 1) return res.status(400).json({ error: 'Elegí un nombre visible de 1 a 40 caracteres.' });
  if (avatarData && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(avatarData) || avatarData.length > 250000)) return res.status(400).json({ error: 'La foto no es válida o pesa demasiado.' });
  try {
    const result = await pool.query('UPDATE app_users SET display_name=$1, avatar_data=$2 WHERE id=$3 RETURNING id, username, display_name, avatar_data', [displayName, avatarData || null, req.user.id]);
    res.json({ user: result.rows[0] });
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', requireDatabase, requireSameOrigin, async (req, res) => {
  const token = req.cookies[SESSION_COOKIE] || '';
  if (/^[a-f0-9]{64}$/.test(token)) await pool.query('DELETE FROM app_sessions WHERE token_hash=$1', [hashToken(token)]);
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });
  res.json({ ok: true });
});

app.get('/api/groups', requireDatabase, optionalAuth, async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT g.id, g.name, g.category, g.description, g.image_data, g.group_url, g.contact_url, g.created_at,
             ROUND(AVG(r.rating)::numeric, 1) AS rating_average,
             COUNT(r.id)::int AS rating_count,
             COALESCE(MAX(CASE WHEN r.user_id=$1 THEN r.rating END),0)::int AS my_rating,
             (g.owner_user_id=$1) AS is_owner
      FROM groups_public g LEFT JOIN group_ratings r ON r.group_id=g.id
      GROUP BY g.id ORDER BY g.created_at DESC LIMIT 300
    `, [req.user ? req.user.id : null]);
    res.json(result.rows);
  } catch (error) { next(error); }
});

app.post('/api/groups', requireDatabase, requireSameOrigin, optionalAuth, requireUser, limitPosts, async (req, res, next) => {
  const name = cleanText(req.body && req.body.name, 70);
  const category = cleanText(req.body && req.body.category, 32) || 'General';
  const description = cleanText(req.body && req.body.description, 500);
  const groupUrl = validPublicUrl(cleanText(req.body && req.body.groupUrl, 1000));
  const groupUrlKey = groupUrl ? normalizeGroupUrl(groupUrl) : '';
  const imageData = typeof (req.body && req.body.imageData) === 'string' ? req.body.imageData : '';
  const contactInput = cleanText(req.body && req.body.contactUrl, 100);
  const contactUrl = validContactUrl(contactInput);
  if (name.length < 2) return res.status(400).json({ error: 'El nombre debe tener al menos 2 caracteres.' });
  if (description.length < 5) return res.status(400).json({ error: 'La descripción debe tener al menos 5 caracteres.' });
  if (!groupUrl || !groupUrlKey) return res.status(400).json({ error: 'Ingresá un enlace público que empiece con http:// o https://.' });
  if (contactInput && !contactUrl) return res.status(400).json({ error: 'El contacto debe ser un número de WhatsApp con código de país o un enlace wa.me válido.' });
  if (imageData && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(imageData) || imageData.length > 2100000)) return res.status(400).json({ error: 'La foto no es válida o pesa demasiado. Probá con otra imagen.' });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [groupUrlKey]);
    const duplicate = await client.query('SELECT id FROM groups_public WHERE group_url_key=$1 LIMIT 1', [groupUrlKey]);
    if (duplicate.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Este enlace de grupo o team ya fue subido.' }); }
    const result = await client.query(`
      INSERT INTO groups_public (name, category, description, image_data, group_url, group_url_key, contact_url, owner_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING id, name, category, description, image_data, group_url, contact_url, created_at
    `, [name, category, description, imageData || null, groupUrl, groupUrlKey, contactUrl || null, req.user.id]);
    await client.query('COMMIT');
    res.status(201).json({ ...result.rows[0], rating_average: null, rating_count: 0, my_rating: 0, is_owner: true });
  } catch (error) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('Error publicando grupo:', error.message);
    next(error);
  } finally { if (client) client.release(); }
});

app.get('/api/groups/:id/comments', requireDatabase, async (req, res, next) => {
  const id = /^\d+$/.test(req.params.id) ? req.params.id : '';
  if (!id) return res.status(400).json({ error: 'Publicación inválida.' });
  try {
    const result = await pool.query(`SELECT id, display_name, avatar_data, comment_text, image_data, is_anonymous, created_at
      FROM group_comments WHERE group_id=$1 ORDER BY created_at DESC LIMIT 100`, [id]);
    res.json(result.rows);
  } catch (error) { next(error); }
});

app.post('/api/groups/:id/comments', requireDatabase, requireSameOrigin, optionalAuth, async (req, res, next) => {
  const id = /^\d+$/.test(req.params.id) ? req.params.id : '';
  const text = cleanText(req.body && req.body.text, 500);
  const imageData = typeof (req.body && req.body.imageData) === 'string' ? req.body.imageData : '';
  const identity = req.body && req.body.identity === 'profile' ? 'profile' : 'anonymous';
  if (!id) return res.status(400).json({ error: 'Publicación inválida.' });
  if (!text && !imageData) return res.status(400).json({ error: 'Escribí un comentario o elegí una foto.' });
  if (imageData && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(imageData) || imageData.length > 600000)) return res.status(400).json({ error: 'La foto no es válida o pesa demasiado.' });
  const key = req.ip || 'unknown', now = Date.now(); let attempt = commentAttempts.get(key);
  if (!attempt || attempt.until < now) attempt = { count: 0, until: now + 60 * 60 * 1000 };
  if (attempt.count >= 12) return res.status(429).json({ error: 'Llegaste al límite de comentarios por ahora. Probá más tarde.' });
  attempt.count++; commentAttempts.set(key, attempt);
  if (identity === 'profile' && !req.user) return res.status(401).json({ error: 'Iniciá sesión para comentar con tu perfil; también podés comentar como anónimo.' });
  try {
    const author = identity === 'profile' ? (req.user.display_name || req.user.username) : 'Anónimo';
    const avatar = identity === 'profile' ? req.user.avatar_data : null;
    const result = await pool.query(`INSERT INTO group_comments (group_id,user_id,display_name,avatar_data,comment_text,is_anonymous,image_data)
      SELECT id,$2,$3,$4,$5,$6,$7 FROM groups_public WHERE id=$1
      RETURNING id, display_name, avatar_data, comment_text, image_data, is_anonymous, created_at`,
      [id, identity === 'profile' ? req.user.id : null, author, avatar, text, identity === 'anonymous', imageData || null]);
    if (!result.rowCount) return res.status(404).json({ error: 'Ese grupo ya no está publicado.' });
    res.status(201).json(result.rows[0]);
  } catch (error) { next(error); }
});

app.post('/api/groups/:id/rating', requireDatabase, requireSameOrigin, optionalAuth, requireUser, async (req, res, next) => {
  const id = /^\d+$/.test(req.params.id) ? req.params.id : '';
  const rating = Number(req.body && req.body.rating);
  if (!id) return res.status(400).json({ error: 'Publicación inválida.' });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Elegí una calificación de 1 a 5 estrellas.' });
  try {
    const result = await pool.query(`
      INSERT INTO group_ratings (group_id,user_id,rating) SELECT id,$2,$3 FROM groups_public WHERE id=$1
      ON CONFLICT (group_id,user_id) DO UPDATE SET rating=EXCLUDED.rating, updated_at=NOW()
      RETURNING group_id
    `, [id, req.user.id, rating]);
    if (!result.rowCount) return res.status(404).json({ error: 'Ese grupo ya no está publicado.' });
    const stats = await pool.query('SELECT ROUND(AVG(rating)::numeric,1) AS rating_average, COUNT(*)::int AS rating_count FROM group_ratings WHERE group_id=$1', [id]);
    res.json({ ...stats.rows[0], my_rating: rating });
  } catch (error) { next(error); }
});

app.post('/api/groups/:id/delete', requireDatabase, requireSameOrigin, optionalAuth, requireUser, async (req, res, next) => {
  const id = /^\d+$/.test(req.params.id) ? req.params.id : '';
  if (!id) return res.status(404).json({ error: 'No se encontró la publicación.' });
  try {
    const result = await pool.query('DELETE FROM groups_public WHERE id=$1 AND owner_user_id=$2 RETURNING id', [id, req.user.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'Solo quien publicó este grupo puede borrarlo.' });
    res.json({ ok: true, id: result.rows[0].id });
  } catch (error) { next(error); }
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'La foto es demasiado grande. Elegí una más liviana.' });
  if (res.headersSent) return next(err);
  console.error('Error inesperado:', err && err.message);
  res.status(500).json({ error: 'Ocurrió un error inesperado.' });
});

app.listen(port, () => {
  console.log(`Grupos-Web escuchando en el puerto ${port}`);
  initializeDatabase();
  if (pool) setInterval(initializeDatabase, 15000).unref();
});
