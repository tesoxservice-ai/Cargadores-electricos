// Pruebas de extremo a extremo de la sincronización: el módulo Sync de index.html (en un contexto sin DOM)
// hablando con el handler REAL de api/state.js, con una base de datos en un archivo temporal.
// Se simulan dos computadoras (A y B) con su propio localStorage y un servidor compartido.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(raiz, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const code = scripts[scripts.length - 1][1];
const handler = createRequire(import.meta.url)(join(raiz, 'api', 'state.js'));
const same = (a, b, msg) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg);

const PASS = 'clave-de-prueba-123';
process.env.APP_PASSWORD = PASS;
delete process.env.VERCEL; delete process.env.KV_REST_API_URL; delete process.env.UPSTASH_REDIS_REST_URL;
const datos = mkdtempSync(join(tmpdir(), 'evops-'));
process.env.EVOPS_DATA_DIR = datos;
test.after(() => rmSync(datos, { recursive: true, force: true }));
beforeEach(() => rmSync(join(datos, 'estado.json'), { force: true })); // cada prueba empieza con la nube vacía

/** Llama al handler real como lo haría Vercel y devuelve algo con forma de Response. */
async function servidor(url, opts = {}) {
  if (!url.startsWith('/api/state')) return { status: 404, json: async () => { throw new Error('html'); } };
  const headers = Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const req = { method: opts.method || 'GET', headers, body: opts.body ? JSON.parse(opts.body) : undefined };
  let cuerpo = '';
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(d) { cuerpo = d; } };
  await handler(req, res);
  return { status: res.statusCode, json: async () => JSON.parse(cuerpo), headers: res.headers };
}

/** Una «computadora»: su propio localStorage, su propio estado y una copia del script de la app. */
function dispositivo({ fetchImpl = servidor, hooks = {} } = {}) {
  const store = new Map();
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const ctx = vm.createContext({
    localStorage, console, AbortController, location: { protocol: 'https:' },
    fetch: (...a) => fetchImpl(...a),
    setTimeout: (f, ms) => { const t = setTimeout(f, ms); t.unref?.(); return t; }, clearTimeout
  });
  vm.runInContext(code, ctx);
  const A = ctx.__EVOPS__;
  const d = { A, store, localStorage, S: A.buildSeedState(), avisos: [], conflictos: [], preguntas: 0, eleccion: 'later', pass: PASS };
  A.Sync.hooks = {
    getState: () => d.S,
    isModified: () => JSON.stringify(d.S) !== JSON.stringify(A.buildSeedState()),
    canAdopt: () => true,
    adopt: (st) => { d.S = st; },
    askPassword: async () => { d.preguntas++; return d.pass; },
    askConflict: async (remote) => { d.conflictos.push(remote); return d.eleccion; },
    status() {}, notify: (m) => d.avisos.push(m), ...hooks
  };
  /** Simula un cambio local: modifica el estado y avisa al módulo, igual que flushSave. */
  d.editar = (fn) => { fn(d.S); A.Sync.markDirty(); clearTimeout(A.Sync.timer); };
  d.subir = () => A.Sync.enqueue(() => A.Sync.push());
  d.sync = (manual) => A.Sync.now(manual);
  return d;
}
const completadas = (s) => s.tareas.reduce((n, t) => n + t.subtareas.filter((x) => x.estado === 'Completada').length, 0);
const marcar = (n) => (s) => { s.tareas[0].subtareas.slice(0, n).forEach((x) => { x.estado = 'Completada'; }); };

test('la API exige contraseña y nunca queda abierta', async () => {
  const sin = await servidor('/api/state');
  assert.equal(sin.status, 401);
  const mal = await servidor('/api/state', { headers: { Authorization: 'Bearer otra' } });
  assert.equal(mal.status, 401);
  const bien = await servidor('/api/state', { headers: { Authorization: 'Bearer ' + PASS } });
  assert.equal(bien.status, 200);
  // Sin APP_PASSWORD configurada responde 503 y no deja leer ni escribir.
  const guardada = process.env.APP_PASSWORD; delete process.env.APP_PASSWORD;
  try {
    assert.equal((await servidor('/api/state', { headers: { Authorization: 'Bearer x' } })).status, 503);
    assert.equal((await servidor('/api/state', { method: 'PUT', headers: {}, body: '{}' })).status, 503);
  } finally { process.env.APP_PASSWORD = guardada; }
});

