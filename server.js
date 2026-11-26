'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
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

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '3mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
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
    // Additive-only migration: keep every existing listing and its current fields intact.
    await pool.query('ALTER TABLE groups_public ADD COLUMN IF NOT EXISTS group_url_key TEXT');
    await pool.query('ALTER TABLE groups_public ADD COLUMN IF NOT EXISTS owner_token_hash TEXT');
    await pool.query('ALTER TABLE groups_public ADD COLUMN IF NOT EXISTS contact_url TEXT');
    await pool.query('CREATE INDEX IF NOT EXISTS groups_public_url_key_idx ON groups_public (group_url_key)');
    const legacy = await pool.query('SELECT id, group_url FROM groups_public WHERE group_url_key IS NULL');
    for (const row of legacy.rows) {
      const key = normalizeGroupUrl(row.group_url);
      await pool.query('UPDATE groups_public SET group_url_key = $1 WHERE id = $2 AND group_url_key IS NULL', [key, row.id]);
    }
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

// Límite sencillo por IP para reducir publicaciones automáticas; se reinicia al reiniciar el servidor.
const attempts = new Map();
function limitPosts(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const entry = attempts.get(key) || { count: 0, until: now + 60 * 60 * 1000 };
  if (now > entry.until) { entry.count = 0; entry.until = now + 60 * 60 * 1000; }
  if (entry.count >= 8) return res.status(429).json({ error: 'Se alcanzó el límite de publicaciones desde esta conexión. Probá más tarde.' });
  entry.count += 1;
  attempts.set(key, entry);
  if (attempts.size > 5000) {
    for (const [ip, value] of attempts) if (now > value.until) attempts.delete(ip);
  }
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
function hashOwnerToken(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

app.get('/health', (req, res) => res.status(dbReady ? 200 : 503).json({ ok: dbReady, database: dbReady ? 'ready' : 'waiting' }));

app.get('/api/groups', requireDatabase, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, category, description, image_data, group_url, contact_url, created_at
      FROM groups_public ORDER BY created_at DESC LIMIT 300
    `);
    res.json(result.rows);
  } catch (error) {
    dbReady = false;
    console.error('Error leyendo grupos:', error.message);
    res.status(500).json({ error: 'No se pudieron cargar los grupos.' });
  }
});

app.post('/api/groups', requireDatabase, limitPosts, async (req, res) => {
  const name = cleanText(req.body && req.body.name, 70);
  const category = cleanText(req.body && req.body.category, 32) || 'General';
  const description = cleanText(req.body && req.body.description, 500);
  const groupUrl = validPublicUrl(cleanText(req.body && req.body.groupUrl, 1000));
  const groupUrlKey = groupUrl ? normalizeGroupUrl(groupUrl) : '';
  const imageData = typeof (req.body && req.body.imageData) === 'string' ? req.body.imageData : '';
  const ownerToken = typeof (req.body && req.body.ownerToken) === 'string' ? req.body.ownerToken : '';
  const contactInput = cleanText(req.body && req.body.contactUrl, 100);
  const contactUrl = validContactUrl(contactInput);

  if (name.length < 2) return res.status(400).json({ error: 'El nombre debe tener al menos 2 caracteres.' });
  if (description.length < 5) return res.status(400).json({ error: 'La descripción debe tener al menos 5 caracteres.' });
  if (!groupUrl || !groupUrlKey) return res.status(400).json({ error: 'Ingresá un enlace público que empiece con http:// o https://.' });
  if (!/^[a-f0-9]{64}$/.test(ownerToken)) return res.status(400).json({ error: 'No se pudo preparar la clave privada para administrar esta publicación. Recargá la página e intentá de nuevo.' });
  if (contactInput && !contactUrl) return res.status(400).json({ error: 'El contacto debe ser un número de WhatsApp con código de país o un enlace wa.me válido.' });
  if (imageData && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(imageData) || imageData.length > 2100000)) {
    return res.status(400).json({ error: 'La foto no es válida o pesa demasiado. Probá con otra imagen.' });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // Serialize creates for the same canonical URL without imposing a unique index
    // that could reject the database if old listings already contain duplicates.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [groupUrlKey]);
    const duplicate = await client.query('SELECT id FROM groups_public WHERE group_url_key = $1 LIMIT 1', [groupUrlKey]);
    if (duplicate.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Este enlace de grupo o team ya fue subido.' });
    }
    const result = await client.query(`
      INSERT INTO groups_public (name, category, description, image_data, group_url, group_url_key, owner_token_hash, contact_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, name, category, description, image_data, group_url, contact_url, created_at
    `, [name, category, description, imageData || null, groupUrl, groupUrlKey, hashOwnerToken(ownerToken), contactUrl || null]);
    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Error publicando grupo:', error.message);
    res.status(500).json({ error: 'No se pudo publicar el grupo. Probá de nuevo.' });
  } finally { if (client) client.release(); }
});

app.post('/api/groups/:id/delete', requireDatabase, async (req, res) => {
  const id = /^\d+$/.test(req.params.id) ? req.params.id : '';
  const ownerToken = typeof (req.body && req.body.ownerToken) === 'string' ? req.body.ownerToken : '';
  if (!id || !/^[a-f0-9]{64}$/.test(ownerToken)) return res.status(404).json({ error: 'No se pudo verificar que seas quien publicó este grupo.' });
  try {
    const result = await pool.query(
      'DELETE FROM groups_public WHERE id = $1 AND owner_token_hash = $2 RETURNING id',
      [id, hashOwnerToken(ownerToken)]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'No se pudo verificar que seas quien publicó este grupo.' });
    res.json({ ok: true, id: result.rows[0].id });
  } catch (error) {
    dbReady = false;
    console.error('Error borrando grupo:', error.message);
    res.status(500).json({ error: 'No se pudo borrar el grupo. Probá de nuevo.' });
  }
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'La foto es demasiado grande. Elegí una más liviana.' });
  console.error('Error inesperado:', err && err.message);
  res.status(500).json({ error: 'Ocurrió un error inesperado.' });
});

app.listen(port, () => {
  console.log(`Grupos-Web escuchando en el puerto ${port}`);
  initializeDatabase();
  if (pool) setInterval(initializeDatabase, 15000).unref();
});
