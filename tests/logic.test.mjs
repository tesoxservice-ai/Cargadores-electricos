// Pruebas de la lógica pura de index.html (estado, cálculo, persistencia, import/export).
// Se ejecutan con:  node --test tests/
// El script inline se carga en un contexto de Node sin DOM; la app detecta eso y expone __EVOPS__.
import { test } from 'node:test';
// Los objetos creados dentro del vm tienen otros prototipos: se comparan por su serialización JSON.
const same = (a, b, msg) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg);
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const code = scripts[scripts.length - 1][1];

function nuevoEntorno() {
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); }
  };
  const ctx = vm.createContext({ localStorage, console });
  vm.runInContext(code, ctx, { filename: 'index.html<script>' });
  return { A: ctx.__EVOPS__, store, localStorage };
}

const { A } = nuevoEntorno();
const seed = () => A.buildSeedState();
const tarea = (s, id) => s.tareas.find((t) => t.id === id);
const model = (s) => A.Calc.model(s);

test('el plan precargado es válido', () => {
  same(A.validateState(seed()), []);
});

test('hay 12 etapas en el orden pedido', () => {
  const s = seed();
  same(s.etapas.map((e) => e.nombre), [
    'Validación de mercado', 'Análisis de competencia', 'Validación técnica y legal', 'Modelo financiero y rentabilidad',
    'Definición de servicios y precios', 'Desarrollo de marca', 'Alianzas comerciales', 'Captación de primeros clientes',
    'Ejecución de instalaciones piloto', 'Estandarización operativa', 'Escalamiento comercial', 'Expansión hacia edificios y empresas'
  ]);
});

test('cada etapa tiene tareas y cada tarea entre 5 y 8 subtareas, todas Pendiente', () => {
  const s = seed();
  for (const e of s.etapas) {
    const ts = s.tareas.filter((t) => t.etapaId === e.id);
    assert.ok(ts.length >= 3, `etapa ${e.numero} con ${ts.length} tareas`);
    for (const t of ts) {
      assert.ok(t.subtareas.length >= 5 && t.subtareas.length <= 8, `${t.id} tiene ${t.subtareas.length} subtareas`);
      for (const x of t.subtareas) {
        assert.equal(x.estado, 'Pendiente');
        assert.ok(x.titulo.length > 12, `${x.id} muy corta`);
      }
      assert.ok(t.criterioTerminado && t.descripcion, `${t.id} sin descripción o criterio`);
      assert.equal(t.fechaLimite, '');
    }
  }
});

test('los 7 cambios pedidos están aplicados', () => {
  const s = seed();
  // 1. Acuerdo de socios: primera de la etapa 3, Crítica, Ambos; la forma societaria depende de ella.
  const e3 = s.tareas.filter((t) => t.etapaId === 'e3').sort((a, b) => a.orden - b.orden);
  assert.equal(e3[0].titulo, 'Definir el acuerdo de socios');
  assert.equal(e3[0].prioridad, 'Crítica'); assert.equal(e3[0].responsable, 'Ambos');
  assert.equal(e3[0].subtareas.length, 7);
  const societaria = s.tareas.find((t) => t.titulo.startsWith('Definir forma societaria'));
  assert.ok(societaria.dependencias.includes(e3[0].id));
  // 2. Demanda en departamentos y edificios.
  const edif = s.tareas.find((t) => t.titulo === 'Validar la demanda en departamentos y edificios');
  assert.equal(edif.etapaId, 'e1'); assert.equal(edif.prioridad, 'Crítica'); assert.equal(edif.responsable, 'Ambos');
  // 3. Prueba de demanda de bajo costo.
  const prueba = s.tareas.find((t) => t.titulo === 'Prueba de demanda de bajo costo');
  assert.equal(prueba.etapaId, 'e1'); assert.equal(prueba.prioridad, 'Importante'); assert.equal(prueba.responsable, 'Comercial');
  const gonogo = s.tareas.find((t) => t.titulo.startsWith('Definir criterios de go/no-go de mercado'));
  assert.ok(gonogo.dependencias.includes(edif.id) && gonogo.dependencias.includes(prueba.id));
  // 4. Decisión go/no-go financiera: última de la etapa 4, Crítica, Ambos, depende de punto de equilibrio.
  const e4 = s.tareas.filter((t) => t.etapaId === 'e4').sort((a, b) => a.orden - b.orden);
  const fin = e4[e4.length - 1];
  assert.equal(fin.titulo, 'Decisión go/no-go financiera');
  assert.equal(fin.prioridad, 'Crítica'); assert.equal(fin.responsable, 'Ambos');
  const equilibrio = s.tareas.find((t) => t.titulo.startsWith('Calcular punto de equilibrio'));
  same(fin.dependencias, [equilibrio.id]);
  for (const et of ['e6', 'e7', 'e8']) {
    const primera = s.tareas.filter((t) => t.etapaId === et).sort((a, b) => a.orden - b.orden)[0];
    assert.ok(primera.dependencias.includes(fin.id), `la primera tarea de ${et} depende de la decisión financiera`);
  }
  // 5. Marco legal de consorcios: Crítica y sin dependencias.
  const consorcios = s.tareas.find((t) => t.titulo === 'Investigar el marco legal de consorcios');
  assert.equal(consorcios.prioridad, 'Crítica'); same(consorcios.dependencias, []);
  // 6. Máximo 8 subtareas por tarea.
  assert.ok(s.tareas.every((t) => t.subtareas.length <= 8));
  // 7. Marca y dominio: Crítica.
  assert.equal(s.tareas.find((t) => t.titulo === 'Verificar y registrar marca y dominio').prioridad, 'Crítica');
});