test('la API rechaza cuerpos inválidos y métodos no permitidos', async () => {
  const h = { Authorization: 'Bearer ' + PASS };
  assert.equal((await servidor('/api/state', { method: 'PUT', headers: h, body: JSON.stringify({ baseRev: 'x', state: {} }) })).status, 400);
  assert.equal((await servidor('/api/state', { method: 'PUT', headers: h, body: JSON.stringify({ baseRev: 0, state: { hola: 1 } }) })).status, 400);
  assert.equal((await servidor('/api/state', { method: 'DELETE', headers: h })).status, 405);
  const { A } = dispositivo();
  const enorme = A.buildSeedState(); enorme.objetivos.push({ id: 'o-x', texto: 'x'.repeat(950 * 1000) });
  assert.equal((await servidor('/api/state', { method: 'PUT', headers: h, body: JSON.stringify({ baseRev: 0, state: enorme }) })).status, 413);
});

test('primera conexión: pide contraseña, sube el plan y queda al día', async () => {
  const a = dispositivo();
  await a.A.Sync.init();
  assert.equal(a.preguntas, 1);
  assert.equal(a.A.Sync.mode, 'online');
  assert.equal(a.A.Sync.net, 'idle');
  assert.equal(a.A.Sync.meta.dirty, false);
  assert.ok(a.A.Sync.meta.rev >= 1);
  assert.equal(JSON.parse(a.localStorage.getItem(a.A.SYNC_KEY)).pass, PASS, 'la contraseña queda guardada en el equipo');
});

test('contraseña incorrecta: no conecta y no guarda la contraseña', async () => {
  const a = dispositivo(); a.pass = 'mal';
  await a.A.Sync.init();
  assert.equal(a.A.Sync.mode, 'locked');
  assert.equal(a.A.Sync.meta.pass, '');
  assert.ok(a.avisos.some((m) => /incorrecta/i.test(m)));
});

test('un cambio en la computadora A aparece en la B (y viceversa)', async () => {
  const a = dispositivo(); await a.A.Sync.init();
  const b = dispositivo(); await b.A.Sync.init();
  // Tanto A como B comparten el mismo estado de la nube al arrancar.
  same(b.S, a.S);
  a.editar(marcar(3)); await a.subir();
  assert.equal(a.A.Sync.meta.dirty, false);
  await b.sync(false);
  assert.equal(completadas(b.S), 3, 'B bajó el cambio de A');
  same(b.S, a.S, 'estado idéntico');
  b.editar((s) => { s.tareas[1].subtareas[0].estado = 'En proceso'; s.tareas[1].fechaLimite = '2030-05-04'; s.objetivos.push({ id: 'o-nuevo', texto: 'Desde B' }); });
  await b.subir();
  await a.sync(false);
  assert.equal(a.S.tareas[1].subtareas[0].estado, 'En proceso');
  assert.equal(a.S.tareas[1].fechaLimite, '2030-05-04');
  assert.ok(a.S.objetivos.some((o) => o.id === 'o-nuevo'));
  same(a.S, b.S);
});

test('un navegador nuevo arranca con lo que hay en la nube, sin pisarla con el plan vacío', async () => {
  const a = dispositivo(); await a.A.Sync.init();
  const antes = completadas(a.S);
  a.editar(marcar(5)); await a.subir();
  const c = dispositivo(); // computadora nueva: localStorage vacío y plan sin tocar
  await c.A.Sync.init();
  assert.equal(completadas(c.S), antes + 5);
  same(c.S, a.S);
});

