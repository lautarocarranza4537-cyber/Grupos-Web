'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { promisify } = require('util');
const { Pool } = require('pg');

const app = express();
const port = Number(process.env.PORT || 3000);
const publicIndexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
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
const commentActionAttempts = new Map();
const reportAttempts = new Map();

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
// Generate a current public sitemap before static middleware so it includes shareable group pages.
app.get('/sitemap.xml', async (req, res, next) => {
  if (!pool || !dbReady) return res.sendFile(path.join(__dirname, 'public', 'sitemap.xml'));
  try {
    const result = await pool.query(`SELECT id, created_at FROM groups_public WHERE moderation_hidden=FALSE ORDER BY id DESC LIMIT 5000`);
    const urls = result.rows.map(row => {
      const id = String(row.id);
      if (!/^\d+$/.test(id)) return '';
      const date = row.created_at instanceof Date ? row.created_at.toISOString().slice(0, 10) : '';
      return `  <url><loc>https://grupos-web.onrender.com/grupo/${id}</loc>${/^\d{4}-\d{2}-\d{2}$/.test(date) ? `<lastmod>${date}</lastmod>` : ''}<changefreq>weekly</changefreq><priority>0.7</priority></url>`;
    }).filter(Boolean);
    res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://grupos-web.onrender.com/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n${urls.join('\n')}\n</urlset>`);
  } catch (error) { next(error); }
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
        language VARCHAR(32) NOT NULL DEFAULT '',
        description VARCHAR(500) NOT NULL,
        image_data TEXT,
        group_url VARCHAR(1000) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Additive-only migration: no existing publication is altered or deleted here.
    await pool.query("ALTER TABLE groups_public ADD COLUMN IF NOT EXISTS language VARCHAR(32) NOT NULL DEFAULT ''");
    await pool.query('ALTER TABLE groups_public ADD COLUMN IF NOT EXISTS group_url_key TEXT');
    await pool.query('ALTER TABLE groups_public ADD COLUMN IF NOT EXISTS owner_token_hash TEXT');
    await pool.query('ALTER TABLE groups_public ADD COLUMN IF NOT EXISTS contact_url TEXT');
    await pool.query("ALTER TABLE groups_public ADD COLUMN IF NOT EXISTS rules VARCHAR(1200) NOT NULL DEFAULT ''");
    // Legacy publications remain open by default; status can only be active or closed.
    await pool.query("ALTER TABLE groups_public ADD COLUMN IF NOT EXISTS publication_status VARCHAR(12) NOT NULL DEFAULT 'active'");
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='groups_public_publication_status_check' AND conrelid='groups_public'::regclass) THEN
        ALTER TABLE groups_public ADD CONSTRAINT groups_public_publication_status_check CHECK (publication_status IN ('active','closed'));
      END IF;
    END $$`);
    await pool.query('ALTER TABLE groups_public ADD COLUMN IF NOT EXISTS owner_user_id BIGINT REFERENCES app_users(id) ON DELETE SET NULL');
    await pool.query('CREATE INDEX IF NOT EXISTS groups_public_url_key_idx ON groups_public (group_url_key)');
    await pool.query('CREATE INDEX IF NOT EXISTS groups_public_owner_idx ON groups_public (owner_user_id)');
    await pool.query('ALTER TABLE groups_public ADD COLUMN IF NOT EXISTS moderation_hidden BOOLEAN NOT NULL DEFAULT FALSE');
    await pool.query(`CREATE TABLE IF NOT EXISTS group_reports (
      id BIGSERIAL PRIMARY KEY, group_id BIGINT NOT NULL REFERENCES groups_public(id) ON DELETE CASCADE,
      user_id BIGINT REFERENCES app_users(id) ON DELETE SET NULL,
      reason VARCHAR(24) NOT NULL CHECK (reason IN ('spam','scam','abuse','inappropriate','invalid_link','other')),
      details VARCHAR(500) NOT NULL DEFAULT '', status VARCHAR(16) NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','dismissed','actioned')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), reviewed_at TIMESTAMPTZ
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS group_reports_queue_idx ON group_reports (status, created_at DESC)');
    await pool.query(`CREATE TABLE IF NOT EXISTS group_comments (
      id BIGSERIAL PRIMARY KEY, group_id BIGINT NOT NULL REFERENCES groups_public(id) ON DELETE CASCADE,
      user_id BIGINT REFERENCES app_users(id) ON DELETE SET NULL,
      display_name VARCHAR(40) NOT NULL, avatar_data TEXT, comment_text VARCHAR(500) NOT NULL,
      is_anonymous BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query('ALTER TABLE group_comments ADD COLUMN IF NOT EXISTS image_data TEXT');
    await pool.query('ALTER TABLE group_comments ADD COLUMN IF NOT EXISTS parent_comment_id BIGINT REFERENCES group_comments(id) ON DELETE CASCADE');
    await pool.query('CREATE INDEX IF NOT EXISTS group_comments_listing_idx ON group_comments (group_id, created_at DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS group_comments_parent_idx ON group_comments (parent_comment_id) WHERE parent_comment_id IS NOT NULL');
    // Additive comment-report fields: legacy group reports stay classified as group reports.
    await pool.query("ALTER TABLE group_reports ADD COLUMN IF NOT EXISTS target_type VARCHAR(12) NOT NULL DEFAULT 'group'");
    await pool.query('ALTER TABLE group_reports ADD COLUMN IF NOT EXISTS comment_id BIGINT REFERENCES group_comments(id) ON DELETE CASCADE');
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='group_reports_target_type_check' AND conrelid='group_reports'::regclass) THEN
        ALTER TABLE group_reports ADD CONSTRAINT group_reports_target_type_check CHECK (target_type IN ('group','comment'));
      END IF;
    END $$`);
    await pool.query('CREATE INDEX IF NOT EXISTS group_reports_comment_idx ON group_reports (comment_id) WHERE comment_id IS NOT NULL');
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

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>\"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' })[char]);
}
function groupPageHtml(group) {
  const title = `${group.name} | Grupo de WhatsApp en Grupos Web`;
  const baseDescription = String(group.description || '').replace(/\s+/g, ' ').trim();
  const rules = String(group.rules || '').replace(/\s+/g, ' ').trim();
  const language = cleanText(group.language, 32).replace(/\s+/g, ' ');
  const fallbackDescription = 'Descubrí esta comunidad de WhatsApp en Grupos Web.';
  const description = rules
    ? `${(baseDescription || fallbackDescription).slice(0, 200)} · Reglas: ${rules.slice(0, 300 - Math.min((baseDescription || fallbackDescription).length, 200) - 12)}`.slice(0, 300)
    : (baseDescription || fallbackDescription).slice(0, 300);
  const seoDescription = language ? `${description} · Idioma: ${language}`.slice(0, 300) : description;
  const canonical = `https://grupos-web.onrender.com/grupo/${group.id}`;
  const jsonLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebPage', name: title, description: seoDescription, url: canonical, inLanguage: 'es-AR', ...(language ? { keywords: [language] } : {}), isPartOf: { '@type': 'WebSite', name: 'Grupos Web', url: 'https://grupos-web.onrender.com/' } })
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  let html = publicIndexHtml;
  html = html.replace(/<meta name="description" content="[^"]*">/, () => `<meta name="description" content="${escapeHtml(seoDescription)}">`);
  html = html.replace(/<link rel="canonical" href="[^"]*">/, () => `<link rel="canonical" href="${canonical}">`);
  html = html.replace(/<meta property="og:title" content="[^"]*">/, () => `<meta property="og:title" content="${escapeHtml(title)}">`);
  html = html.replace(/<meta property="og:description" content="[^"]*">/, () => `<meta property="og:description" content="${escapeHtml(seoDescription)}">`);
  html = html.replace(/<meta property="og:url" content="[^"]*">/, () => `<meta property="og:url" content="${canonical}">`);
  html = html.replace(/<meta name="twitter:card" content="[^"]*">/, () => '<meta name="twitter:card" content="summary">');
  html = html.replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(title)}</title>`);
  return html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, () => `<script type="application/ld+json">${jsonLd}</script>`);
}

app.get('/grupo/:id', requireDatabase, async (req, res, next) => {
  const id = /^\d+$/.test(req.params.id) ? req.params.id : '';
  if (!id) return res.status(404).type('text').send('No se encontró la publicación.');
  try {
    const result = await pool.query('SELECT id, name, category, language, description, rules FROM groups_public WHERE id=$1 AND moderation_hidden=FALSE LIMIT 1', [id]);
    if (!result.rowCount) return res.status(404).type('text').send('No se encontró la publicación.');
    res.type('html').send(groupPageHtml(result.rows[0]));
  } catch (error) { next(error); }
});

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

app.post('/api/account/password', requireDatabase, requireSameOrigin, optionalAuth, requireUser, limited, async (req, res, next) => {
  const currentPassword = typeof (req.body && req.body.currentPassword) === 'string' ? req.body.currentPassword : '';
  const newPassword = typeof (req.body && req.body.newPassword) === 'string' ? req.body.newPassword : '';
  if (newPassword.length < 12 || newPassword.length > 200) return res.status(400).json({ error: 'La nueva contraseña debe tener entre 12 y 200 caracteres.' });
  try {
    const result = await pool.query('SELECT password_salt,password_hash FROM app_users WHERE id=$1 LIMIT 1', [req.user.id]);
    if (!result.rowCount) return res.status(401).json({ error: 'Iniciá sesión nuevamente.' });
    const user = result.rows[0];
    const currentHash = await scrypt(currentPassword, user.password_salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    if (!safeEqualHex(currentHash.toString('hex'), user.password_hash)) return res.status(401).json({ error: 'La contraseña actual no coincide.' });
    const salt = crypto.randomBytes(16).toString('hex');
    const nextHash = await scrypt(newPassword, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const token = req.cookies[SESSION_COOKIE] || '';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE app_users SET password_salt=$1,password_hash=$2 WHERE id=$3', [salt, nextHash.toString('hex'), req.user.id]);
      await client.query('DELETE FROM app_sessions WHERE user_id=$1 AND token_hash<>$2', [req.user.id, hashToken(token)]);
      await client.query('COMMIT');
    } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
    finally { client.release(); }
    res.json({ ok: true, message: 'Contraseña actualizada. Se cerraron las demás sesiones de tu cuenta.' });
  } catch (error) { next(error); }
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
      SELECT g.id, g.name, g.category, g.language, g.description, g.rules, g.publication_status, g.image_data, g.group_url, g.contact_url, g.created_at,
             ROUND(AVG(r.rating)::numeric, 1) AS rating_average,
             COUNT(r.id)::int AS rating_count,
             COALESCE(MAX(CASE WHEN r.user_id=$1 THEN r.rating END),0)::int AS my_rating,
             (g.owner_user_id=$1) AS is_owner
      FROM groups_public g LEFT JOIN group_ratings r ON r.group_id=g.id
      WHERE g.moderation_hidden=FALSE
      GROUP BY g.id ORDER BY g.created_at DESC LIMIT 300
    `, [req.user ? req.user.id : null]);
    res.json(result.rows);
  } catch (error) { next(error); }
});