test('las dependencias lógicas pedidas existen (precios → costeo)', () => {
  const s = seed();
  const costeo = s.tareas.find((t) => t.titulo === 'Costear la instalación tipo');
  const paquetes = s.tareas.find((t) => t.titulo === 'Definir los paquetes de servicio');
  const precios = s.tareas.find((t) => t.titulo === 'Definir la política de precios y márgenes');
  assert.ok(paquetes.dependencias.includes(costeo.id));
  assert.ok(precios.dependencias.includes(paquetes.id));
});

test('el plan no presenta datos como verificados (sin cifras de mercado, precios ni porcentajes inventados)', () => {
  const s = seed();
  const textos = s.tareas.flatMap((t) => [t.descripcion, t.criterioTerminado, ...t.subtareas.map((x) => x.titulo)]);
  const sospechosos = textos.filter((x) => /(\$\s?\d|USD\s?\d|U\$S|\d+\s?%\s+(de|del)\s+(los|las)|según\s+(datos|estad))/i.test(x));
  same(sospechosos, []);
});

test('progreso: subtarea → tarea → etapa (ponderada) → total', () => {
  const s = seed();
  const t11 = tarea(s, 't1-1'), t12 = tarea(s, 't1-2');
  t11.subtareas.slice(0, 4).forEach((x) => { x.estado = 'Completada'; }); // 4 de 8
  t11.subtareas[4].estado = 'En proceso';
  t12.subtareas.slice(0, 8).forEach((x) => { x.estado = 'Completada'; }); // 8 de 8
  const M = model(s);
  const st11 = M.st.get('t1-1');
  same([st11.total, st11.comp, st11.proc, st11.pend], [8, 4, 1, 3]);
  assert.equal(st11.estado, 'En proceso');
  assert.equal(M.st.get('t1-2').estado, 'Completada');
  const e1 = M.et.get('e1');
  const totalE1 = s.tareas.filter((t) => t.etapaId === 'e1').reduce((n, t) => n + t.subtareas.length, 0);
  assert.equal(e1.total, totalE1);
  assert.equal(e1.comp, 12);
  assert.equal(e1.proc, 1);
  assert.equal(M.total.comp, 12);
  assert.equal(M.total.total, s.tareas.reduce((n, t) => n + t.subtareas.length, 0));
  assert.equal(A.Calc.fmtPct(e1.comp, e1.total), String(Math.floor((12 * 100) / totalE1)));
});

test('una etapa solo se completa con TODAS sus subtareas completadas', () => {
  const s = seed();
  s.tareas.filter((t) => t.etapaId === 'e5').forEach((t) => t.subtareas.forEach((x) => { x.estado = 'Completada'; }));
  assert.equal(model(s).et.get('e5').completada, true);
  assert.equal(model(s).etapasCompletas, 1);
  tarea(s, 't5-5').subtareas[0].estado = 'En proceso';
  assert.equal(model(s).et.get('e5').completada, false);
  assert.equal(model(s).etapasCompletas, 0);
});