test('conflicto: ambas cambiaron → se pregunta; «la mía» pisa la nube, «la nube» descarta lo local', async () => {
  const a = dispositivo(); await a.A.Sync.init();
  const b = dispositivo(); await b.A.Sync.init();
  a.editar((s) => { s.objetivos.push({ id: 'o-a', texto: 'Cambio de A' }); }); await a.subir();
  b.editar((s) => { s.objetivos.push({ id: 'o-b', texto: 'Cambio de B' }); });
  b.eleccion = 'mine';
  await b.subir(); // 409 → conflicto → elige la suya
  assert.equal(b.conflictos.length, 1);
  assert.equal(b.A.Sync.meta.dirty, false);
  await a.sync(false);
  assert.ok(a.S.objetivos.some((o) => o.id === 'o-b') && !a.S.objetivos.some((o) => o.id === 'o-a'), 'ganó la de B');

  // Ahora al revés: A cambia, B también, B elige la nube.
  a.editar((s) => { s.objetivos.push({ id: 'o-a2', texto: 'Otro de A' }); }); await a.subir();
  b.editar((s) => { s.objetivos.push({ id: 'o-b2', texto: 'Otro de B' }); });
  b.eleccion = 'cloud';
  await b.subir();
  assert.ok(b.S.objetivos.some((o) => o.id === 'o-a2') && !b.S.objetivos.some((o) => o.id === 'o-b2'), 'B descartó lo suyo');
  same(a.S, b.S);
});

test('«decidir después» no pierde nada ni vuelve a preguntar hasta sincronizar a mano', async () => {
  const a = dispositivo(); await a.A.Sync.init();
  const b = dispositivo(); await b.A.Sync.init();
  a.editar((s) => { s.objetivos.push({ id: 'o-a', texto: 'A' }); }); await a.subir();
  b.editar((s) => { s.objetivos.push({ id: 'o-b', texto: 'B' }); });
  b.eleccion = 'later';
  await b.subir();
  assert.equal(b.conflictos.length, 1);
  assert.equal(b.A.Sync.net, 'pending');
  assert.equal(b.A.Sync.meta.dirty, true, 'sus cambios siguen pendientes');
  assert.ok(b.S.objetivos.some((o) => o.id === 'o-b'), 'lo local sigue intacto');
  await b.sync(false);
  assert.equal(b.conflictos.length, 1, 'no insiste');
  b.eleccion = 'mine';
  await b.sync(true); // a mano: vuelve a preguntar
  assert.equal(b.conflictos.length, 2);
  assert.equal(b.A.Sync.meta.dirty, false);
});

test('sin conexión: los cambios quedan pendientes y se suben al volver', async () => {
  let caido = false;
  const a = dispositivo({ fetchImpl: async (...args) => { if (caido) throw new Error('sin red'); return servidor(...args); } });
  await a.A.Sync.init();
  caido = true;
  a.editar(marcar(2));
  await a.subir();
  assert.equal(a.A.Sync.net, 'pending');
  assert.equal(a.A.Sync.meta.dirty, true);
  assert.equal(completadas(a.S), 2, 'no se pierde nada local');
  clearTimeout(a.A.Sync.timer);
  caido = false;
  await a.sync(false);
  assert.equal(a.A.Sync.meta.dirty, false);
  assert.equal(a.A.Sync.net, 'idle');
  const b = dispositivo(); await b.A.Sync.init();
  assert.equal(completadas(b.S), 2);
});

test('si cambia algo mientras se sube, queda pendiente y se vuelve a subir', async () => {
  const a = dispositivo(); await a.A.Sync.init();
  let primera = true;
  const real = a.A.Sync.api.bind(a.A.Sync);
  a.A.Sync.api = async (m, body) => { const r = await real(m, body); if (m === 'PUT' && primera) { primera = false; a.editar(marcar(7)); } return r; };
  a.editar(marcar(1));
  await a.subir();
  assert.equal(a.A.Sync.meta.dirty, true, 'el cambio hecho durante la subida no se da por subido');
  await a.subir();
  assert.equal(a.A.Sync.meta.dirty, false);
  const b = dispositivo(); await b.A.Sync.init();
  assert.equal(completadas(b.S), 7);
});

