/* ============================================================================
 * API de sincronización — una sola ruta: /api/state  (función serverless de Vercel)
 *
 *   GET  → { ok, rev, savedAt, state }       estado guardado en la nube (state = null si está vacía)
 *   PUT  → { baseRev, state }                guarda si baseRev coincide con la revisión actual
 *          200 { ok, rev }  ·  409 { conflict } si alguien guardó antes  ·  413 si es demasiado grande
 *
 * Seguridad: toda petición exige  Authorization: Bearer <APP_PASSWORD>.
 * Si APP_PASSWORD no está definida la API responde 503 y no guarda nada (nunca queda abierta).
 *
 * Almacenamiento (se elige solo según las variables de entorno):
 *   1. Upstash Redis (Vercel Marketplace): KV_REST_API_URL + KV_REST_API_TOKEN
 *      (o UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN). Sin dependencias: usa su API REST.
 *   2. Archivo local .data/estado.json — SOLO fuera de Vercel (desarrollo y pruebas).
 * ========================================================================== */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const K_STATE = 'ev-ops:estado';
const K_REV = 'ev-ops:rev';
const K_AT = 'ev-ops:guardado';
const MAX_BYTES = 900 * 1000; // por debajo del tope de ~1 MB por petición de Upstash

/* ---------- almacenamiento ---------- */

/** Guarda solo si la revisión actual es igual a baseRev (compare-and-set atómico en Redis). */
const LUA_CAS = [
  "local rev = tonumber(redis.call('GET', KEYS[2]) or '0')",
  'if rev ~= tonumber(ARGV[1]) then return {0, rev} end',
  'rev = rev + 1',
  "redis.call('SET', KEYS[1], ARGV[2])",
  "redis.call('SET', KEYS[2], tostring(rev))",
  "redis.call('SET', KEYS[3], ARGV[3])",
  'return {1, rev}'
].join('\n');

function upstashStore(url, token) {
  async function cmd(args) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new Error('Upstash: ' + (json.error || 'HTTP ' + res.status));
    return json.result;
  }
  return {
    async get() {
      const [estado, rev, savedAt] = await cmd(['MGET', K_STATE, K_REV, K_AT]);
      return { estado: estado || null, rev: Number(rev) || 0, savedAt: savedAt || null };
    },
    async put(baseRev, estado, savedAt) {
      const [ok, rev] = await cmd(['EVAL', LUA_CAS, '3', K_STATE, K_REV, K_AT, String(baseRev), estado, savedAt]);
      return { ok: ok === 1, rev: Number(rev) };
    }
  };
}

function fileStore(dir) {
  const file = path.join(dir, 'estado.json');
  const leer = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { estado: null, rev: 0, savedAt: null }; } };
  return {
    async get() { return leer(); },
    async put(baseRev, estado, savedAt) {
      const actual = leer();
      if (actual.rev !== baseRev) return { ok: false, rev: actual.rev };
      fs.mkdirSync(dir, { recursive: true });
      const nuevo = { estado, rev: actual.rev + 1, savedAt };
      fs.writeFileSync(file, JSON.stringify(nuevo));
      return { ok: true, rev: nuevo.rev };
    }
  };
}

function getStore(env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return upstashStore(url, token);
  if (!env.VERCEL) return fileStore(env.EVOPS_DATA_DIR || path.join(__dirname, '..', '.data'));
  return null;
}

/* ---------- utilidades ---------- */

/** Comparación en tiempo constante (evita filtrar la contraseña por tiempos de respuesta). */
function igual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

async function leerJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let raw = typeof req.body === 'string' ? req.body : '';
  if (!raw) {
    const partes = [];
    let bytes = 0;
    for await (const parte of req) {
      bytes += parte.length;
      if (bytes > MAX_BYTES + 100 * 1000) { const e = new Error('grande'); e.code = 'grande'; throw e; }
      partes.push(parte);
    }
    raw = Buffer.concat(partes).toString('utf8');
  }
  return JSON.parse(raw);
}

const esEstadoPlausible = (s) =>
  s && typeof s === 'object' && !Array.isArray(s) && Number.isInteger(s.schemaVersion) && Array.isArray(s.etapas) && Array.isArray(s.tareas);

/* ---------- handler ---------- */

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const enviar = (codigo, cuerpo) => { res.statusCode = codigo; res.end(JSON.stringify({ app: 'ev-ops', ...cuerpo })); };
  const env = process.env;

  if (!env.APP_PASSWORD) return enviar(503, { ok: false, code: 'sin_password', message: 'Falta definir la variable APP_PASSWORD en el servidor.' });
  const store = getStore(env);
  if (!store) return enviar(503, { ok: false, code: 'sin_base', message: 'Falta conectar la base de datos (Upstash Redis) al proyecto.' });

  const auth = String(req.headers.authorization || '');
  const dada = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!igual(dada, env.APP_PASSWORD)) {
    await new Promise((r) => setTimeout(r, 500)); // frena la fuerza bruta
    return enviar(401, { ok: false, code: 'no_autorizado', message: 'Contraseña incorrecta.' });
  }

  try {
    if (req.method === 'GET') {
      const d = await store.get();
      return enviar(200, { ok: true, rev: d.rev, savedAt: d.savedAt, state: d.estado ? JSON.parse(d.estado) : null });
    }
    if (req.method === 'PUT') {
      let body;
      try { body = await leerJson(req); }
      catch (e) { return e.code === 'grande' ? enviar(413, { ok: false, code: 'muy_grande', message: 'Los datos superan el tamaño máximo.' }) : enviar(400, { ok: false, code: 'json', message: 'El cuerpo no es un JSON válido.' }); }
      if (!body || !Number.isInteger(body.baseRev) || body.baseRev < 0 || !esEstadoPlausible(body.state)) return enviar(400, { ok: false, code: 'formato', message: 'Formato de datos inválido.' });
      const estado = JSON.stringify(body.state);
      if (Buffer.byteLength(estado) > MAX_BYTES) return enviar(413, { ok: false, code: 'muy_grande', message: 'Los datos superan el tamaño máximo (' + Math.round(MAX_BYTES / 1000) + ' KB).' });
      const r = await store.put(body.baseRev, estado, new Date().toISOString());
      return r.ok ? enviar(200, { ok: true, rev: r.rev }) : enviar(409, { ok: false, conflict: true, code: 'conflicto', rev: r.rev, message: 'La nube cambió desde la última sincronización.' });
    }
    res.setHeader('Allow', 'GET, PUT');
    return enviar(405, { ok: false, code: 'metodo', message: 'Método no permitido.' });
  } catch (e) {
    console.error('[api/state]', e);
    return enviar(500, { ok: false, code: 'error', message: 'Error del servidor al acceder a la base de datos.' });
  }
}

module.exports = handler;
module.exports.default = handler;