test('el porcentaje nunca muestra 100 si falta algo', () => {
  assert.equal(A.Calc.fmtPct(499, 500), '99');
  assert.equal(A.Calc.fmtPct(500, 500), '100');
  assert.equal(A.Calc.fmtPct(0, 500), '0');
  assert.equal(A.Calc.fmtPct(1, 500), '0,2');
});

test('próximas acciones: sin bloqueadas, por prioridad, luego etapa, luego fecha', () => {
  const s = seed();
  let M = model(s);
  let next = A.Calc.proximasAcciones(M, 5);
  assert.equal(next.length, 5);
  for (const t of next) {
    assert.equal(M.bloq.get(t.id).length, 0, `${t.id} está bloqueada`);
    assert.equal(t.prioridad, 'Crítica');
  }
  // Orden por etapa (después de prioridad).
  const ordenEtapa = next.map((t) => M.etapaById.get(t.etapaId).orden);
  same(ordenEtapa, [...ordenEtapa].sort((a, b) => a - b));
  // Con una dependencia pendiente, 3.6 (forma societaria) no aparece; 3.1 (acuerdo) sí.
  const todas = A.Calc.proximasAcciones(M, 999).map((t) => t.id);
  assert.ok(todas.includes('t3-1'));
  assert.ok(!todas.includes('t3-6'));
  assert.ok(!todas.includes('t4-7'));
  // Completar 3.1 desbloquea 3.6.
  tarea(s, 't3-1').subtareas.forEach((x) => { x.estado = 'Completada'; });
  M = model(s);
  const despues = A.Calc.proximasAcciones(M, 999).map((t) => t.id);
  assert.ok(!despues.includes('t3-1'));
  assert.ok(despues.includes('t3-6'));
  // Desempate por fecha: dos Críticas de la misma etapa → gana la de fecha más cercana.
  tarea(s, 't3-4').fechaLimite = '2030-01-10';
  tarea(s, 't3-2').fechaLimite = '2030-03-10';
  const e3 = A.Calc.proximasAcciones(model(s), 999).filter((t) => t.etapaId === 'e3' && t.prioridad === 'Crítica').map((t) => t.id);
  assert.ok(e3.indexOf('t3-4') < e3.indexOf('t3-2'));
  assert.ok(e3.indexOf('t3-2') < e3.indexOf('t3-3'), 'con fecha antes que sin fecha');
});

test('las tareas completadas no son próximas acciones', () => {
  const s = seed();
  tarea(s, 't1-1').subtareas.forEach((x) => { x.estado = 'Completada'; });
  assert.ok(!A.Calc.proximasAcciones(model(s), 999).some((t) => t.id === 't1-1'));
});

test('vencimientos: vencidas / esta semana / próximas / sin fecha', () => {
  const s = seed();
  const dia = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return A.Fecha.iso(d); };
  tarea(s, 't1-1').fechaLimite = dia(-3);
  tarea(s, 't1-2').fechaLimite = dia(0);
  tarea(s, 't1-3').fechaLimite = dia(6);
  tarea(s, 't1-4').fechaLimite = dia(7);
  tarea(s, 't1-5').fechaLimite = dia(20);
  tarea(s, 't1-2').subtareas[0].fechaLimite = dia(-1);
  tarea(s, 't1-5').subtareas[0].fechaLimite = dia(2);
  tarea(s, 't1-5').subtareas[0].estado = 'Completada';
  const V = A.Calc.vencimientos(model(s), false);
  same(V.vencidas.map((i) => (i.s || i.t).id).sort(), ['t1-1', 't1-2-s1'].sort());
  same(V.semana.map((i) => i.t.id).sort(), ['t1-2', 't1-3']);
  same(V.proximas.map((i) => i.t.id), ['t1-4', 't1-5']);
  assert.ok(V.sinFecha.every((i) => i.tipo === 'Tarea' && !i.fecha));
  assert.equal(V.completadas.length, 0);
  assert.equal(A.Calc.vencimientos(model(s), true).completadas.length, 1);
  // Una tarea completada no figura como vencida.
  tarea(s, 't1-1').subtareas.forEach((x) => { x.estado = 'Completada'; });
  assert.ok(!A.Calc.vencimientos(model(s), false).vencidas.some((i) => i.t.id === 't1-1' && !i.s));
});