test('sin API (hosting estático): modo local, sin errores ni cambios', async () => {
  const a = dispositivo({ fetchImpl: async () => ({ status: 404, json: async () => { throw new Error('html'); } }) });
  await a.A.Sync.init();
  assert.equal(a.A.Sync.mode, 'off');
  a.editar(marcar(1)); await a.subir();
  assert.equal(completadas(a.S), 1);
  assert.equal(a.avisos.length, 0);
});

test('abierto como archivo (file://) no intenta conectarse', async () => {
  let llamadas = 0;
  const a = dispositivo({ fetchImpl: async () => { llamadas++; return servidor('/x'); } });
  const ctxLocation = { protocol: 'file:' };
  vm.runInContext('location.protocol = "file:"', vm.createContext({ location: ctxLocation })); // contexto aparte: solo documenta la intención
  const { A } = (() => {
    const ctx = vm.createContext({ localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, console, AbortController, location: ctxLocation, fetch: async () => { llamadas++; }, setTimeout, clearTimeout });
    vm.runInContext(code, ctx);
    return { A: ctx.__EVOPS__ };
  })();
  await A.Sync.init();
  assert.equal(A.Sync.mode, 'off');
  assert.equal(llamadas, 0);
  void a;
});

test('nube sin configurar (503): se avisa y la app sigue en local', async () => {
  const a = dispositivo({ fetchImpl: async () => ({ status: 503, json: async () => ({ app: 'ev-ops', ok: false, code: 'sin_base', message: 'Falta conectar la base de datos' }) }) });
  await a.A.Sync.init();
  assert.equal(a.A.Sync.mode, 'unconfigured');
  assert.match(a.A.Sync.detail, /base de datos/);
});

test('los datos de la nube dañados o de una versión futura no pisan lo local', async () => {
  const a = dispositivo(); await a.A.Sync.init();
  const antes = JSON.stringify(a.S);
  const roto = a.A.buildSeedState(); roto.tareas[0].prioridad = 'Inventada';
  a.A.Sync.api = async () => ({ status: 200, json: { app: 'ev-ops', ok: true, rev: a.A.Sync.meta.rev + 5, savedAt: null, state: roto } });
  await a.sync(false);
  assert.equal(JSON.stringify(a.S), antes);
  assert.equal(a.A.Sync.net, 'error');
  const futuro = a.A.buildSeedState(); futuro.schemaVersion = 99;
  a.A.Sync.api = async () => ({ status: 200, json: { app: 'ev-ops', ok: true, rev: a.A.Sync.meta.rev + 6, savedAt: null, state: futuro } });
  await a.sync(false);
  assert.equal(JSON.stringify(a.S), antes);
});

test('datos guardados antes de existir la nube cuentan como cambios sin subir (no se pisan con la nube)', async () => {
  const a = dispositivo(); await a.A.Sync.init();
  a.editar(marcar(4)); await a.subir();            // la nube tiene 4 completadas
  const b = dispositivo();                        // equipo con trabajo previo, sin metadatos de nube
  b.S = b.A.buildSeedState(); b.S.objetivos.push({ id: 'o-previo', texto: 'Trabajo previo' });
  b.eleccion = 'later';
  await b.A.Sync.init();
  assert.equal(b.conflictos.length, 1, 'se pregunta en vez de pisar');
  assert.ok(b.S.objetivos.some((o) => o.id === 'o-previo'));
});

test('mientras se está editando no se pisa la pantalla, salvo en la primera conexión o a pedido', async () => {
  const a = dispositivo(); await a.A.Sync.init();
  a.editar(marcar(3)); await a.subir();
  // Equipo nuevo con un campo en edición: la primera conexión SÍ baja los datos.
  const b = dispositivo({ hooks: { canAdopt: () => false } });
  await b.A.Sync.init();
  assert.equal(completadas(b.S), 3, 'primera conexión: baja igual');
  // Ya conectado y editando: la sincronización automática espera…
  a.editar(marcar(6)); await a.subir();
  await b.sync(false);
  assert.equal(completadas(b.S), 3, 'automática: no pisa mientras se edita');
  // …pero a pedido (botón) sí baja.
  await b.sync(true);
  assert.equal(completadas(b.S), 6);
});
