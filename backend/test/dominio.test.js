'use strict';
/**
 * Cuatro reglas, no ocho variantes de la misma:
 *   1. programar        — el intervalo del repaso no puede pasar el parcial
 *   2. classifyEvento   — de qué tipo es una fecha de la cursada
 *   3. evaluarTema      — si un tema del programa tiene nota, y con qué evidencia
 *   4. nuevasPorDia     — el ritmo para llegar al parcial con todo visto
 * Más el frontmatter y el estado, que son la convención que el resto asume.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  programar,
  classifyEvento,
  evaluarTema,
  raices,
  nuevasPorDia,
  alcanzaElRitmo,
  parseFrontmatter,
  serializeFrontmatter,
  normalizeEstado,
  toISO,
  extractLinks,
  secciones,
  resumenNota,
  parsearPrograma,
  hoyISO,
  sumarDias,
  diasEntre,
} = require('../dominio');

function nota(parcial) {
  return {
    rel: parcial.rel,
    title: parcial.title,
    stem: parcial.stem || parcial.title,
    tipo: parcial.tipo || 'concepto',
    _rTitulo: raices(`${parcial.title} ${parcial.stem || parcial.title}`),
    _rCuerpo: raices(parcial.cuerpo || ''),
  };
}

// --- 1. programar: parametrizado por la nota del estudiante -----------------

const PRIMERA_VEZ = [
  { nota: 0, intervalo: 1, ease: 2.3, fallos: 1 },
  { nota: 1, intervalo: 1, ease: 2.35, fallos: 0 },
  { nota: 2, intervalo: 2, ease: 2.5, fallos: 0 },
  { nota: 3, intervalo: 4, ease: 2.65, fallos: 0 },
];

for (const caso of PRIMERA_VEZ) {
  test(`primera revisión, nota ${caso.nota}: intervalo ${caso.intervalo} y ease ${caso.ease}`, () => {
    const r = programar(null, caso.nota, null);
    assert.strictEqual(r.intervalo, caso.intervalo);
    assert.strictEqual(r.ease, caso.ease);
    assert.strictEqual(r.fallos, caso.fallos);
    assert.strictEqual(r.vistas, 1);
    assert.strictEqual(r.recortado, false);
    assert.strictEqual(r.vence, sumarDias(hoyISO(), caso.intervalo));
  });
}

test('un intervalo que pasaría el parcial se recorta al margen que queda', () => {
  const previo = { ease: 2.5, intervalo: 10, vistas: 3, fallos: 0 };
  const r = programar(previo, 3, 2);
  assert.strictEqual(r.intervalo, 2);
  assert.strictEqual(r.recortado, true);
  assert.strictEqual(r.vence, sumarDias(hoyISO(), 2));
});

test('tope 0 no programa un repaso para hoy: el piso es un día', () => {
  const r = programar(null, 3, 0);
  assert.strictEqual(r.intervalo, 1);
  assert.strictEqual(r.recortado, true);
});

test('olvidar la tarjeta (nota 0) reinicia el intervalo aunque viniera largo', () => {
  const previo = { ease: 2.5, intervalo: 20, vistas: 4, fallos: 1 };
  const r = programar(previo, 0, null);
  assert.strictEqual(r.intervalo, 1);
  assert.strictEqual(r.fallos, 2);
  assert.strictEqual(r.ease, 2.3);
});

// --- 2. classifyEvento ------------------------------------------------------

const FECHAS = [
  ['Parcial 1', 'examen'],
  ['Examen final', 'examen'],
  ['Recuperatorio del parcial', 'recuperatorio'],
  ['Defensa P2', 'defensa'],
  ['Entrega del informe', 'entrega'],
  ['Deadline TP5', 'entrega'],
  ['Feriado nacional', 'feriado'],
  ['Inicio de clases', 'hito'],
];

for (const [texto, tipo] of FECHAS) {
  test(`"${texto}" se clasifica como ${tipo}`, () => {
    assert.strictEqual(classifyEvento(texto), tipo);
  });
}

test('un texto vacío no es un examen: cae en hito', () => {
  assert.strictEqual(classifyEvento(''), 'hito');
});

test('classifyEvento rechaza null: no hay texto que clasificar', () => {
  assert.throws(() => classifyEvento(null), TypeError);
});

test('toISO acepta el año en dos dígitos que escriben las tablas', () => {
  assert.strictEqual(toISO('3', '9', '26'), '2026-09-03');
  assert.strictEqual(toISO('21', '10', '2026'), '2026-10-21');
});

// --- 3. evaluarTema ---------------------------------------------------------

test('título exacto, ignorando tildes, cubre el tema', () => {
  const n = nota({ rel: 'a.md', title: 'Isocuanta', cuerpo: '' });
  const r = evaluarTema('Isocuanta', [n], null, new Map());
  assert.strictEqual(r.estado, 'nota');
  assert.strictEqual(r.via, 'titulo-exacto');
  assert.strictEqual(r.rel, 'a.md');
});

test('F1 del título en 0.67 alcanza el corte de 0.6', () => {
  // tema: costo marginal  (2 raíces). título: costo  (1 de 2, y es la única palabra)
  // recall 0.5, precision 1, F1 = 0.67
  const n = nota({ rel: 'costo.md', title: 'Costo', stem: 'Costo', cuerpo: '' });
  const r = evaluarTema('costo marginal', [n], null, new Map());
  assert.strictEqual(r.via, 'titulo');
  assert.strictEqual(r.estado, 'nota');
  assert.ok(r.score >= 0.6);
});

test('F1 del título en 0.5 no alcanza: no casa por el título', () => {
  // tema de 3 raíces, título con 1 de ellas y sin extras: recall 1/3, precision 1, F1 = 0.5
  const n = nota({
    rel: 'costo.md',
    title: 'Costo',
    stem: 'Costo',
    cuerpo: 'texto sin las otras palabras',
  });
  const r = evaluarTema('costo marginal medio', [n], null, new Map());
  assert.notStrictEqual(r.via, 'titulo');
  assert.strictEqual(r.estado, 'falta');
});

test('si el título no alcanza pero el cuerpo tiene el 80%, queda mencionado', () => {
  const n = nota({
    rel: 'u.md',
    title: 'Unidad 2',
    stem: 'Unidad 2',
    tipo: 'unidad',
    cuerpo: 'se desarrolla la isocuanta y la isocosto con sus pendientes',
  });
  const r = evaluarTema('isocuanta isocosto', [n], null, new Map());
  assert.strictEqual(r.estado, 'mencionado');
  assert.strictEqual(r.via, 'cuerpo');
});

test('un wikilink manual que no existe es falta, no una nota inventada', () => {
  const r = evaluarTema('Isocuanta', [], 'Isocuanta', new Map());
  assert.strictEqual(r.estado, 'falta');
  assert.strictEqual(r.via, 'manual-roto');
  assert.strictEqual(r.manual, 'Isocuanta');
});

test('un wikilink manual que existe gana, aunque el título no coincida', () => {
  const hit = { rel: 'eco/iso.md', title: 'Otra cosa' };
  const r = evaluarTema('Isocuanta', [], 'Isocuanta', new Map([['Isocuanta', [hit]]]));
  assert.strictEqual(r.estado, 'nota');
  assert.strictEqual(r.via, 'manual');
  assert.strictEqual(r.rel, 'eco/iso.md');
});

test('un tema sin palabras significativas no se puede decidir', () => {
  const r = evaluarTema('de la', [], null, new Map());
  assert.strictEqual(r.estado, 'indeterminado');
});

// --- 4. nuevasPorDia --------------------------------------------------------

const RITMOS = [
  [0, 10, 0],
  [8, 4, 2],
  [7, 3, 3],
  [1, 12, 1],
];

for (const [sinVer, dias, esperado] of RITMOS) {
  test(`${sinVer} tarjetas en ${dias} días piden ${esperado} nuevas por día`, () => {
    assert.strictEqual(nuevasPorDia(sinVer, dias), esperado);
  });
}

test('nuevasPorDia rechaza un margen de cero días', () => {
  assert.throws(() => nuevasPorDia(4, 0), (err) => err.code === 'DIAS');
});

test('nuevasPorDia rechaza una cantidad negativa', () => {
  assert.throws(() => nuevasPorDia(-1, 5), (err) => err.code === 'SIN_VER');
});

test('alcanzaElRitmo: 8 tarjetas en 4 días con tope 2 entran justo', () => {
  const r = alcanzaElRitmo(8, 4, 2);
  assert.strictEqual(r.alcanza, true);
  assert.strictEqual(r.porDia, 2);
  assert.strictEqual(r.faltan, 0);
  assert.strictEqual(r.sobra, 0);
});

test('alcanzaElRitmo: con tope 1 faltan 4 y no sobra nada', () => {
  const r = alcanzaElRitmo(8, 4, 1);
  assert.strictEqual(r.alcanza, false);
  assert.strictEqual(r.porDia, 2);
  assert.strictEqual(r.faltan, 4);
  assert.strictEqual(r.sobra, 0);
});

test('alcanzaElRitmo: cero tarjetas sobra el tope entero', () => {
  const r = alcanzaElRitmo(0, 4, 3);
  assert.strictEqual(r.alcanza, true);
  assert.strictEqual(r.porDia, 0);
  assert.strictEqual(r.sobra, 12);
});

test('alcanzaElRitmo rechaza un tope diario de cero', () => {
  assert.throws(() => alcanzaElRitmo(3, 4, 0), (err) => err.code === 'TOPE');
});

// --- convención: frontmatter y estado --------------------------------------

test('un frontmatter sin cierre no se interpreta: el cuerpo queda entero', () => {
  const r = parseFrontmatter('---\ntipo: concepto\nsin cierre');
  assert.strictEqual(r.raw, null);
  assert.strictEqual(r.body.startsWith('---'), true);
});

test('normalizeEstado mapea el alias y rechaza lo que no está en la convención', () => {
  assert.strictEqual(normalizeEstado('Entregado'), 'dominado');
  assert.strictEqual(normalizeEstado('en curso'), 'borrador');
  assert.strictEqual(normalizeEstado('publicado'), null);
  assert.strictEqual(normalizeEstado(3), null);
  assert.strictEqual(normalizeEstado(''), null);
});

test('extractLinks ignora el wikilink que está adentro de un bloque de código', () => {
  const body = 'Ver [[Isocuanta]].\n```\n[[EstoNo]]\n```\nY `[[Tampoco]]` suelto.';
  assert.deepStrictEqual(extractLinks(body), ['Isocuanta']);
});

test('parseFrontmatter lee escalares, listas y se saltea los comentarios', () => {
  const texto = [
    '---',
    'tipo: concepto',
    'parcial: 2',
    'lista: [a, "b"]',
    'publicado: false',
    'vacio: null',
    '# esto es un comentario',
    'tags:',
    '  - repaso',
    '  - "parcial"',
    '---',
    '# Título',
    '',
    'cuerpo',
  ].join('\n');
  const r = parseFrontmatter(texto);
  assert.strictEqual(r.data.tipo, 'concepto');
  assert.strictEqual(r.data.parcial, 2);
  assert.deepStrictEqual(r.data.lista, ['a', 'b']);
  assert.strictEqual(r.data.publicado, false);
  assert.strictEqual(r.data.vacio, null);
  assert.deepStrictEqual(r.data.tags, ['repaso', 'parcial']);
  assert.strictEqual(r.body.startsWith('# Título'), true);
});

test('serializeFrontmatter cita el string que tiene dos puntos y omite undefined', () => {
  const md = serializeFrontmatter({
    tipo: 'concepto',
    nota: null,
    titulo: 'Costo: medio y marginal',
    tags: ['a', 'b'],
    ignorar: undefined,
  });
  assert.match(md, /tipo: concepto/);
  assert.match(md, /nota: null/);
  assert.match(md, /titulo: "Costo: medio y marginal"/);
  assert.match(md, /tags: \[a, b\]/);
  assert.doesNotMatch(md, /ignorar/);
});

test('secciones no parte un ## que está adentro de un bloque de código', () => {
  const cuerpo = '## Conexiones\n- [[A]]\n```\n## Esto no es sección\n```\n## En el parcial\nconsigna';
  const s = secciones(cuerpo);
  assert.strictEqual(s['Conexiones'].includes('## Esto no es sección'), true);
  assert.strictEqual(s['En el parcial'], 'consigna');
});

test('resumenNota junta las citas de debajo del título', () => {
  const cuerpo = '# Isocuanta\n\n> Una curva\n> de igual producto\n\ntexto';
  assert.strictEqual(resumenNota(cuerpo), 'Una curva de igual producto');
  assert.strictEqual(resumenNota('sin título'), '');
});

test('parsearPrograma lee la tabla, hereda la unidad vacía y respeta el wikilink manual', () => {
  const md = [
    '```',
    '| Unidad | Tema |',
    '```',
    '| Unidad | Tema | Nota |',
    '| --- | --- | --- |',
    '| 1 | Isocuanta | [[Isocuanta]] |',
    '|  | Isocosto | |',
    '| 2 | Pendiente | |',
  ].join('\n');
  const temas = parsearPrograma(md);
  assert.strictEqual(temas.length, 3);
  assert.strictEqual(temas[0].unidad, '1');
  assert.strictEqual(temas[0].notaManual, 'Isocuanta');
  assert.strictEqual(temas[1].unidad, '1');
  assert.strictEqual(temas[1].notaManual, null);
  assert.strictEqual(temas[2].tema, 'Pendiente');
  assert.strictEqual(temas[2].unidad, '2');
});

test('diasEntre cuenta el margen hasta el parcial', () => {
  assert.strictEqual(diasEntre('2026-10-19', '2026-10-21'), 2);
});