test('bitácora: decisiones tomadas y conclusiones de todas las tareas', () => {
  const s = seed();
  const doc = (id, tipo, certeza, fecha) => ({ id, tipo, certeza, contenido: 'x', fuente: '', autor: 'A', fecha });
  tarea(s, 't1-1').documentacion.push(doc('d1', 'Nota', 'Decisión tomada', '2030-01-02'), doc('d2', 'Nota', 'Hipótesis', '2030-01-03'));
  tarea(s, 't2-1').documentacion.push(doc('d3', 'Conclusión', 'Investigado', '2030-02-01'), doc('d4', 'Enlace', 'Ejecutado', '2030-02-02'));
  same(A.Calc.bitacora(model(s)).map((x) => x.d.id), ['d3', 'd1']);
});

test('dependencias: no se permiten ciclos', () => {
  const s = seed();
  assert.equal(A.creariaCiclo(s, 't3-1', 't3-6'), true); // 3.6 depende de 3.1
  assert.equal(A.creariaCiclo(s, 't3-1', 't3-1'), true);
  assert.equal(A.creariaCiclo(s, 't3-6', 't3-1'), false);
  A.setState(s);
  A.Actions.addDep('t3-1', 't3-6');
  assert.ok(!tarea(s, 't3-1').dependencias.includes('t3-6'));
  const malo = seed();
  tarea(malo, 't3-1').dependencias.push('t3-6');
  assert.ok(A.validateState(malo).some((e) => /circulares/.test(e)));
});

test('borrar una tarea limpia las dependencias que la apuntaban', () => {
  const s = seed();
  A.setState(s);
  A.Actions.delTarea('t3-1');
  const s2 = A.getState();
  assert.ok(!s2.tareas.some((t) => t.id === 't3-1'));
  assert.ok(!s2.tareas.some((t) => t.dependencias.includes('t3-1')));
  same(A.validateState(s2), []);
});

test('subtareas: agregar, reordenar, borrar y deshacer', () => {
  const s = seed();
  A.setState(s);
  const antes = tarea(s, 't1-1').subtareas.map((x) => x.id);
  const nueva = A.Actions.addSub('t1-1', 'Subtarea propia');
  assert.equal(tarea(s, 't1-1').subtareas.at(-1).id, nueva.id);
  A.Actions.moveSub('t1-1', nueva.id, -1);
  assert.equal(tarea(s, 't1-1').subtareas.at(-2).id, nueva.id);
  const rec = A.Actions.delSub('t1-1', antes[0]);
  assert.ok(!tarea(s, 't1-1').subtareas.some((x) => x.id === antes[0]));
  A.Actions.restoreSub('t1-1', rec);
  assert.equal(tarea(s, 't1-1').subtareas[0].id, antes[0]);
});

test('documentación: certeza obligatoria y fuente solo si es «Investigado»', () => {
  const s = seed();
  A.setState(s);
  A.Actions.saveDoc('t1-1', { id: null, tipo: 'Nota', certeza: 'Hipótesis', fuente: 'ignorada', contenido: '  hola  ', autor: 'Ana', fecha: '2030-01-01' });
  A.Actions.saveDoc('t1-1', { id: null, tipo: 'Enlace', certeza: 'Investigado', fuente: 'https://ejemplo.org', contenido: 'dato', autor: 'Ana', fecha: '2030-01-01' });
  const [a, b] = tarea(s, 't1-1').documentacion;
  assert.equal(a.fuente, ''); assert.equal(a.contenido, 'hola'); assert.equal(b.fuente, 'https://ejemplo.org');
  same(A.validateState(s), []);
  const sinCerteza = clone(s); tarea(sinCerteza, 't1-1').documentacion[0].certeza = '';
  assert.ok(A.validateState(sinCerteza).length > 0);
});

const clone = (o) => JSON.parse(JSON.stringify(o));

test('persistencia: guardar y recargar devuelve el mismo estado', () => {
  const { A: B, store } = nuevoEntorno();
  const s = B.buildSeedState();
  s.tareas[0].subtareas[0].estado = 'Completada';
  s.tareas[0].subtareas[1].notas = 'una nota con «acentos» y ñ';
  assert.equal(B.Persist.save(s), true);
  assert.ok(store.has(B.CONST.STORAGE_KEY));
  assert.equal(B.CONST.STORAGE_KEY, 'ev-ops-v1');
  const r = B.Persist.load();
  assert.equal(r.fresh, false);
  same(r.state, s);
});