app.post('/api/groups', requireDatabase, requireSameOrigin, optionalAuth, requireUser, limitPosts, async (req, res, next) => {
  const name = cleanText(req.body && req.body.name, 70);
  const category = cleanText(req.body && req.body.category, 32) || 'General';
  const language = cleanText(req.body && req.body.language, 32);
  const description = cleanText(req.body && req.body.description, 500);
  const rules = cleanText(req.body && req.body.rules, 1200);
  const publicationStatus = req.body && req.body.publicationStatus !== undefined ? req.body.publicationStatus : 'active';
  const groupUrl = validPublicUrl(cleanText(req.body && req.body.groupUrl, 1000));
  const groupUrlKey = groupUrl ? normalizeGroupUrl(groupUrl) : '';
  const imageData = typeof (req.body && req.body.imageData) === 'string' ? req.body.imageData : '';
  const contactInput = cleanText(req.body && req.body.contactUrl, 100);
  const contactUrl = validContactUrl(contactInput);
  if (!['active','closed'].includes(publicationStatus)) return res.status(400).json({ error: 'Elegí si el grupo está abierto o cerrado a nuevos miembros.' });
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
      INSERT INTO groups_public (name, category, language, description, rules, publication_status, image_data, group_url, group_url_key, contact_url, owner_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING id, name, category, language, description, rules, publication_status, image_data, group_url, contact_url, created_at
    `, [name, category, language, description, rules, publicationStatus, imageData || null, groupUrl, groupUrlKey, contactUrl || null, req.user.id]);
    await client.query('COMMIT');
    res.status(201).json({ ...result.rows[0], rating_average: null, rating_count: 0, my_rating: 0, is_owner: true });
  } catch (error) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    console.error('Error publicando grupo:', error.message);
    next(error);
  } finally { if (client) client.release(); }
});

app.get('/api/groups/:id', requireDatabase, optionalAuth, async (req, res, next) => {
  const id = /^\d+$/.test(req.params.id) ? req.params.id : '';
  if (!id) return res.status(404).json({ error: 'No se encontró la publicación.' });
  try {
    const result = await pool.query(`
      SELECT g.id, g.name, g.category, g.language, g.description, g.rules, g.publication_status, g.image_data, g.group_url, g.contact_url, g.created_at,
             ROUND(AVG(r.rating)::numeric, 1) AS rating_average, COUNT(r.id)::int AS rating_count,
             COALESCE(MAX(CASE WHEN r.user_id=$2 THEN r.rating END),0)::int AS my_rating,
             (g.owner_user_id=$2) AS is_owner
      FROM groups_public g LEFT JOIN group_ratings r ON r.group_id=g.id
      WHERE g.id=$1 AND g.moderation_hidden=FALSE
      GROUP BY g.id LIMIT 1
    `, [id, req.user ? req.user.id : null]);
    if (!result.rowCount) return res.status(404).json({ error: 'No se encontró la publicación.' });
    res.json(result.rows[0]);
  } catch (error) { next(error); }
});

app.get('/api/groups/:id/related', requireDatabase, async (req, res, next) => {
  const id = /^\d+$/.test(req.params.id) ? req.params.id : '';
  if (!id) return res.status(400).json({ error: 'Publicación inválida.' });
  try {
    const result = await pool.query(`
      SELECT related.id, related.name, related.category
      FROM groups_public current
      JOIN groups_public related ON related.category=current.category
      WHERE current.id=$1 AND current.moderation_hidden=FALSE
        AND related.id<>current.id AND related.moderation_hidden=FALSE
      ORDER BY related.created_at DESC, related.id DESC LIMIT 4
    `, [id]);
    res.json(result.rows);
  } catch (error) { next(error); }
});

app.get('/api/groups/:id/comments', requireDatabase, optionalAuth, async (req, res, next) => {
  const id = /^\d+$/.test(req.params.id) ? req.params.id : '';
  const offset = /^\d+$/.test(req.query.offset || '') ? Math.min(Number(req.query.offset), 1000000) : 0;
  const limit = /^\d+$/.test(req.query.limit || '') ? Math.min(Math.max(Number(req.query.limit), 1), 50) : 25;
  if (!id) return res.status(400).json({ error: 'Publicación inválida.' });
  try {
    const [result, count] = await Promise.all([
      pool.query(`SELECT c.id, c.display_name, c.avatar_data, c.comment_text, c.image_data, c.is_anonymous,
          c.parent_comment_id, parent.display_name AS reply_to_name, c.created_at,
          (c.user_id=$4 AND c.user_id IS NOT NULL AND c.is_anonymous=FALSE) AS can_edit
        FROM group_comments c LEFT JOIN group_comments parent ON parent.id=c.parent_comment_id
        WHERE c.group_id=$1 ORDER BY c.created_at DESC, c.id DESC LIMIT $2 OFFSET $3`, [id, limit, offset, req.user ? req.user.id : null]),
      pool.query('SELECT COUNT(*)::int AS total FROM group_comments WHERE group_id=$1', [id])
    ]);
    if (req.query.offset === undefined && req.query.limit === undefined) return res.json(result.rows);
    res.json({ items: result.rows, total: count.rows[0].total, offset, limit });
  } catch (error) { next(error); }
});
function limitCommentActions(req, res, next) {
  const now = Date.now(), key = req.ip || 'unknown';
  let row = commentActionAttempts.get(key);
  if (!row || row.until < now) row = { count: 0, until: now + 60 * 60 * 1000 };
  if (row.count >= 20) return res.status(429).json({ error: 'Llegaste al límite de cambios en comentarios por ahora. Probá más tarde.' });
  row.count++; commentActionAttempts.set(key, row);
  if (commentActionAttempts.size > 5000) for (const [k, v] of commentActionAttempts) if (v.until < now) commentActionAttempts.delete(k);
  next();
}

app.post('/api/groups/:id/comments', requireDatabase, requireSameOrigin, optionalAuth, async (req, res, next) => {
  const id = /^\d+$/.test(req.params.id) ? req.params.id : '';
  const text = cleanText(req.body && req.body.text, 500);
  const imageData = typeof (req.body && req.body.imageData) === 'string' ? req.body.imageData : '';
  const identity = req.body && req.body.identity === 'profile' ? 'profile' : 'anonymous';
  const rawParentId = req.body && req.body.parentId != null ? String(req.body.parentId) : '';
  const parentId = /^\d+$/.test(rawParentId) ? rawParentId : '';
  if (!id) return res.status(400).json({ error: 'Publicación inválida.' });
  if (rawParentId && !parentId) return res.status(400).json({ error: 'Comentario de respuesta inválido.' });
  if (!text && !imageData) return res.status(400).json({ error: 'Escribí un comentario o elegí una foto.' });
  if (imageData && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(imageData) || imageData.length > 600000)) return res.status(400).json({ error: 'La foto no es válida o pesa demasiado.' });
  const key = req.ip || 'unknown', now = Date.now(); let attempt = commentAttempts.get(key);
  if (!attempt || attempt.until < now) attempt = { count: 0, until: now + 60 * 60 * 1000 };
  if (attempt.count >= 12) return res.status(429).json({ error: 'Llegaste al límite de comentarios por ahora. Probá más tarde.' });
  attempt.count++; commentAttempts.set(key, attempt);
  if ((identity === 'profile' || parentId) && !req.user) return res.status(401).json({ error: 'Iniciá sesión para responder o comentar con tu perfil; también podés comentar como anónimo.' });
  if (parentId && identity !== 'profile') return res.status(400).json({ error: 'Las respuestas se publican con un perfil.' });
  try {
    const author = identity === 'profile' ? (req.user.display_name || req.user.username) : 'Anónimo';
    const avatar = identity === 'profile' ? req.user.avatar_data : null;
    const result = await pool.query(`INSERT INTO group_comments (group_id,user_id,display_name,avatar_data,comment_text,is_anonymous,image_data,parent_comment_id)
      SELECT g.id,$2,$3,$4,$5,$6,$7,CASE WHEN $8::bigint IS NULL THEN NULL ELSE p.id END
      FROM groups_public g LEFT JOIN group_comments p ON p.id=$8 AND p.group_id=g.id AND p.parent_comment_id IS NULL
      WHERE g.id=$1 AND ($8::bigint IS NULL OR p.id IS NOT NULL)
      RETURNING id, display_name, avatar_data, comment_text, image_data, is_anonymous, parent_comment_id, created_at`,
      [id, identity === 'profile' ? req.user.id : null, author, avatar, text, identity === 'anonymous', imageData || null, parentId || null]);
    if (!result.rowCount) return res.status(404).json({ error: parentId ? 'No se encontró ese comentario o ya no admite respuestas.' : 'Ese grupo ya no está publicado.' });
    res.status(201).json(result.rows[0]);
  } catch (error) { next(error); }
});

app.patch('/api/groups/:id/comments/:commentId', requireDatabase, requireSameOrigin, optionalAuth, requireUser, limitCommentActions, async (req, res, next) => {
  const groupId = /^\d+$/.test(req.params.id) ? req.params.id : '';
  const commentId = /^\d+$/.test(req.params.commentId) ? req.params.commentId : '';
  const text = cleanText(req.body && req.body.text, 500);
  if (!groupId || !commentId) return res.status(400).json({ error: 'Comentario inválido.' });
  if (typeof (req.body && req.body.text) !== 'string' || req.body.text.trim().length > 500) return res.status(400).json({ error: 'El comentario debe tener hasta 500 caracteres.' });
  try {
    const result = await pool.query(`UPDATE group_comments SET comment_text=$1
      WHERE id=$2 AND group_id=$3 AND user_id=$4 AND is_anonymous=FALSE AND ($1<>'' OR image_data IS NOT NULL)
      RETURNING id,comment_text,created_at`, [text,commentId,groupId,req.user.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'No se encontró un comentario editable de tu perfil.' });
    res.json(result.rows[0]);
  } catch (error) { next(error); }
});

app.delete('/api/groups/:id/comments/:commentId', requireDatabase, requireSameOrigin, optionalAuth, requireUser, limitCommentActions, async (req, res, next) => {
  const groupId = /^\d+$/.test(req.params.id) ? req.params.id : '';
  const commentId = /^\d+$/.test(req.params.commentId) ? req.params.commentId : '';
  if (!groupId || !commentId) return res.status(400).json({ error: 'Comentario inválido.' });
  try {
    const result = await pool.query(`DELETE FROM group_comments WHERE id=$1 AND group_id=$2 AND user_id=$3 AND is_anonymous=FALSE RETURNING id`, [commentId,groupId,req.user.id]);
    if (!result.rowCount) return res.status(404).json({ error: 'No se encontró un comentario que puedas borrar.' });
    res.json({ ok: true, id: result.rows[0].id });
  } catch (error) { next(error); }
});

function limitReports(req, res, next) {
  const now = Date.now(), key = req.ip || 'unknown';
  let row = reportAttempts.get(key);
  if (!row || row.until < now) row = { count: 0, until: now + 60 * 60 * 1000 };
  if (row.count >= 3) return res.status(429).json({ error: 'Llegaste al límite de denuncias por ahora. Probá más tarde.' });
  row.count++; reportAttempts.set(key, row);
  if (reportAttempts.size > 5000) for (const [k, v] of reportAttempts) if (v.until < now) reportAttempts.delete(k);
  next();
}
const reportReasons = new Set(['spam','scam','abuse','inappropriate','invalid_link','other']);
app.post('/api/groups/:id/reports', requireDatabase, requireSameOrigin, optionalAuth, limitReports, async (req, res, next) => {
  const id = /^\d+$/.test(req.params.id) ? req.params.id : '';
  const reason = typeof (req.body && req.body.reason) === 'string' ? req.body.reason : '';
  const details = cleanText(req.body && req.body.details, 500);
  if (!id) return res.status(400).json({ error: 'Publicación inválida.' });
  if (!reportReasons.has(reason)) return res.status(400).json({ error: 'Elegí un motivo válido para la denuncia.' });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('gw_report_queue_cap_v1')::bigint)");
    const total = await client.query("SELECT COUNT(*)::int AS count FROM group_reports WHERE status='open'");
    if (total.rows[0].count >= 2000) { await client.query('ROLLBACK'); return res.status(503).json({ error: 'La cola de revisión está temporalmente llena. Intentá más tarde.' }); }
    const recent = await client.query("SELECT COUNT(*)::int AS count FROM group_reports WHERE group_id=$1 AND status='open' AND created_at > NOW() - INTERVAL '24 hours'", [id]);
    if (recent.rows[0].count >= 100) { await client.query('ROLLBACK'); return res.status(429).json({ error: 'Este grupo ya alcanzó el límite temporal de denuncias abiertas.' }); }
    const result = await client.query(`INSERT INTO group_reports (group_id,target_type,user_id,reason,details)
      SELECT id,'group',$2,$3,$4 FROM groups_public WHERE id=$1 RETURNING id,created_at`,
      [id, req.user ? req.user.id : null, reason, details]);
    if (!result.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No se encontró esa publicación.' }); }
    await client.query('COMMIT');
    res.status(201).json({ ok: true, message: 'Gracias. La denuncia quedó registrada de forma privada; la revisión no está habilitada actualmente.' });
  } catch (error) { if (client) { try { await client.query('ROLLBACK'); } catch {} } next(error); }
  finally { if (client) client.release(); }
});
app.post('/api/groups/:id/comments/:commentId/reports', requireDatabase, requireSameOrigin, optionalAuth, limitReports, async (req, res, next) => {
  const groupId = /^\d+$/.test(req.params.id) ? req.params.id : '';
  const commentId = /^\d+$/.test(req.params.commentId) ? req.params.commentId : '';
  const reason = typeof (req.body && req.body.reason) === 'string' ? req.body.reason : '';
  const details = cleanText(req.body && req.body.details, 500);
  if (!groupId || !commentId) return res.status(400).json({ error: 'Comentario inválido.' });
  if (!reportReasons.has(reason)) return res.status(400).json({ error: 'Elegí un motivo válido para la denuncia.' });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('gw_report_queue_cap_v1')::bigint)");
    const total = await client.query("SELECT COUNT(*)::int AS count FROM group_reports WHERE status='open'");
    if (total.rows[0].count >= 2000) { await client.query('ROLLBACK'); return res.status(503).json({ error: 'La cola de revisión está temporalmente llena. Intentá más tarde.' }); }
    const recent = await client.query("SELECT COUNT(*)::int AS count FROM group_reports WHERE group_id=$1 AND status='open' AND created_at > NOW() - INTERVAL '24 hours'", [groupId]);
    if (recent.rows[0].count >= 100) { await client.query('ROLLBACK'); return res.status(429).json({ error: 'Este grupo ya alcanzó el límite temporal de denuncias abiertas.' }); }
    const result = await client.query(`INSERT INTO group_reports (group_id,comment_id,target_type,user_id,reason,details)
      SELECT g.id,c.id,'comment',$3,$4,$5 FROM groups_public g
      JOIN group_comments c ON c.group_id=g.id AND c.id=$2 WHERE g.id=$1
      RETURNING id,created_at`, [groupId, commentId, req.user ? req.user.id : null, reason, details]);
    if (!result.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No se encontró ese comentario en esta publicación.' }); }
    await client.query('COMMIT');
    res.status(201).json({ ok: true, message: 'Gracias. La denuncia quedó registrada de forma privada; la revisión no está habilitada actualmente.' });
  } catch (error) { if (client) { try { await client.query('ROLLBACK'); } catch {} } next(error); }
  finally { if (client) client.release(); }
});
function requireModerationSecret(req, res, next) {
  const expected = process.env.MODERATION_TOKEN || '';
  if (expected.length < 32) return res.status(503).json({ error: 'La revisión de moderación no está configurada.' });
  const supplied = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(expected), b = Buffer.from(supplied);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'No autorizado.' });
  next();
}
app.get('/api/moderation/reports', requireDatabase, requireModerationSecret, async (req, res, next) => {
  try {
    const result = await pool.query(`SELECT r.id,r.group_id,g.name AS group_name,r.target_type,r.comment_id,r.reason,r.details,r.status,r.created_at
      FROM group_reports r JOIN groups_public g ON g.id=r.group_id
      WHERE r.status='open' ORDER BY r.created_at ASC LIMIT 100`);
    res.json({ items: result.rows });
  } catch (error) { next(error); }
});
app.patch('/api/moderation/reports/:id', requireDatabase, requireModerationSecret, async (req, res, next) => {
  const id = /^\d+$/.test(req.params.id) ? req.params.id : '';
  const action = req.body && req.body.action;
  if (!id || !['dismiss','hide-group','restore-group'].includes(action)) return res.status(400).json({ error: 'Acción de moderación inválida.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const report = await client.query('SELECT id,group_id,target_type,comment_id FROM group_reports WHERE id=$1 FOR UPDATE', [id]);
    if (!report.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Denuncia no encontrada.' }); }
    if (action === 'hide-group') await client.query('UPDATE groups_public SET moderation_hidden=TRUE WHERE id=$1', [report.rows[0].group_id]);
    if (action === 'restore-group') await client.query('UPDATE groups_public SET moderation_hidden=FALSE WHERE id=$1', [report.rows[0].group_id]);
    await client.query("UPDATE group_reports SET status=$1,reviewed_at=NOW() WHERE id=$2", [action === 'dismiss' ? 'dismissed' : 'actioned', id]);
    await client.query('COMMIT');
    res.json({ ok: true, action, group_id: report.rows[0].group_id, target_type: report.rows[0].target_type, comment_id: report.rows[0].comment_id });
  } catch (error) { try { await client.query('ROLLBACK'); } catch {} next(error); }
  finally { client.release(); }
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

app.patch('/api/groups/:id', requireDatabase, requireSameOrigin, optionalAuth, requireUser, limitPosts, async (req, res, next) => {
  const id = /^\d+$/.test(req.params.id) ? req.params.id : '';
  if (!id) return res.status(400).json({ error: 'Publicación inválida.' });
  const name = cleanText(req.body && req.body.name, 70);
  const category = cleanText(req.body && req.body.category, 32) || 'General';
  const hasLanguage = Object.prototype.hasOwnProperty.call(req.body || {}, 'language');
  const language = hasLanguage ? cleanText(req.body.language, 32) : null;
  const description = cleanText(req.body && req.body.description, 500);
  const rules = cleanText(req.body && req.body.rules, 1200);
  const hasPublicationStatus = Object.prototype.hasOwnProperty.call(req.body || {}, 'publicationStatus');
  const publicationStatus = hasPublicationStatus ? req.body.publicationStatus : null;
  const groupUrl = validPublicUrl(cleanText(req.body && req.body.groupUrl, 1000));
  const groupUrlKey = groupUrl ? normalizeGroupUrl(groupUrl) : '';
  const contactInput = cleanText(req.body && req.body.contactUrl, 100);
  const contactUrl = validContactUrl(contactInput);
  const hasImage = Object.prototype.hasOwnProperty.call(req.body || {}, 'imageData');
  const imageData = hasImage && typeof req.body.imageData === 'string' ? req.body.imageData : '';
  if (hasPublicationStatus && !['active','closed'].includes(publicationStatus)) return res.status(400).json({ error: 'Elegí si el grupo está abierto o cerrado a nuevos miembros.' });
  if (name.length < 2) return res.status(400).json({ error: 'El nombre debe tener al menos 2 caracteres.' });
  if (description.length < 5) return res.status(400).json({ error: 'La descripción debe tener al menos 5 caracteres.' });
  if (!groupUrl || !groupUrlKey) return res.status(400).json({ error: 'Ingresá un enlace público que empiece con http:// o https://.' });
  if (contactInput && !contactUrl) return res.status(400).json({ error: 'El contacto debe ser un número de WhatsApp con código de país o un enlace wa.me válido.' });
  if (hasImage && imageData && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(imageData) || imageData.length > 2100000)) return res.status(400).json({ error: 'La foto no es válida o pesa demasiado. Probá con otra imagen.' });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [groupUrlKey]);
    const duplicate = await client.query('SELECT id FROM groups_public WHERE group_url_key=$1 AND id<>$2 LIMIT 1', [groupUrlKey, id]);
    if (duplicate.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Este enlace de grupo o team ya fue subido.' }); }
    const result = await client.query(`UPDATE groups_public SET name=$1,category=$2,description=$3,rules=$4,
      language=CASE WHEN $5 THEN $6 ELSE language END,
      image_data=CASE WHEN $7 THEN NULLIF($8,'') ELSE image_data END, group_url=$9,group_url_key=$10,contact_url=NULLIF($11,''),
      publication_status=CASE WHEN $12 THEN $13 ELSE publication_status END
      WHERE id=$14 AND owner_user_id=$15
      RETURNING id,name,category,language,description,rules,publication_status,image_data,group_url,contact_url,created_at`,
      [name,category,description,rules,hasLanguage,language,hasImage,imageData,groupUrl,groupUrlKey,contactUrl,hasPublicationStatus,publicationStatus,id,req.user.id]);
    if (!result.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Solo quien publicó este grupo puede editarlo.' }); }
    await client.query('COMMIT');
    const stats = await pool.query('SELECT ROUND(AVG(rating)::numeric,1) AS rating_average, COUNT(*)::int AS rating_count, COALESCE(MAX(CASE WHEN user_id=$2 THEN rating END),0)::int AS my_rating FROM group_ratings WHERE group_id=$1', [id,req.user.id]);
    res.json({ ...result.rows[0], ...stats.rows[0], is_owner: true });
  } catch (error) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    next(error);
  } finally { if (client) client.release(); }
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
