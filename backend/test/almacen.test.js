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

const { AlmacenArchivos } = require('../db/almacen');

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

test('los acentos y las rutas con espacios sobreviven al viaje', async () => {
  const a = new AlmacenArchivos(tmp());
  await a.iniciar();
  const clave = 'Economia/04-Conceptos/Relación entre Costo Marginal y Costo Medio.md';
  await a.escribir('repaso', { [clave]: { intervalo: 7 } });
  const r = await a.leer('repaso', {});
  assert.strictEqual(r[clave].intervalo, 7);
});