test('persistencia: primera vez carga el plan; datos corruptos se resguardan', () => {
  const { A: B, store, localStorage } = nuevoEntorno();
  assert.equal(B.Persist.load().fresh, true);
  localStorage.setItem('ev-ops-v1', '{esto no es json');
  const r = B.Persist.load();
  assert.ok(r.error);
  same(B.validateState(r.state), []);
  assert.equal(store.get('ev-ops-v1-backup'), '{esto no es json');
  // JSON válido pero con estructura inválida.
  localStorage.setItem('ev-ops-v1', JSON.stringify({ schemaVersion: 1, etapas: [], tareas: [] }));
  assert.ok(B.Persist.load().error);
});

test('persistencia: si localStorage falla, no se rompe', () => {
  const { A: B } = nuevoEntorno();
  const ctx = vm.createContext({ localStorage: { getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('lleno'); }, removeItem() {} }, console });
  vm.runInContext(code, ctx);
  const C = ctx.__EVOPS__;
  assert.equal(C.Persist.save(C.buildSeedState()), false);
  assert.equal(C.Persist.available(), false);
  same(C.validateState(C.Persist.load().state), []);
  same(C.Persist.loadPrefs(), {});
  void B;
});

test('exportar → importar restaura el estado exacto', () => {
  const s = seed();
  s.config.socios.comercial = 'Lucía'; s.config.socios.tecnico = 'Martín';
  s.objetivos.push({ id: 'o9', texto: 'Objetivo nuevo' });
  tarea(s, 't2-2').subtareas[3].estado = 'En proceso';
  tarea(s, 't2-2').subtareas[4].estado = 'Completada';
  tarea(s, 't2-2').fechaLimite = '2030-05-04';
  tarea(s, 't2-2').documentacion.push({ id: 'dx', tipo: 'Presupuesto', certeza: 'Investigado', contenido: 'línea 1\nlínea 2 https://x.org/a?b=1&c=2', fuente: 'Llamado telefónico', autor: 'Lucía', fecha: '2030-05-01' });
  const propia = A.Actions; A.setState(s);
  const nueva = propia.addTarea('e2', { titulo: 'Tarea propia', prioridad: 'Secundaria', responsable: 'Técnico' });
  propia.addDep(nueva.id, 't2-1');
  const archivo = JSON.stringify(A.Persist.buildExport(A.getState()), null, 2);
  const r = A.Persist.parseImport(JSON.parse(archivo));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  same(r.state, A.getState());
  assert.equal(JSON.stringify(r.state), JSON.stringify(A.getState()));
  assert.ok(r.exportedAt);
});

test('importar: rechaza archivos inválidos sin tocar nada', () => {
  for (const malo of [null, 5, [], {}, { app: 'ev-ops', state: { schemaVersion: 1 } }, { etapas: [], tareas: [] }]) {
    assert.equal(A.Persist.parseImport(malo).ok, false);
  }
  const futuro = clone(seed()); futuro.schemaVersion = 99;
  const r = A.Persist.parseImport({ app: 'ev-ops', state: futuro });
  assert.equal(r.ok, false); assert.match(r.errors[0], /más nueva/);
  const roto = clone(seed()); roto.tareas[0].prioridad = 'Urgentísima';
  assert.equal(A.Persist.parseImport({ app: 'ev-ops', state: roto }).ok, false);
  const huerfana = clone(seed()); huerfana.tareas[0].etapaId = 'eX';
  assert.equal(A.Persist.parseImport({ app: 'ev-ops', state: huerfana }).ok, false);
  const dep = clone(seed()); dep.tareas[0].dependencias = ['no-existe'];
  assert.equal(A.Persist.parseImport({ app: 'ev-ops', state: dep }).ok, false);
});

test('migración: sin versión o sin ruta de migración es un error claro', () => {
  assert.throws(() => A.migrate({}), /versión/);
  assert.throws(() => A.migrate({ schemaVersion: 0 }), /migración/);
  assert.doesNotThrow(() => A.migrate(seed()));
});

test('el HTML no usa recursos externos', () => {
  assert.ok(!/<script[^>]+src=/i.test(html));
  assert.ok(!/<link[^>]+rel=["']?stylesheet/i.test(html));
  assert.ok(!/\b(?:https?:)?\/\/(?:cdn|fonts|unpkg|cdnjs)/i.test(html));
});
