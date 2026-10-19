'use strict';
/**
 * Pruebas del almacén. Corren con `npm test` (node --test, sin dependencias).
 *
 * Estas pruebas existen por dos motivos: el TP5 va a pedir tests con cobertura
 * en el pipeline, y el almacén es justo la pieza donde un bug se lleva puesto
 * el calendario de repaso sin que nadie se entere hasta el parcial.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AlmacenArchivos, AlmacenPostgres } = require('../db/almacen');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-'));
}

test('devuelve el valor por defecto cuando la clave no existe', async () => {
  const a = new AlmacenArchivos(tmp());
  await a.iniciar();
  assert.deepStrictEqual(await a.leer('repaso', {}), {});
  assert.deepStrictEqual(await a.leer('eventos', []), []);
});

test('lo que se escribe se lee igual', async () => {
  const a = new AlmacenArchivos(tmp());
  await a.iniciar();
  const estado = {
    'Economia/04-Conceptos/Isocuanta.md': { ease: 2.5, intervalo: 4, vistas: 1, vence: '2026-08-18' },
  };
  await a.escribir('repaso', estado);
  assert.deepStrictEqual(await a.leer('repaso', {}), estado);
});

test('sobrescribir reemplaza, no mezcla', async () => {
  const a = new AlmacenArchivos(tmp());
  await a.iniciar();
  await a.escribir('eventos', [{ id: 'a' }, { id: 'b' }]);
  await a.escribir('eventos', [{ id: 'c' }]);
  const r = await a.leer('eventos', []);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].id, 'c');
});

test('un archivo corrupto no rompe: cae al valor por defecto', async () => {
  const dir = tmp();
  const a = new AlmacenArchivos(dir);
  await a.iniciar();
  fs.writeFileSync(path.join(dir, 'repaso.json'), '{ esto no es json');
  assert.deepStrictEqual(await a.leer('repaso', {}), {});
});

test('crea el directorio si no existe', async () => {
  const dir = path.join(tmp(), 'no', 'existe', 'todavia');
  const a = new AlmacenArchivos(dir);
  await a.escribir('eventos', [{ id: 'x' }]);
  assert.ok(fs.existsSync(path.join(dir, 'eventos.json')));
});

test('el reporte de salud identifica el modo', async () => {
  const a = new AlmacenArchivos(tmp());
  await a.iniciar();
  const s = await a.salud();
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.modo, 'archivos');
});

/**
 * Doble del Pool de pg. No abre una conexión: registra el SQL y devuelve
 * las filas que el test preparó. Es el mock obligatorio del TP5: el almacén
 * de Postgres depende de una base, y el test tiene que poder correr sin ella.
 */
function poolFalso({ filas = [], falla = null } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (falla) throw falla;
      if (/count\(\*\)/i.test(sql)) return { rows: [{ n: filas.length }] };
      if (/^\s*SELECT/i.test(sql)) {
        const hit = filas.filter((f) => f.clave === params[0]);
        return { rows: hit.map((f) => ({ valor: f.valor })) };
      }
      return { rows: [] };
    },
    async end() {},
  };
}

test('Postgres sin fila devuelve el valor por defecto, sin tocar la red', async () => {
  const pool = poolFalso();
  const a = new AlmacenPostgres('postgres://no-existe/hub', pool);
  assert.deepStrictEqual(await a.leer('repaso', {}), {});
  assert.strictEqual(pool.queries.length, 1);
  assert.match(pool.queries[0].sql, /SELECT valor FROM estado/);
  assert.deepStrictEqual(pool.queries[0].params, ['repaso']);
});

test('Postgres escribe con upsert y lee el JSON que guardó el doble', async () => {
  const pool = poolFalso();
  const a = new AlmacenPostgres('postgres://no-existe/hub', pool);
  await a.escribir('eventos', [{ id: 'tp5' }]);
  assert.match(pool.queries[0].sql, /ON CONFLICT \(clave\) DO UPDATE/);
  assert.strictEqual(pool.queries[0].params[0], 'eventos');
  assert.strictEqual(JSON.parse(pool.queries[0].params[1])[0].id, 'tp5');

  const conFila = poolFalso({ filas: [{ clave: 'eventos', valor: [{ id: 'tp5' }] }] });
  const b = new AlmacenPostgres('postgres://no-existe/hub', conFila);
  const leido = await b.leer('eventos', []);
  assert.strictEqual(leido[0].id, 'tp5');
});

test('la salud de Postgres cuenta las claves que devuelve el doble', async () => {
  const pool = poolFalso({ filas: [{ clave: 'repaso', valor: {} }, { clave: 'eventos', valor: [] }] });
  const a = new AlmacenPostgres('postgres://no-existe/hub', pool);
  const s = await a.salud();
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.detalle, '2 claves');
});

test('iniciar y cerrar le pegan al doble, no a una base', async () => {
  const pool = poolFalso();
  const a = new AlmacenPostgres('postgres://no-existe/hub', pool);
  await a.iniciar();
  assert.match(pool.queries[0].sql, /CREATE TABLE IF NOT EXISTS estado/);
  await a.cerrar();
});

test('sin DATABASE_URL el almacén es el de archivos', () => {
  const { crearAlmacen } = require('../db/almacen');
  const a = crearAlmacen(tmp());
  assert.strictEqual(a.modo, 'archivos');
});

test('si la base tira, la salud dice que no está bien y no propaga la excepción', async () => {
  const pool = poolFalso({ falla: new Error('connection refused') });
  const a = new AlmacenPostgres('postgres://no-existe/hub', pool);
  const s = await a.salud();
  assert.strictEqual(s.ok, false);
  assert.strictEqual(s.modo, 'postgres');
  assert.match(s.detalle, /connection refused/);
});

test('los acentos y las rutas con espacios sobreviven al viaje', async () => {
  const a = new AlmacenArchivos(tmp());
  await a.iniciar();
  const clave = 'Economia/04-Conceptos/Relación entre Costo Marginal y Costo Medio.md';
  await a.escribir('repaso', { [clave]: { intervalo: 7 } });
  const r = await a.leer('repaso', {});
  assert.strictEqual(r[clave].intervalo, 7);
});
