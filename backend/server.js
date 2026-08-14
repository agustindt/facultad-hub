#!/usr/bin/env node
/**
 * Hub Facultad — servidor local del vault.
 * Cero dependencias: solo Node stdlib. Se corre con `node server.js`.
 *
 * El vault de Obsidian sigue siendo la única fuente de verdad: este servidor
 * lee y escribe los mismos archivos .md, no una copia ni una base de datos.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const url = require('url');

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

// El server vive en <hub>/backend/. La raíz del proyecto es una arriba.
const HUB_DIR = path.resolve(__dirname, '..');
// Por defecto el hub vive en <vault>/00-Sistema/_hub/ → el vault está dos arriba.
const VAULT = path.resolve(process.env.VAULT_DIR || path.join(HUB_DIR, '..', '..'));
// En docker el frontend lo sirve nginx y esto no se usa; suelto, lo sirve el server.
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(HUB_DIR, 'frontend', 'public'));
const PORT = Number(process.env.PORT || 4177);
const HUB_DATA = path.resolve(process.env.DATA_DIR || path.join(HUB_DIR, 'datos'));
const MATERIAS_FILE = path.join(HUB_DATA, 'materias.json');
const CONFIG_FILE = path.join(HUB_DATA, 'config.json');
const PAPELERA = path.join(VAULT, '00-Sistema', '_papelera');

// Subcarpetas de una materia, según 00-Sistema/Convenciones.md.
const SUBCARPETAS = [
  '00-Seguimiento',
  '01-Unidades',
  '02-TPs',
  '03-Proyecto-Catedra',
  '04-Conceptos',
  '05-Recursos',
  '06-Clases',
  '99-Material-Catedra',
];

// 5 slots de color categórico validados en claro y oscuro (pairlist adyacente).
// El slot 0 es el gris de las materias archivadas. Nunca se generan tonos nuevos:
// una sexta materia activa cae en el gris y se distingue por su etiqueta.
const SLOTS_COLOR = 5;

// Carpetas que no se indexan como notas.
const SKIP_DIRS = new Set([
  '.git',
  '.obsidian',
  '.trash',
  'node_modules',
  '_hub',
  '_papelera',
  '_to_delete',
  '99-Material-Catedra',
]);

const ESTADOS_CANON = ['pendiente', 'borrador', 'estudiado', 'dominado'];
// Sinónimos que ya existen en el vault, mapeados al valor canónico más cercano.
const ESTADO_ALIAS = {
  'sin-empezar': 'pendiente',
  'sin empezar': 'pendiente',
  'en-curso': 'borrador',
  'en curso': 'borrador',
  cursando: 'borrador',
  activo: 'borrador',
  resuelto: 'estudiado',
  entregado: 'dominado',
  cursada: 'dominado',
};

// ---------------------------------------------------------------------------
// Utilidades de archivos
// ---------------------------------------------------------------------------

/** Resuelve una ruta relativa del vault y verifica que no se escape. */
function safeVaultPath(rel) {
  if (typeof rel !== 'string' || !rel.length) throw new Error('ruta vacía');
  const clean = rel.replace(/^[/\\]+/, '');
  const abs = path.resolve(VAULT, clean);
  const base = VAULT.endsWith(path.sep) ? VAULT : VAULT + path.sep;
  if (abs !== VAULT && !abs.startsWith(base)) throw new Error('ruta fuera del vault');
  return abs;
}

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // 99-Material-Catedra de OAE está bloqueada por el SO: se ignora en silencio.
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await walk(abs, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(abs);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Frontmatter (subconjunto de YAML suficiente para el vault)
// ---------------------------------------------------------------------------

function parseScalar(raw) {
  let v = raw.trim();
  if (!v.length) return '';
  if (v.startsWith('[') && v.endsWith(']')) {
    return v
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  const quoted = v.match(/^"(.*)"$/) || v.match(/^'(.*)'$/);
  if (quoted) return quoted[1];
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { data: {}, body: text, raw: null };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: text, raw: null };
  const raw = text.slice(text.indexOf('\n') + 1, end);
  const body = text.slice(text.indexOf('\n', end + 1) + 1);
  const data = {};
  let listKey = null;
  for (const line of raw.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && listKey) {
      if (!Array.isArray(data[listKey])) data[listKey] = [];
      data[listKey].push(parseScalar(listItem[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2];
    if (!val.trim()) {
      listKey = key;
      data[key] = '';
    } else {
      listKey = null;
      data[key] = parseScalar(val);
    }
  }
  return { data, body, raw };
}

function serializeFrontmatter(data) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(', ')}]`);
    else if (v === null) lines.push(`${k}: null`);
    else if (typeof v === 'string' && (v.includes(': ') || v.includes('#') || v.includes('"')))
      lines.push(`${k}: ${JSON.stringify(v)}`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push('---');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Índice del vault
// ---------------------------------------------------------------------------

const WIKILINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

/** Quita bloques y spans de código para no contar wikilinks de ejemplo. */
function stripCode(s) {
  return s.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

function extractLinks(body) {
  const out = [];
  const clean = stripCode(body);
  let m;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(clean)) !== null) {
    const target = m[1].trim();
    if (target) out.push(target);
  }
  return out;
}

function normalizeEstado(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (ESTADOS_CANON.includes(v)) return v;
  if (ESTADO_ALIAS[v]) return ESTADO_ALIAS[v];
  return null;
}

/** Deriva la materia de la ruta cuando el frontmatter no la declara. */
function materiaFromPath(rel) {
  const top = rel.split('/')[0];
  if (!top || top.endsWith('.md') || top.startsWith('00-Sistema')) return null;
  return top;
}

/** Minúsculas y sin tildes: para que "economia" encuentre "Economía". */
function normalizar(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

let CACHE = { at: 0, notes: [], byStem: new Map() };

async function buildIndex(force = false) {
  if (!force && Date.now() - CACHE.at < 1500) return CACHE;
  const files = await walk(VAULT);
  const notes = [];
  for (const abs of files) {
    let text;
    let stat;
    try {
      text = await fsp.readFile(abs, 'utf8');
      stat = await fsp.stat(abs);
    } catch {
      continue;
    }
    const rel = path.relative(VAULT, abs).split(path.sep).join('/');
    const { data, body } = parseFrontmatter(text);
    const stem = path.basename(abs, '.md');
    const title = (body.match(/^#\s+(.+)$/m) || [null, stem])[1].trim();
    notes.push({
      rel,
      stem,
      title,
      dir: path.dirname(rel),
      fm: data,
      tipo: data.tipo || null,
      materia: data.materia || materiaFromPath(rel),
      unidad: data.unidad || null,
      parcial: data.parcial != null ? data.parcial : null,
      estadoRaw: typeof data.estado === 'string' ? data.estado.trim() : null,
      estado: normalizeEstado(data.estado),
      tags: Array.isArray(data.tags) ? data.tags : data.tags ? [String(data.tags)] : [],
      links: extractLinks(body),
      // Se guardan en el índice para el buscador; nunca se mandan al navegador.
      cuerpo: body,
      buscable: normalizar(`${title} ${stem} ${rel} ${body}`),
      titulos: (body.match(/^#{1,4}\s+(.+)$/gm) || []).map((h) => h.replace(/^#+\s+/, '')),
      words: body.split(/\s+/).filter(Boolean).length,
      bytes: stat.size,
      mtime: stat.mtimeMs,
      excerpt: body
        .replace(/^>.*$/gm, '')
        .replace(/[#*_`>|-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 220),
    });
  }
  const byStem = new Map();
  for (const n of notes) {
    if (!byStem.has(n.stem)) byStem.set(n.stem, []);
    byStem.get(n.stem).push(n);
  }
  CACHE = { at: Date.now(), notes, byStem };
  return CACHE;
}

// ---------------------------------------------------------------------------
// Buscador de texto completo
// ---------------------------------------------------------------------------

/** Recorta un fragmento alrededor de la primera aparición del término. */
function fragmento(cuerpo, termino) {
  const norm = normalizar(cuerpo);
  const i = norm.indexOf(termino);
  if (i === -1) return null;
  const desde = Math.max(0, i - 80);
  const hasta = Math.min(cuerpo.length, i + termino.length + 110);
  let txt = cuerpo.slice(desde, hasta).replace(/\s+/g, ' ').trim();
  if (desde > 0) txt = '…' + txt;
  if (hasta < cuerpo.length) txt = txt + '…';
  return { texto: txt, desde: i };
}

async function buscar(q, limite = 30) {
  const { notes } = await buildIndex();
  const terminos = normalizar(q).split(/\s+/).filter((t) => t.length >= 2);
  if (!terminos.length) return { termino: q, total: 0, resultados: [] };

  const salida = [];
  for (const n of notes) {
    // Las plantillas no son notas de estudio: tienen placeholders como {{title}}
    // y aparecer en el buscador solo confunde.
    if (n.rel.startsWith('00-Sistema/Plantillas/')) continue;
    // Todos los términos tienen que aparecer en algún lado de la nota.
    if (!terminos.every((t) => n.buscable.includes(t))) continue;

    const tituloN = normalizar(n.title + ' ' + n.stem);
    const titulosN = normalizar(n.titulos.join(' '));
    const tagsN = normalizar((n.tags || []).join(' '));
    const cuerpoN = normalizar(n.cuerpo);

    let puntaje = 0;
    for (const t of terminos) {
      if (tituloN === t) puntaje += 100;
      if (tituloN.startsWith(t)) puntaje += 40;
      if (tituloN.includes(t)) puntaje += 25;
      if (titulosN.includes(t)) puntaje += 8;
      if (tagsN.includes(t)) puntaje += 6;
      const veces = cuerpoN.split(t).length - 1;
      puntaje += Math.min(veces, 12);
    }
    // Los conceptos son la unidad de estudio: pesan un poco más que un scrape.
    if (n.tipo === 'concepto') puntaje += 6;
    if (n.tipo === 'unidad' || n.tipo === 'moc') puntaje += 4;
    if (n.rel.startsWith('00-Sistema/')) puntaje -= 8;

    const largo = [...terminos].sort((a, b) => b.length - a.length)[0];
    const frag = fragmento(n.cuerpo, largo) || fragmento(n.cuerpo, terminos[0]);

    salida.push({
      rel: n.rel,
      stem: n.stem,
      titulo: n.title,
      tipo: n.tipo,
      materia: n.materia,
      unidad: n.unidad,
      estado: n.estado,
      puntaje,
      fragmento: frag ? frag.texto : n.excerpt,
      enTitulo: terminos.some((t) => tituloN.includes(t)),
    });
  }

  salida.sort((a, b) => b.puntaje - a.puntaje || a.titulo.localeCompare(b.titulo));
  return { termino: q, total: salida.length, resultados: salida.slice(0, limite) };
}

// ---------------------------------------------------------------------------
// Materias
// ---------------------------------------------------------------------------

// `slot` = índice de color categórico (0 = gris, para materias archivadas).
// `orden` sólo ordena la vista: las materias que ya cursaste van al final.
const MATERIA_META = {
  OAE: { nombre: 'Organización y Administración de Empresas', slot: 1, corto: 'OAE', orden: 1 },
  CompuGrafica: { nombre: 'Computación Gráfica', slot: 2, corto: 'Comp. Gráfica', orden: 2 },
  Economia: { nombre: 'Economía', slot: 3, corto: 'Economía', orden: 3 },
  'Ing-Software-III': {
    nombre: 'Ingeniería de Software III',
    slot: 4,
    corto: 'Ing. SW III',
    orden: 4,
    sufijo: 'isw3',
  },
  'Ing-Software-II': {
    nombre: 'Ingeniería de Software II',
    slot: 0,
    corto: 'Ing. Software II',
    orden: 90,
    archivada: true,
  },
};

async function readMateriasCfg() {
  try {
    return JSON.parse(await fsp.readFile(MATERIAS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function writeMateriasCfg(cfg) {
  await fsp.mkdir(HUB_DATA, { recursive: true });
  await fsp.writeFile(MATERIAS_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

/** Carpetas de primer nivel que son materias (todo menos el sistema). */
async function carpetasMateria() {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(VAULT, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') || e.name === '00-Sistema') continue;
    out.push(e.name);
  }
  return out;
}

async function materias() {
  const { notes } = await buildIndex();
  const cfg = await readMateriasCfg();
  const map = new Map();

  // Toda carpeta de primer nivel cuenta como materia, aunque todavía esté vacía:
  // así una materia recién creada aparece antes de tener su primera nota.
  const base = (id) => {
    const meta = { ...(MATERIA_META[id] || {}), ...(cfg[id] || {}) };
    return {
      id,
      nombre: meta.nombre || id,
      corto: meta.corto || id,
      slot: meta.slot != null ? meta.slot : 0,
      orden: meta.orden != null ? meta.orden : 50,
      archivada: !!meta.archivada,
      sufijo: meta.sufijo || null,
      creadaEnHub: !!meta.creadaEnHub,
      total: 0,
      conteo: { pendiente: 0, borrador: 0, estudiado: 0, dominado: 0, sinEstado: 0 },
      tipos: {},
      unidades: new Set(),
    };
  };

  for (const dir of await carpetasMateria()) map.set(dir, base(dir));

  for (const n of notes) {
    if (!n.materia || n.rel.startsWith('00-Sistema/')) continue;
    if (!map.has(n.materia)) map.set(n.materia, base(n.materia));
    const m = map.get(n.materia);
    m.total += 1;
    if (n.estado) m.conteo[n.estado] += 1;
    else m.conteo.sinEstado += 1;
    m.tipos[n.tipo || 'sin-tipo'] = (m.tipos[n.tipo || 'sin-tipo'] || 0) + 1;
    if (n.unidad) m.unidades.add(String(n.unidad));
  }

  return [...map.values()]
    .map((m) => ({ ...m, unidades: [...m.unidades].sort() }))
    .sort((a, b) => a.orden - b.orden || a.id.localeCompare(b.id));
}

/** Primer slot de color libre. Si ya hay 5 materias con color, devuelve 0 (gris). */
async function slotLibre(excluir) {
  const usados = new Set(
    (await materias())
      .filter((m) => !m.archivada && m.id !== excluir)
      .map((m) => m.slot)
  );
  for (let i = 1; i <= SLOTS_COLOR; i++) if (!usados.has(i)) return i;
  return 0;
}

/** Qué se pierde si se borra una materia: notas propias y enlaces que le entran. */
async function impactoMateria(id) {
  const { notes } = await buildIndex(true);
  const propias = notes.filter((n) => n.rel === id + '.md' || n.rel.startsWith(id + '/'));
  const stemsPropios = new Set(propias.map((n) => n.stem));
  const entrantes = [];
  for (const n of notes) {
    if (n.rel === id + '.md' || n.rel.startsWith(id + '/')) continue;
    for (const l of n.links) {
      if (stemsPropios.has(l)) entrantes.push({ desde: n.rel, hacia: l });
    }
  }
  return {
    id,
    notas: propias.length,
    rutas: propias.map((n) => n.rel),
    enlacesEntrantes: entrantes,
  };
}

/** Crea la carpeta de una materia con la estructura de Convenciones.md. */
async function crearMateria({ id, nombre, corto, sufijo, conProyecto }) {
  const dir = safeVaultPath(id);
  if (fs.existsSync(dir)) throw new Error(`Ya existe una carpeta "${id}" en el vault`);

  const { byStem } = await buildIndex(true);
  const cronograma = `cronograma-${sufijo}`;
  const condiciones = `condiciones-${sufijo}`;
  for (const stem of [id, cronograma, condiciones]) {
    if (byStem.has(stem)) {
      throw new Error(
        `El nombre "${stem}" ya existe en el vault. Los stems tienen que ser únicos entre materias.`
      );
    }
  }

  const subs = SUBCARPETAS.filter((s) => conProyecto || s !== '03-Proyecto-Catedra');
  for (const s of subs) {
    await fsp.mkdir(path.join(dir, s), { recursive: true });
    // git no versiona carpetas vacías: sin esto, un "deshacer" del asistente se
    // llevaría puesta la estructura de la materia.
    await fsp.writeFile(path.join(dir, s, '.gitkeep'), '', 'utf8');
  }

  const hoy = new Date().toISOString().slice(0, 10);
  const escribir = (rel, txt) => fsp.writeFile(path.join(dir, rel), txt, 'utf8');

  await escribir(
    `${id}.md`,
    `---
tipo: moc
materia: ${id}
tags: [${id}, moc]
---

# ${nombre}

> MOC de la materia. Solo enlaza: la teoría vive en las notas.

**Seguimiento:** [[${cronograma}]] · [[${condiciones}]]

## Unidades

<!-- Se agregan a medida que se cursan, no todas juntas. -->

## Trabajos prácticos

## Conceptos

## Clases
`
  );

  await escribir(
    'CLAUDE.md',
    `# ${nombre} — contexto para Claude Code

<!-- Este archivo NO es una nota de Obsidian: es el contexto que carga /${sufijo}. -->

## Estado de cursada

Materia dada de alta el ${hoy} desde el Hub. Todo por completar.

## Método

Aprendizaje asistido y progresivo, unidad por unidad, en el orden real de cursada:
diagnóstico → explicación guiada → resumen incremental → atomizar conceptos →
autoevaluación → repaso espaciado. Nunca volcar un resumen completo de una sola vez.

## Reglas

- Se respeta \`00-Sistema/Convenciones.md\`.
- Archivos de seguimiento sufijados con \`-${sufijo}\` para no chocar stems con otras materias.
- Diagramas en Mermaid, nunca ASCII.
- No inventar fechas, docentes ni consignas que no estén publicadas.
- \`99-Material-Catedra/\` es fuente de verdad y no se edita.

## Qué falta

- [ ] Docentes y contacto
- [ ] Programa y unidades
- [ ] Régimen de cursada y condiciones
- [ ] Cronograma con fechas
- [ ] Trabajos prácticos
`
  );

  await escribir(
    `00-Seguimiento/${cronograma}.md`,
    `---
tipo: seguimiento
materia: ${id}
estado: pendiente
tags: [${id}, seguimiento, cronograma]
---

**Materia:** [[${id}]] · Ver también [[${condiciones}]]

# Cronograma ${nombre}

> Sin datos todavía. Las filas con fecha \`DD/MM\` o \`DD/MM/AAAA\` en la primera o
> segunda columna las levanta el calendario del Hub automáticamente.

| Sem | Fecha | Teórico | Práctico / Hitos |
|---|---|---|---|

## Fechas clave

| Fecha | Evento | Tipo |
|---|---|---|
`
  );

  await escribir(
    `00-Seguimiento/${condiciones}.md`,
    `---
tipo: seguimiento
materia: ${id}
estado: pendiente
tags: [${id}, seguimiento, condiciones]
---

**Materia:** [[${id}]] · Ver también [[${cronograma}]]

# Condiciones de cursada — ${nombre}

> Sin datos todavía. No completar con estimaciones: lo que no esté publicado va como faltante.

## Regular

## Promoción

## Recuperatorios

## Trabajos prácticos

## Escala de notas

## ⚠️ Faltantes
`
  );

  const cfg = await readMateriasCfg();
  cfg[id] = {
    nombre,
    corto,
    sufijo,
    slot: await slotLibre(id),
    orden: 10,
    archivada: false,
    creadaEnHub: true,
  };
  await writeMateriasCfg(cfg);
  await buildIndex(true);
  return { id, creada: subs.length, archivos: 4 };
}

/** No borra: mueve la carpeta a 00-Sistema/_papelera/ para que sea recuperable. */
async function borrarMateria(id) {
  const dir = safeVaultPath(id);
  if (!fs.existsSync(dir)) throw new Error('Esa carpeta no existe');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  await fsp.mkdir(PAPELERA, { recursive: true });
  const destino = path.join(PAPELERA, `${id}-${stamp}`);
  await fsp.rename(dir, destino);
  const cfg = await readMateriasCfg();
  delete cfg[id];
  await writeMateriasCfg(cfg);
  await buildIndex(true);
  return { movidaA: path.relative(VAULT, destino).split(path.sep).join('/') };
}

// ---------------------------------------------------------------------------
// Eventos: los de las tablas "Fechas clave" + los que agrega el usuario
// ---------------------------------------------------------------------------

function toISO(d, m, y) {
  const yy = y.length === 2 ? `20${y}` : y;
  return `${yy}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function classifyEvento(texto) {
  const t = texto.toLowerCase();
  if (/recuperatorio/.test(t)) return 'recuperatorio';
  if (/parcial|examen|final/.test(t)) return 'examen';
  if (/defensa/.test(t)) return 'defensa';
  if (/entrega|deadline|informe/.test(t)) return 'entrega';
  if (/feriado/.test(t)) return 'feriado';
  return 'hito';
}

/** Lee las tablas markdown de los archivos de 00-Seguimiento y saca fechas. */
async function derivedEvents() {
  const { notes } = await buildIndex();
  const out = [];
  const seguimiento = notes.filter(
    (n) => n.dir.endsWith('00-Seguimiento') || n.tipo === 'seguimiento'
  );
  for (const n of seguimiento) {
    let text;
    try {
      text = await fsp.readFile(path.join(VAULT, n.rel), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim().startsWith('|')) continue;
      const cells = line.split('|').map((c) => c.trim()).filter((c, i, a) => i > 0 && i < a.length - 1);
      if (cells.length < 2) continue;
      // La fecha puede estar en la primera columna ("Fechas clave") o en la
      // segunda ("Sem | Fecha | Teórico | Práctico"): se busca en todas.
      let dm = null;
      let dmIdx = -1;
      for (let i = 0; i < cells.length; i++) {
        const hit = cells[i].match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
        if (hit) {
          dm = hit;
          dmIdx = i;
          break;
        }
      }
      if (!dm) continue;
      const year = dm[3] || String(new Date().getFullYear());
      const fecha = toISO(dm[1], dm[2], year);
      // La columna con más texto suele ser la descripción del evento.
      const desc =
        cells.filter((_, i) => i !== dmIdx && !/^\d+$/.test(cells[i])).sort((a, b) => b.length - a.length)[0] || '';
      let limpio = desc
        .replace(/\*+/g, '')
        .replace(/\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g, (m, a, b) => (b || a))
        .replace(/^\((.*)\)$/, '$1')
        .trim();
      if (limpio) limpio = limpio[0].toUpperCase() + limpio.slice(1);
      if (!limpio || limpio === '—' || limpio === '-') continue;
      out.push({
        id: `auto:${n.rel}:${fecha}:${limpio.slice(0, 24)}`,
        fecha,
        titulo: limpio,
        materia: n.materia,
        tipo: classifyEvento(limpio),
        origen: n.rel,
        editable: false,
      });
    }
  }
  // El mismo hito suele estar escrito en dos o tres tablas distintas (cronograma
  // semanal, "Fechas clave", tracker del proyecto). Se colapsan por solapamiento
  // de palabras dentro del mismo día y materia, conservando la versión más rica.
  const tokens = (s) =>
    new Set(
      s
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 2 || /^\d+$/.test(t))
    );

  const grupos = new Map();
  for (const e of out) {
    const k = `${e.fecha}|${e.materia || ''}`;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(e);
  }

  const final = [];
  for (const lista of grupos.values()) {
    lista.sort((a, b) => b.titulo.length - a.titulo.length);
    const kept = [];
    for (const cand of lista) {
      const ct = tokens(cand.titulo);
      if (!ct.size) continue;
      const dup = kept.some((k) => {
        const kt = tokens(k.titulo);
        let shared = 0;
        for (const t of ct) if (kt.has(t)) shared += 1;
        return shared / ct.size >= 0.6;
      });
      if (!dup) kept.push(cand);
    }
    final.push(...kept);
  }
  return final.sort((a, b) => a.fecha.localeCompare(b.fecha));
}

const readUserEvents = () => almacen.leer('eventos', []);
const writeUserEvents = (list) => almacen.escribir('eventos', list);

async function allEvents() {
  const [auto, user] = await Promise.all([derivedEvents(), readUserEvents()]);
  return [...auto, ...user].sort((a, b) => a.fecha.localeCompare(b.fecha));
}

function icsEscape(s) {
  return String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
}

function buildICS(events) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Hub Facultad//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Facultad',
  ];
  for (const e of events) {
    if (e.tipo === 'feriado') continue;
    const d = e.fecha.replace(/-/g, '');
    const next = new Date(e.fecha + 'T00:00:00Z');
    next.setUTCDate(next.getUTCDate() + 1);
    const dEnd = next.toISOString().slice(0, 10).replace(/-/g, '');
    const uid = Buffer.from(e.id).toString('base64').replace(/=/g, '') + '@hub-facultad';
    lines.push(
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${d}`,
      `DTEND;VALUE=DATE:${dEnd}`,
      `SUMMARY:${icsEscape((e.materia ? `[${e.materia}] ` : '') + e.titulo)}`,
      `CATEGORIES:${icsEscape(e.tipo)}`,
      'BEGIN:VALARM',
      'TRIGGER:-P3D',
      'ACTION:DISPLAY',
      `DESCRIPTION:${icsEscape('Faltan 3 días: ' + e.titulo)}`,
      'END:VALARM',
      'BEGIN:VALARM',
      'TRIGGER:-P1D',
      'ACTION:DISPLAY',
      `DESCRIPTION:${icsEscape('Mañana: ' + e.titulo)}`,
      'END:VALARM',
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

// ---------------------------------------------------------------------------
// Ordenar apuntes con Claude
//
// La clave de API se guarda SOLO en datos/config.json, en esta máquina, y nunca
// se devuelve entera al navegador. La única salida a internet de todo el hub es
// la llamada a api.anthropic.com que dispara este bloque, y la dispara siempre
// un clic explícito.
// ---------------------------------------------------------------------------

const https = require('https');

async function readConfig() {
  try {
    return JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function writeConfig(cfg) {
  await fsp.mkdir(HUB_DATA, { recursive: true });
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function anthropic(apiKey, ruta, metodo, cuerpo) {
  return new Promise((resolve, reject) => {
    const payload = cuerpo ? JSON.stringify(cuerpo) : null;
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: ruta,
        method: metodo,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
        },
        timeout: 120000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(data);
          } catch {
            return reject(new Error(`Respuesta no válida de la API (HTTP ${res.statusCode})`));
          }
          if (res.statusCode >= 400) {
            const msg = json?.error?.message || `HTTP ${res.statusCode}`;
            return reject(new Error(msg));
          }
          resolve(json);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('La API tardó demasiado en responder')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Contexto que se le manda al modelo: las reglas del vault y qué notas existen. */
async function contextoVault(rel) {
  const { notes } = await buildIndex();
  let convenciones = '';
  try {
    convenciones = await fsp.readFile(path.join(VAULT, '00-Sistema', 'Convenciones.md'), 'utf8');
  } catch {}
  const nota = notes.find((n) => n.rel === rel);
  const materia = nota?.materia || null;

  // Los stems se mandan agrupados: primero los de la materia (los candidatos
  // naturales a enlazar), después el resto del vault.
  const propios = notes.filter((n) => n.materia === materia && n.tipo === 'concepto').map((n) => n.stem);
  const otros = notes
    .filter((n) => n.materia !== materia && (n.tipo === 'concepto' || n.tipo === 'unidad'))
    .map((n) => n.stem);
  const unidades = notes.filter((n) => n.materia === materia && n.tipo === 'unidad').map((n) => n.stem);

  return { convenciones, nota, materia, propios, otros, unidades };
}

const SISTEMA_ORDENAR = `Sos un asistente que ordena apuntes de facultad dentro de un vault de Obsidian muy convencionado.

El estudiante escribe rápido en clase, sin poner títulos ni tablas ni formato. Tu trabajo es convertir ese texto crudo en una nota que respete las convenciones del vault, SIN inventar contenido.

REGLAS INNEGOCIABLES:
1. NO inventes información. Si algo no está en el texto crudo, no aparece en la nota. No completes fechas, definiciones ni datos "probables". Si algo quedó ambiguo, dejalo como está y mencionalo en "cambios".
2. Wikilinks SOLO a notas que existen. Te doy la lista exacta de stems disponibles. Un wikilink a algo que no está en esa lista rompe el grafo: está prohibido. El texto del enlace debe coincidir EXACTO con el stem.
3. NUNCA uses alias con pipe dentro de tablas markdown.
4. Diagramas en Mermaid, jamás en ASCII art. Dentro de un nodo de Mermaid no funciona **negrita**: usá <b> y <br/>. En mindmap, texto plano y MAYÚSCULAS para destacar.
5. Fórmulas en LaTeX: $...$ inline, $$...$$ en bloque. Nunca fórmulas en prosa suelta.
6. Respetá el frontmatter existente. Podés completar campos vacíos, no cambiar los que ya tienen valor.
7. Mantené la voz del estudiante. Ordenás y completás estructura; no reescribís todo en un registro ajeno ni inflás con relleno.

QUÉ PRODUCIR:
- Un título H1 si no lo hay.
- Una cita de una frase (> ...) que resuma el concepto, derivada del texto.
- Secciones con ## donde el contenido lo pida.
- Tablas donde haya enumeraciones comparables (dos o más elementos con los mismos atributos).
- Un bloque "## Conexiones" con 3 a 6 wikilinks a notas EXISTENTES, cada uno con una frase que explique POR QUÉ se conectan. Si no hay 3 conexiones honestas, poné las que haya.
- Un bloque "## En el parcial" con qué se evalúa de este tema, si el texto da pistas.

RESPUESTA: solo un objeto JSON válido, sin markdown alrededor, con estas claves:
{
  "nota": "el markdown completo de la nota, frontmatter incluido",
  "conceptos_nuevos": ["Nombre de concepto que aparece en el texto y merece nota propia pero todavía no existe"],
  "cambios": ["frase corta describiendo cada cambio importante que hiciste"]
}`;

async function ordenarNota({ rel, contenido, motor: motorPedido }) {
  const cfg = await readConfig();
  const elegido = await motorDisponible(motorPedido);
  const modelo = cfg.modelo || 'claude-haiku-4-5';

  const ctx = await contextoVault(rel);

  const usuario = `## Reglas del vault (00-Sistema/Convenciones.md)

${ctx.convenciones || '(no se encontró el archivo de convenciones)'}

## Notas que EXISTEN y a las que podés enlazar

Unidades de esta materia: ${ctx.unidades.join(' · ') || '(ninguna)'}
Conceptos de esta materia (${ctx.materia || 'sin materia'}): ${ctx.propios.join(' · ') || '(ninguno)'}
Conceptos de otras materias: ${ctx.otros.join(' · ') || '(ninguno)'}
La nota de la materia se llama: ${ctx.materia || '(desconocida)'}

Cualquier wikilink a algo que no esté en esas listas está prohibido.

## Archivo que estás ordenando

Ruta: ${rel}

## Texto crudo del estudiante

${contenido}`;

  const t0 = Date.now();
  let parsed;
  let usoMotor = {};

  if (elegido.motor === 'cli') {
    // Por el CLI: consume la suscripción, no se cobra por token.
    const r = await claudeJSON({
      instruccion: 'Ordená la nota según las reglas. El material va por la entrada estándar.',
      cuerpo: usuario,
      sistema: SISTEMA_ORDENAR,
      schema: SCHEMA_ORDENAR,
      tools: 'Read,Grep,Glob',
    });
    parsed = r.datos;
    usoMotor = r.uso;
  } else {
    const resp = await anthropic(cfg.apiKey, '/v1/messages', 'POST', {
      model: modelo,
      max_tokens: 8000,
      system: SISTEMA_ORDENAR,
      messages: [{ role: 'user', content: usuario }],
    });
    const texto = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    try {
      parsed = JSON.parse(texto);
    } catch {
      const m = texto.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('El modelo no devolvió JSON reconocible');
      parsed = JSON.parse(m[0]);
    }
    usoMotor = {
      modelo,
      tokens_entrada: resp.usage?.input_tokens ?? null,
      tokens_salida: resp.usage?.output_tokens ?? null,
      costo_usd: null,
    };
  }
  if (!parsed.nota) throw new Error('La respuesta no trae la nota ordenada');

  // Red de seguridad: si el modelo enlazó a algo que no existe, se avisa.
  const { byStem } = await buildIndex();
  const rotos = [];
  const re = /\[\[([^\]|#]+)/g;
  let m2;
  while ((m2 = re.exec(parsed.nota)) !== null) {
    const t = m2[1].trim();
    if (!byStem.has(t) && !rotos.includes(t)) rotos.push(t);
  }

  const uso = {
    fecha: new Date().toISOString(),
    rel,
    motor: elegido.motor,
    ...usoMotor,
    ms: Date.now() - t0,
  };
  await registrarUso(uso);

  return {
    motor: elegido.motor,
    aviso: elegido.aviso || null,
    nota: parsed.nota,
    conceptos_nuevos: Array.isArray(parsed.conceptos_nuevos) ? parsed.conceptos_nuevos : [],
    cambios: Array.isArray(parsed.cambios) ? parsed.cambios : [],
    enlaces_rotos: rotos,
    uso,
  };
}

// ---------------------------------------------------------------------------
// Utilidades compartidas: fechas, secciones y tokens
// ---------------------------------------------------------------------------

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function hoyISO() {
  return ymd(new Date());
}
function sumarDias(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return ymd(dt);
}
function diasEntre(a, b) {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  return Math.round((new Date(yb, mb - 1, db) - new Date(ya, ma - 1, da)) / 86400000);
}

/**
 * Parte el cuerpo de una nota en secciones de nivel ##.
 * Ignora los ## que caen dentro de un bloque de código.
 */
function secciones(cuerpo) {
  const out = {};
  let actual = null;
  let buf = [];
  let fence = false;
  for (const ln of String(cuerpo || '').split('\n')) {
    if (/^\s*```/.test(ln)) fence = !fence;
    const m = fence ? null : ln.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (actual) out[actual] = buf.join('\n').trim();
      actual = m[1].replace(/[*_`]/g, '').trim();
      buf = [];
      continue;
    }
    if (actual) buf.push(ln);
  }
  if (actual) out[actual] = buf.join('\n').trim();
  return out;
}

/** La cita de una frase que va debajo del H1, según la convención. */
function resumenNota(cuerpo) {
  const m = String(cuerpo || '').match(/^#\s+.+\n+((?:^>.*\n?)+)/m);
  if (!m) return '';
  return m[1]
    .split('\n')
    .map((l) => l.replace(/^>\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set([
  'de','del','la','el','los','las','y','o','en','a','al','un','una','unos','unas','para','por','con',
  'su','sus','se','que','como','sobre','entre','sin','ni','lo','es','son','ser','the','of','and','to',
  'segun','ante','tras','mas','pero','cada','este','esta','estos','estas','ese','esa','esos','esas',
]);

/** Palabras significativas de un texto, normalizadas y sin tildes. */
function tokens(s) {
  return normalizar(s)
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * Singularizador mínimo de español. No es un stemmer serio: sólo hace que
 * "isocuantas" y "isocuanta", o "funciones" y "función", cuenten como la misma
 * palabra — que es donde el matching fallaba de verdad.
 */
function raiz(w) {
  if (w.length <= 4) return w;
  if (/ciones$/.test(w)) return w.replace(/ciones$/, 'cion');
  if (/[aeiou]s$/.test(w)) return w.slice(0, -1);
  if (/(es)$/.test(w) && w.length > 5) return w.slice(0, -2);
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}
function raices(s) {
  return new Set(tokens(s).map(raiz));
}

// ---------------------------------------------------------------------------
// Repaso espaciado
//
// Las tarjetas NO se guardan: se derivan de los bloques "## En el parcial" que
// ya están escritos en las notas. Lo único que persiste es el calendario de
// repaso, en datos/repaso.json, para no tocar el markdown.
// ---------------------------------------------------------------------------

const EASE_INI = 2.5;
const EASE_MIN = 1.3;
const EASE_MAX = 2.8;
const NUEVAS_TOPE = 12;
const NUEVAS_PISO = 3;

const readRepaso = () => almacen.leer('repaso', {});
const writeRepaso = (st) => almacen.escribir('repaso', st);

/** Deriva las tarjetas del vault. Una por nota con "## En el parcial" con contenido. */
async function tarjetas() {
  const { notes } = await buildIndex();
  const out = [];
  for (const n of notes) {
    if (n.rel.startsWith('00-Sistema/')) continue;
    const sec = secciones(n.cuerpo);
    // El pie de página ("---" + Fuente:) no es parte de la consigna.
    const consigna = String(sec['En el parcial'] || '')
      .split(/\n\s*---\s*\n/)[0]
      .replace(/^\s*Fuente:.*$/gim, '')
      .trim();
    if (!consigna || consigna.replace(/\s+/g, ' ').length < 20) continue;
    const conexiones = (sec['Conexiones'] || '')
      .split('\n')
      .filter((l) => /^\s*[-*]\s/.test(l))
      .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 8);
    out.push({
      rel: n.rel,
      stem: n.stem,
      titulo: n.title,
      materia: n.materia,
      unidad: n.unidad,
      tipo: n.tipo,
      parcialNro: n.parcial,
      consigna: consigna.slice(0, 900),
      resumen: resumenNota(n.cuerpo),
      conexiones,
      palabras: n.words,
      mtime: n.mtime,
    });
  }
  return out;
}

/**
 * SM-2 recortado. `tope` es el margen en días hasta el parcial: un intervalo
 * nunca puede saltar por encima de la fecha del examen, porque un repaso
 * programado para después del parcial no sirve para nada.
 */
function programar(prev, nota, tope) {
  const s = prev || { ease: EASE_INI, intervalo: 0, vistas: 0, fallos: 0 };
  let ease = s.ease != null ? s.ease : EASE_INI;
  let iv = s.intervalo || 0;
  if (nota === 0) {
    ease -= 0.2;
    iv = 1;
  } else if (nota === 1) {
    ease -= 0.15;
    iv = iv ? Math.max(1, Math.round(iv * 1.2)) : 1;
  } else if (nota === 2) {
    iv = iv ? Math.round(iv * ease) : 2;
  } else {
    ease += 0.15;
    iv = iv ? Math.round(iv * ease * 1.3) : 4;
  }
  ease = Math.max(EASE_MIN, Math.min(EASE_MAX, ease));
  iv = Math.max(1, iv);
  let recortado = false;
  if (tope != null && iv > Math.max(1, tope)) {
    iv = Math.max(1, tope);
    recortado = true;
  }
  const hoy = hoyISO();
  return {
    ease: Number(ease.toFixed(2)),
    intervalo: iv,
    vistas: (s.vistas || 0) + 1,
    fallos: (s.fallos || 0) + (nota === 0 ? 1 : 0),
    ultima: hoy,
    ultimaNota: nota,
    vence: sumarDias(hoy, iv),
    recortado,
  };
}

/** Próximo examen por materia, sacado del calendario que el hub ya deriva. */
async function proximosExamenes() {
  const evs = await allEvents();
  const hoy = hoyISO();
  const out = {};
  for (const e of evs) {
    if (!e.materia) continue;
    if (!/examen|recuperatorio|defensa/.test(String(e.tipo))) continue;
    if (e.fecha < hoy) continue;
    if (!out[e.materia] || e.fecha < out[e.materia].fecha) out[e.materia] = e;
  }
  return out;
}

async function repasoEstado() {
  const cards = await tarjetas();
  const st = await readRepaso();
  const examen = await proximosExamenes();
  const hoy = hoyISO();

  const porMateria = new Map();
  for (const c of cards) {
    if (!porMateria.has(c.materia)) porMateria.set(c.materia, []);
    porMateria.get(c.materia).push(c);
  }

  const plan = [];
  const vencidas = [];
  const nuevas = [];

  for (const [materia, lista] of porMateria) {
    const ex = examen[materia] || null;
    const dias = ex ? diasEntre(hoy, ex.fecha) : null;
    const sinVer = lista.filter((c) => !st[c.rel]);
    const vistas = lista.length - sinVer.length;

    // Cuántas tarjetas nuevas por día hacen falta para llegar al parcial con
    // todo visto al menos una vez. Sin fecha de examen, un ritmo sostenible.
    let porDia;
    if (dias == null) porDia = 5;
    else if (dias <= 0) porDia = sinVer.length;
    else porDia = Math.ceil(sinVer.length / dias);
    porDia = Math.max(NUEVAS_PISO, Math.min(NUEVAS_TOPE, porDia));
    if (!sinVer.length) porDia = 0;

    plan.push({
      materia,
      examen: ex ? { fecha: ex.fecha, titulo: ex.titulo, tipo: ex.tipo } : null,
      dias,
      total: lista.length,
      vistas,
      sinVer: sinVer.length,
      porDia,
      alcanza: dias == null ? null : sinVer.length <= dias * NUEVAS_TOPE,
    });

    for (const c of lista) {
      const s = st[c.rel];
      if (!s) {
        nuevas.push({ ...c, estado: null, prioridad: dias == null ? 9999 : dias });
      } else if (s.vence <= hoy) {
        vencidas.push({ ...c, estado: s, atraso: diasEntre(s.vence, hoy), prioridad: dias == null ? 9999 : dias });
      }
    }
  }

  // Primero lo vencido (lo más atrasado adelante), después lo nuevo, dando
  // prioridad a la materia cuyo parcial está más cerca.
  vencidas.sort((a, b) => b.atraso - a.atraso || a.prioridad - b.prioridad);
  const cupo = {};
  for (const p of plan) cupo[p.materia] = p.porDia;
  const yaHoy = {};
  for (const [rel, s] of Object.entries(st)) {
    if (s.ultima === hoy && s.vistas === 1) {
      const c = cards.find((x) => x.rel === rel);
      if (c) yaHoy[c.materia] = (yaHoy[c.materia] || 0) + 1;
    }
  }
  nuevas.sort((a, b) => a.prioridad - b.prioridad || String(a.unidad).localeCompare(String(b.unidad)) || a.titulo.localeCompare(b.titulo));
  const nuevasHoy = [];
  const usado = { ...yaHoy };
  for (const c of nuevas) {
    const lim = cupo[c.materia] || 0;
    if ((usado[c.materia] || 0) >= lim) continue;
    usado[c.materia] = (usado[c.materia] || 0) + 1;
    nuevasHoy.push(c);
  }

  const cola = [...vencidas, ...nuevasHoy];
  const hechasHoy = Object.values(st).filter((s) => s.ultima === hoy).length;

  return {
    hoy: cola,
    plan: plan.sort((a, b) => (a.dias == null) - (b.dias == null) || (a.dias || 0) - (b.dias || 0)),
    resumen: {
      fecha: hoy,
      pendientes: cola.length,
      vencidas: vencidas.length,
      nuevas: nuevasHoy.length,
      hechasHoy,
      totalTarjetas: cards.length,
      nuevasRestantes: nuevas.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Cobertura: qué pide el programa contra qué hay escrito en el vault
//
// La fuente es <Materia>/00-Seguimiento/programa-<sufijo>.md, con una tabla
// de Unidad | Tema. El hub no inventa el programa: si el archivo no está, lo
// dice y no muestra nada.
// ---------------------------------------------------------------------------

function parsearPrograma(cuerpo) {
  const temas = [];
  let unidadActual = '';
  let fence = false;
  for (const ln of String(cuerpo || '').split('\n')) {
    if (/^\s*```/.test(ln)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (!/^\s*\|/.test(ln)) continue;
    const cel = ln.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
    if (cel.length < 2) continue;
    if (cel.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    if (/^unidad$/i.test(cel[0]) && /^tema/i.test(cel[1] || '')) continue;
    const u = cel[0].replace(/\*+/g, '').trim();
    if (u) unidadActual = u;
    const tema = (cel[1] || '').replace(/\*+/g, '').trim();
    if (!tema || /^tema$/i.test(tema)) continue;
    const manual = (cel[2] || '').match(/\[\[([^\]|#]+)/);
    temas.push({ unidad: unidadActual, tema, notaManual: manual ? manual[1].trim() : null });
  }
  return temas;
}

/**
 * Decide si un tema del programa está cubierto. Nunca afirma más de lo que
 * sabe: devuelve la evidencia (qué nota, qué proporción de palabras) para que
 * la decisión final la tome el que lee.
 */
function evaluarTema(tema, notasMateria, notaManual, byStem) {
  if (notaManual) {
    const hit = (byStem.get(notaManual) || [])[0];
    if (hit) return { estado: 'nota', rel: hit.rel, titulo: hit.title, score: 1, via: 'manual' };
    return { estado: 'falta', via: 'manual-roto', manual: notaManual };
  }
  const t = [...raices(tema)];
  if (!t.length) return { estado: 'indeterminado' };
  const temaNorm = normalizar(tema);

  // Contra el título se usa F1, no recall: si el título trae palabras que el
  // tema no tiene, el match vale menos. Sin eso, "Costo total, medio y marginal"
  // se casaba con "Producto Total, Medio y Marginal" con la misma confianza que
  // con la nota correcta.
  const cands = [];
  let mejorCuerpo = null;
  const peso = (n) => (n.tipo === 'concepto' ? 2 : n.tipo === 'unidad' ? 0 : 1);
  for (const n of notasMateria) {
    if (normalizar(n.title) === temaNorm || normalizar(n.stem) === temaNorm)
      return { estado: 'nota', rel: n.rel, titulo: n.title, score: 1, via: 'titulo-exacto', candidatos: [] };
    const comunes = t.filter((w) => n._rTitulo.has(w)).length;
    if (comunes) {
      const rec = comunes / t.length;
      const pre = comunes / Math.max(1, n._rTitulo.size);
      cands.push({ rel: n.rel, titulo: n.title, tipo: n.tipo, score: (2 * rec * pre) / (rec + pre), peso: peso(n) });
    }
    const enCuerpo = t.filter((w) => n._rCuerpo.has(w)).length / t.length;
    const c = { rel: n.rel, titulo: n.title, tipo: n.tipo, peso: peso(n), score: enCuerpo };
    if (!mejorCuerpo || c.score > mejorCuerpo.score || (c.score === mejorCuerpo.score && c.peso > mejorCuerpo.peso))
      mejorCuerpo = c;
  }
  cands.sort((a, b) => b.score - a.score || b.peso - a.peso);
  const top = cands.slice(0, 3).map((c) => ({ rel: c.rel, titulo: c.titulo, score: Number(c.score.toFixed(2)) }));

  // Las alternativas nunca repiten la nota ya elegida.
  const otras = (elegida) => top.filter((c) => c.rel !== elegida);
  if (cands[0] && cands[0].score >= 0.6)
    return { estado: 'nota', rel: cands[0].rel, titulo: cands[0].titulo, score: Number(cands[0].score.toFixed(2)), via: 'titulo', candidatos: otras(cands[0].rel) };
  if (mejorCuerpo && mejorCuerpo.score >= 0.8)
    return { estado: 'mencionado', rel: mejorCuerpo.rel, titulo: mejorCuerpo.titulo, score: Number(mejorCuerpo.score.toFixed(2)), via: 'cuerpo', candidatos: otras(mejorCuerpo.rel) };
  return { estado: 'falta', candidatos: top };
}

async function cobertura(materiaId) {
  const { notes, byStem } = await buildIndex();
  const mats = materiaId ? [materiaId] : [...new Set(notes.map((n) => n.materia).filter(Boolean))];
  const out = [];
  for (const id of mats) {
    if (id === '00-Sistema') continue;
    const prog = notes.find((n) => n.materia === id && /^programa-/.test(n.stem));
    if (!prog) {
      out.push({ materia: id, sinPrograma: true });
      continue;
    }
    const temas = parsearPrograma(prog.cuerpo);
    const notasMateria = notes
      .filter((n) => n.materia === id && (n.tipo === 'concepto' || n.tipo === 'unidad' || n.tipo === 'clase' || !n.tipo))
      .map((n) => {
        if (!n._rTitulo) {
          n._rTitulo = raices(`${n.title} ${n.stem}`);
          n._rCuerpo = raices(n.cuerpo);
        }
        return n;
      });
    const filas = temas.map((t) => ({ ...t, ...evaluarTema(t.tema, notasMateria, t.notaManual, byStem) }));
    const unidades = [];
    for (const f of filas) {
      let u = unidades.find((x) => x.unidad === f.unidad);
      if (!u) {
        u = { unidad: f.unidad, temas: [], nota: 0, mencionado: 0, falta: 0 };
        unidades.push(u);
      }
      u.temas.push(f);
      if (f.estado === 'nota') u.nota++;
      else if (f.estado === 'mencionado') u.mencionado++;
      else u.falta++;
    }
    out.push({
      materia: id,
      programa: prog.rel,
      total: filas.length,
      nota: filas.filter((f) => f.estado === 'nota').length,
      mencionado: filas.filter((f) => f.estado === 'mencionado').length,
      falta: filas.filter((f) => f.estado === 'falta').length,
      unidades,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Captura rápida
// ---------------------------------------------------------------------------

async function crearCaptura({ materia, titulo, unidad }) {
  const { notes } = await buildIndex();
  const carpetas = await carpetasMateria();
  if (!carpetas.includes(materia)) throw new Error('Materia desconocida');
  const hoy = hoyISO();
  const base = String(titulo || '').trim() || `Clase ${unidad || ''}`.trim() || 'Captura';
  let stem = `${hoy} - ${base}`.replace(/[\\/:*?"<>|]/g, '-').slice(0, 90).trim();
  const usados = new Set(notes.map((n) => n.stem));
  if (usados.has(stem)) {
    let i = 2;
    while (usados.has(`${stem} (${i})`)) i++;
    stem = `${stem} (${i})`;
  }
  const rel = `${materia}/06-Clases/${stem}.md`;
  const fm = {
    tipo: 'clase',
    materia,
    unidad: unidad || '',
    estado: 'pendiente',
    tags: [materia, 'captura'],
  };
  const hora = new Date().toTimeString().slice(0, 5);
  const contenido = `${serializeFrontmatter(fm)}\n# ${base}\n\n<!-- captura rápida — texto crudo, sin ordenar -->\n\n${hora} · `;
  const abs = safeVaultPath(rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, contenido, { encoding: 'utf8', flag: 'wx' });
  await buildIndex(true);
  return { rel, contenido };
}

// ---------------------------------------------------------------------------
// Ingesta: de un PDF de cátedra a un borrador de notas
//
// El texto lo extrae el navegador con pdf.js — el PDF nunca se sube ni se
// guarda. Acá sólo llega el texto plano.
// ---------------------------------------------------------------------------

const INGESTA_TOPE = 120000;

const SISTEMA_INGERIR = `Sos un asistente que convierte material de cátedra en notas de un vault de Obsidian muy convencionado.

Recibís el texto plano de un PDF de la cátedra y tenés que proponer: UNA nota de unidad y VARIAS notas de concepto atómicas.

REGLAS INNEGOCIABLES:
1. NO inventes nada. Todo lo que escribas tiene que estar en el texto del PDF. Si el PDF no define algo, no lo definas vos. No agregues ejemplos, autores, fechas ni datos que no estén.
2. Wikilinks SOLO a notas que existen o que vos mismo estás proponiendo en esta misma respuesta. Te doy la lista exacta de stems que ya existen. Un wikilink a cualquier otra cosa rompe el grafo.
3. PROHIBIDO repetir un stem que ya existe en OTRA materia. Obsidian resuelve los enlaces por nombre de archivo: dos archivos con el mismo nombre son una colisión. Te doy la lista de stems ocupados.
4. Diagramas en Mermaid, jamás ASCII art. Dentro de un nodo de Mermaid no funciona **negrita**: usá <b> y <br/>. En mindmap, texto plano y MAYÚSCULAS.
5. Fórmulas en LaTeX: $...$ inline, $...$ en bloque.
6. Nunca uses alias con pipe dentro de tablas markdown.
7. Paleta fija en los style de Mermaid: #7C5CFF, #4DB6AC, #FFA726, siempre con color:#fff.

CADA NOTA DE CONCEPTO LLEVA:
- frontmatter con tipo: concepto, materia, unidad, parcial, estado: pendiente, tags
- H1 con el nombre del concepto
- una cita de una frase (> ...) que lo resuma
- la línea **Unidad:** [[<stem de la unidad>]] · **Materia:** [[<materia>]]
- el desarrollo, con tablas donde haya cosas comparables
- ## Conexiones con 3 a 6 wikilinks, cada uno con una frase que explique POR QUÉ se conectan
- ## En el parcial con qué se evalúa de este tema, si el texto da pistas. Este bloque se usa después como tarjeta de repaso: escribí una consigna concreta ("enunciar X y justificarlo con Y"), no una generalidad.

LA NOTA DE UNIDAD LLEVA: frontmatter con tipo: unidad, H1, el resumen de la unidad, un índice con wikilinks a TODOS los conceptos que proponés, y las fuentes.

Elegí entre 5 y 15 conceptos: los que el PDF desarrolla de verdad, no cada término que menciona al pasar.

RESPUESTA: sólo un objeto JSON válido, sin markdown alrededor:
{
  "unidad": { "stem": "U3-Nombre-De-La-Unidad", "contenido": "markdown completo con frontmatter" },
  "conceptos": [ { "stem": "Nombre del concepto", "contenido": "markdown completo con frontmatter" } ],
  "resumen": "dos o tres frases sobre qué cubre este material",
  "descartados": ["temas que aparecen en el PDF y decidiste no convertir en nota, con el motivo"]
}`;

async function ingerir({ materia, unidad, texto, fuente, modelo: modeloPedido, motor: motorPedido }) {
  const cfg = await readConfig();
  const elegido = await motorDisponible(motorPedido);
  const modelo = modeloPedido || cfg.modelo || 'claude-haiku-4-5';
  const { notes, byStem } = await buildIndex();
  const carpetas = await carpetasMateria();
  if (!carpetas.includes(materia)) throw new Error('Materia desconocida');

  let convenciones = '';
  try {
    convenciones = await fsp.readFile(path.join(VAULT, '00-Sistema', 'Convenciones.md'), 'utf8');
  } catch {}

  const propios = notes.filter((n) => n.materia === materia).map((n) => n.stem);
  const ajenos = notes.filter((n) => n.materia !== materia).map((n) => n.stem);
  const crudo = String(texto || '').replace(/ /g, '').trim();
  if (crudo.length < 400) throw new Error('El texto extraído es demasiado corto (¿el PDF es una imagen escaneada?)');
  const recortado = crudo.length > INGESTA_TOPE;
  const material = recortado ? crudo.slice(0, INGESTA_TOPE) : crudo;

  const usuario = `## Reglas del vault (00-Sistema/Convenciones.md)

${convenciones || '(no se encontró el archivo de convenciones)'}

## Destino

Materia: ${materia}
Unidad declarada por el estudiante: ${unidad || '(no la declaró — deducila del texto)'}
Archivo fuente: ${fuente || '(sin nombre)'}

## Notas que YA EXISTEN en ${materia} (podés enlazarlas, y no las dupliques)

${propios.join(' · ') || '(ninguna)'}

## Stems OCUPADOS por otras materias (prohibido usar estos nombres)

${ajenos.join(' · ') || '(ninguno)'}

## Texto del PDF${recortado ? ` (recortado a los primeros ${INGESTA_TOPE} caracteres de ${crudo.length})` : ''}

${material}`;

  const t0 = Date.now();
  let parsed;
  let usoMotor = {};

  if (elegido.motor === 'cli') {
    // El texto del PDF va por stdin: 120k caracteres no entran en argv.
    const r = await claudeJSON({
      instruccion: `Convertí en notas el material que viene por la entrada estándar. Materia: ${materia}. Unidad: ${unidad || '(deducila)'}.`,
      cuerpo: usuario,
      sistema: SISTEMA_INGERIR,
      schema: SCHEMA_INGERIR,
      tools: 'Read,Grep,Glob',
    });
    parsed = r.datos;
    usoMotor = r.uso;
  } else {
    const resp = await anthropic(cfg.apiKey, '/v1/messages', 'POST', {
      model: modelo,
      max_tokens: 16000,
      system: SISTEMA_INGERIR,
      messages: [{ role: 'user', content: usuario }],
    });
    const salida = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    try {
      parsed = JSON.parse(salida);
    } catch {
      const m = salida.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('El modelo no devolvió JSON reconocible');
      parsed = JSON.parse(m[0]);
    }
    usoMotor = {
      modelo,
      tokens_entrada: resp.usage?.input_tokens ?? null,
      tokens_salida: resp.usage?.output_tokens ?? null,
      costo_usd: null,
    };
  }

  const propuestas = [];
  if (parsed.unidad && parsed.unidad.stem)
    propuestas.push({ ...parsed.unidad, tipo: 'unidad', carpeta: `01-Unidades/${parsed.unidad.stem}` });
  for (const c of Array.isArray(parsed.conceptos) ? parsed.conceptos : [])
    if (c && c.stem) propuestas.push({ ...c, tipo: 'concepto', carpeta: '04-Conceptos' });

  // Verificación del lado del servidor. No se confía en la salida del modelo.
  const nuevos = new Set(propuestas.map((p) => p.stem));
  const notasPorMateria = new Map();
  for (const n of notes) notasPorMateria.set(n.stem, n.materia);

  for (const p of propuestas) {
    p.rel = `${materia}/${p.carpeta}/${p.stem}.md`;
    p.existe = fs.existsSync(safeVaultPath(p.rel));
    p.colision = byStem.has(p.stem) && notasPorMateria.get(p.stem) !== materia ? notasPorMateria.get(p.stem) : null;
    const rotos = [];
    const re = /\[\[([^\]|#]+)/g;
    let m;
    while ((m = re.exec(p.contenido || '')) !== null) {
      const t = m[1].trim();
      if (!t) continue;
      if (byStem.has(t) || nuevos.has(t) || t === materia) continue;
      if (!rotos.includes(t)) rotos.push(t);
    }
    p.enlaces_rotos = rotos;
    p.palabras = String(p.contenido || '').split(/\s+/).filter(Boolean).length;
  }

  const uso = {
    fecha: new Date().toISOString(),
    rel: `ingesta:${fuente || materia}`,
    motor: elegido.motor,
    ...usoMotor,
    ms: Date.now() - t0,
  };
  await registrarUso(uso);

  return {
    motor: elegido.motor,
    aviso: elegido.aviso || null,
    propuestas,
    resumen: parsed.resumen || '',
    descartados: Array.isArray(parsed.descartados) ? parsed.descartados : [],
    recortado,
    caracteres: crudo.length,
    uso,
  };
}

// ---------------------------------------------------------------------------
// GitHub
//
// Para las materias donde el material y la entrega viven en un repo (Ingeniería
// de Software III), el vault solo no alcanza: la fuente de verdad es el repo de
// la cátedra y lo que se evalúa es TU repo. Esto conecta las dos cosas.
//
// Sin token funciona en modo lectura sobre repos públicos (60 llamadas por hora,
// que es el límite de GitHub para anónimos). Con token, 5000 y acceso a repos
// privados, a la creación de repos y al calendario de contribuciones.
// ---------------------------------------------------------------------------

const GITHUB_FILE = path.join(HUB_DATA, 'github.json');

async function readGithub() {
  try {
    const j = JSON.parse(await fsp.readFile(GITHUB_FILE, 'utf8'));
    return { vinculos: [], visto: {}, ...j };
  } catch {
    return { vinculos: [], visto: {} };
  }
}
async function writeGithub(g) {
  await fsp.mkdir(HUB_DATA, { recursive: true });
  await fsp.writeFile(GITHUB_FILE, JSON.stringify(g, null, 2), 'utf8');
}

let ULTIMO_LIMITE = null;

// Se puede apuntar a otro host: GitHub Enterprise, o un mock para probar.
const GITHUB_API = process.env.GITHUB_API_HOST || 'api.github.com';
const GITHUB_HTTP = process.env.GITHUB_API_HOST ? require('http') : https;

function ghRequest(token, { host = GITHUB_API, ruta, metodo = 'GET', cuerpo = null }) {
  return new Promise((resolve, reject) => {
    const payload = cuerpo ? JSON.stringify(cuerpo) : null;
    const req = GITHUB_HTTP.request(
      {
        hostname: host.split(':')[0],
        port: host.includes(':') ? Number(host.split(':')[1]) : undefined,
        path: ruta,
        method: metodo,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'hub-facultad',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: 30000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.headers['x-ratelimit-remaining'] != null) {
            ULTIMO_LIMITE = {
              restante: Number(res.headers['x-ratelimit-remaining']),
              total: Number(res.headers['x-ratelimit-limit']),
              reset: Number(res.headers['x-ratelimit-reset']) * 1000,
            };
          }
          if (res.statusCode === 404) return resolve({ __404: true });
          let json;
          try {
            json = data ? JSON.parse(data) : {};
          } catch {
            return reject(new Error(`Respuesta no válida de GitHub (HTTP ${res.statusCode})`));
          }
          if (res.statusCode >= 400) {
            let msg = json?.message || `HTTP ${res.statusCode}`;
            if (res.statusCode === 403 && ULTIMO_LIMITE && ULTIMO_LIMITE.restante === 0) {
              const min = Math.ceil((ULTIMO_LIMITE.reset - Date.now()) / 60000);
              msg = `Se acabó el límite de GitHub (${ULTIMO_LIMITE.total} llamadas por hora). Se repone en ${min} minutos. Con un token el límite pasa a 5000.`;
            }
            if (res.statusCode === 401) msg = 'GitHub rechazó el token. ¿Expiró o no tiene los permisos?';
            return reject(new Error(msg));
          }
          resolve(json);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('GitHub tardó demasiado en responder')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const gh = (token, ruta, metodo, cuerpo) => ghRequest(token, { ruta, metodo, cuerpo });

async function ghGraphQL(token, query, variables) {
  const r = await ghRequest(token, { ruta: '/graphql', metodo: 'POST', cuerpo: { query, variables } });
  if (r.errors?.length) throw new Error(r.errors[0].message);
  return r.data;
}

async function ghToken() {
  const cfg = await readConfig();
  return cfg.githubToken || null;
}

/** Normaliza lo que el usuario pegue: URL completa, con .git, o ya owner/repo. */
function normalizarRepo(s) {
  let t = String(s || '').trim();
  t = t.replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '');
  const m = t.match(/^([\w.-]+)\/([\w.-]+)/);
  return m ? `${m[1]}/${m[2]}` : null;
}

// ---------------------------------------------------------------------------
// Novedades: qué subió la cátedra desde la última vez que miraste
// ---------------------------------------------------------------------------

async function ghNovedades() {
  const token = await ghToken();
  const g = await readGithub();
  const out = [];
  for (const v of g.vinculos) {
    let commits;
    try {
      commits = await gh(token, `/repos/${v.full_name}/commits?per_page=30`);
    } catch (err) {
      out.push({ ...v, error: err.message });
      continue;
    }
    if (commits.__404) {
      out.push({ ...v, error: 'El repo no existe o es privado y el token no lo alcanza' });
      continue;
    }
    const visto = g.visto[v.full_name]?.sha || null;
    const nuevos = [];
    for (const c of commits) {
      if (c.sha === visto) break;
      nuevos.push({
        sha: c.sha,
        corto: c.sha.slice(0, 7),
        fecha: c.commit?.author?.date || null,
        autor: c.commit?.author?.name || c.author?.login || '—',
        mensaje: (c.commit?.message || '').split('\n')[0],
        url: c.html_url,
      });
    }
    out.push({
      ...v,
      ultimo: commits[0]
        ? {
            sha: commits[0].sha,
            corto: commits[0].sha.slice(0, 7),
            fecha: commits[0].commit?.author?.date,
            mensaje: (commits[0].commit?.message || '').split('\n')[0],
          }
        : null,
      // Si nunca se marcó nada como visto, no se inventan "novedades": todo el
      // historial no es una novedad. Se muestran los últimos y listo.
      primeraVez: !visto,
      nuevos: visto ? nuevos : [],
      recientes: commits.slice(0, 8).map((c) => ({
        corto: c.sha.slice(0, 7),
        fecha: c.commit?.author?.date,
        autor: c.commit?.author?.name || '—',
        mensaje: (c.commit?.message || '').split('\n')[0],
        url: c.html_url,
      })),
    });
  }
  return { repos: out, limite: ULTIMO_LIMITE };
}

/** Archivos que tocó un commit — para saber si lo que subió te importa. */
async function ghArchivosDeCommit(full_name, sha) {
  const token = await ghToken();
  const c = await gh(token, `/repos/${full_name}/commits/${sha}`);
  if (c.__404) return [];
  return (c.files || []).map((f) => ({ ruta: f.filename, estado: f.status, mas: f.additions, menos: f.deletions }));
}

// ---------------------------------------------------------------------------
// Actividad: la matriz de commits
// ---------------------------------------------------------------------------

const GQL_CONTRIB = `query($login:String!, $from:DateTime!, $to:DateTime!){
  user(login:$login){
    contributionsCollection(from:$from, to:$to){
      totalCommitContributions
      contributionCalendar{
        totalContributions
        weeks{ contributionDays{ date weekday contributionCount } }
      }
    }
  }
}`;

async function ghActividad({ dias = 371 } = {}) {
  const token = await ghToken();
  const hasta = new Date();
  const desde = new Date(hasta.getTime() - dias * 86400000);

  // Camino bueno: el calendario real de GitHub, vía GraphQL. Necesita token.
  if (token) {
    try {
      const me = await gh(token, '/user');
      const d = await ghGraphQL(token, GQL_CONTRIB, {
        login: me.login,
        from: desde.toISOString(),
        to: hasta.toISOString(),
      });
      const cal = d.user.contributionsCollection.contributionCalendar;
      const dias_ = [];
      for (const w of cal.weeks) for (const dd of w.contributionDays) dias_.push({ fecha: dd.date, n: dd.contributionCount });
      return {
        origen: 'contribuciones',
        usuario: me.login,
        total: cal.totalContributions,
        dias: dias_,
      };
    } catch (err) {
      // Si el token no tiene el scope de lectura de usuario, se cae al plan B.
      if (!/scope|permission|token/i.test(err.message)) throw err;
    }
  }

  // Plan B, sin token: se arma con los commits de los repos vinculados. NO es
  // el calendario de contribuciones de GitHub y se declara como tal.
  const g = await readGithub();
  const conteo = new Map();
  let total = 0;
  for (const v of g.vinculos) {
    try {
      const cs = await gh(token, `/repos/${v.full_name}/commits?per_page=100&since=${desde.toISOString()}`);
      if (cs.__404 || !Array.isArray(cs)) continue;
      for (const c of cs) {
        const f = (c.commit?.author?.date || '').slice(0, 10);
        if (!f) continue;
        conteo.set(f, (conteo.get(f) || 0) + 1);
        total++;
      }
    } catch {}
  }
  const dias_ = [];
  for (let d = new Date(desde); d <= hasta; d.setDate(d.getDate() + 1)) {
    const f = ymd(d);
    dias_.push({ fecha: f, n: conteo.get(f) || 0 });
  }
  return { origen: 'repos-vinculados', usuario: null, total, dias: dias_, repos: g.vinculos.map((v) => v.full_name) };
}

// ---------------------------------------------------------------------------
// Entregables: el checklist contra lo que la cátedra pide
//
// Ingeniería de Software III no toma parciales escritos: se evalúa el repo y su
// defensa. Estas son las condiciones que se pueden verificar solas.
// ---------------------------------------------------------------------------

const ENTREGABLES = [
  { id: 'readme', txt: 'README.md en la raíz', tipo: 'archivo', ruta: 'README.md',
    por: 'El TP2 pide los pasos exactos para levantar el sistema en una máquina limpia.' },
  { id: 'decisiones', txt: 'decisiones.md en la raíz', tipo: 'archivo', ruta: 'decisiones.md',
    por: 'Entregable de TODOS los TPs. Vale 25 % junto con evidencias.md, y adentro va la declaración de uso de IA.' },
  { id: 'evidencias', txt: 'evidencias.md en la raíz', tipo: 'archivo', ruta: 'evidencias.md',
    por: 'Entregable de todos los TPs: las capturas marcadas 📸.' },
  { id: 'gitignore', txt: '.gitignore', tipo: 'archivo', ruta: '.gitignore',
    por: 'TP1 lo pide completo.' },
  { id: 'envexample', txt: '.env.example commiteado', tipo: 'archivo', ruta: '.env.example',
    por: 'TP2: los secretos van por .env NO commiteado, con .env.example sí commiteado.' },
  { id: 'envfuera', txt: '.env NO commiteado', tipo: 'ausente', ruta: '.env',
    por: 'TP2, y es pregunta de defensa: "¿por qué el .env no está en el repo?".' },
  { id: 'compose', txt: 'docker-compose.yml', tipo: 'archivo', ruta: 'docker-compose.yml',
    por: 'TP2: levanta front + back + BD con docker compose up -d.' },
  { id: 'tag', txt: 'Al menos un tag semver', tipo: 'tag',
    por: 'TP1 pide v1.0.0 sobre main; TP2, v0.1.0 en el registry.' },
  { id: 'release', txt: 'Release publicada', tipo: 'release',
    por: 'TP1: la release con sus notas de qué incluye.' },
  { id: 'pr', txt: 'Al menos un Pull Request cerrado', tipo: 'pr',
    por: 'decisiones.md y evidencias.md entran POR PR, no directo a main.' },
  { id: 'proteccion', txt: 'main protegido', tipo: 'proteccion',
    por: 'TP1: pregunta de defensa sobre el push directo rechazado. Requiere token con permiso de admin.' },
];

async function ghEntregables(full_name) {
  const token = await ghToken();
  const repo = await gh(token, `/repos/${full_name}`);
  if (repo.__404) throw new Error('No encuentro ese repo (o es privado y el token no llega)');

  const [raiz, tags, releases, prs] = await Promise.all([
    gh(token, `/repos/${full_name}/contents/`).catch(() => []),
    gh(token, `/repos/${full_name}/tags?per_page=20`).catch(() => []),
    gh(token, `/repos/${full_name}/releases?per_page=10`).catch(() => []),
    gh(token, `/repos/${full_name}/pulls?state=closed&per_page=20`).catch(() => []),
  ]);
  const archivos = new Set(Array.isArray(raiz) ? raiz.map((f) => f.name) : []);

  let proteccion = null;
  if (token) {
    try {
      const p = await gh(token, `/repos/${full_name}/branches/${repo.default_branch}/protection`);
      proteccion = p.__404 ? false : true;
    } catch {
      proteccion = null; // sin permiso para saberlo
    }
  }

  const filas = ENTREGABLES.map((e) => {
    let ok = null;
    let detalle = '';
    if (e.tipo === 'archivo') { ok = archivos.has(e.ruta); }
    else if (e.tipo === 'ausente') { ok = !archivos.has(e.ruta); if (!ok) detalle = '⚠️ está commiteado'; }
    else if (e.tipo === 'tag') {
      const semver = (Array.isArray(tags) ? tags : []).filter((t) => /^v?\d+\.\d+\.\d+$/.test(t.name));
      ok = semver.length > 0;
      detalle = semver.map((t) => t.name).slice(0, 4).join(' · ');
    } else if (e.tipo === 'release') {
      ok = Array.isArray(releases) && releases.length > 0;
      detalle = ok ? releases.map((r) => r.tag_name).slice(0, 3).join(' · ') : '';
    } else if (e.tipo === 'pr') {
      const merged = (Array.isArray(prs) ? prs : []).filter((p) => p.merged_at);
      ok = merged.length > 0;
      detalle = merged.length ? `${merged.length} mergeados` : '';
    } else if (e.tipo === 'proteccion') {
      ok = proteccion;
      if (proteccion === null) detalle = 'no lo puedo verificar sin token con permiso de admin';
    }
    return { ...e, ok, detalle };
  });

  return {
    repo: {
      full_name: repo.full_name,
      privado: repo.private,
      url: repo.html_url,
      rama: repo.default_branch,
      descripcion: repo.description,
      push: repo.pushed_at,
    },
    filas,
    listos: filas.filter((f) => f.ok === true).length,
    total: filas.length,
  };
}

// ---------------------------------------------------------------------------
// Crear repo, con el andamiaje que pide la cátedra
// ---------------------------------------------------------------------------

const SCAFFOLD = {
  'README.md': (n) => `# ${n}

Trabajo práctico de Ingeniería de Software III — UCC 2026.

## Cómo levantarlo en una máquina limpia

\`\`\`bash
git clone <url-de-este-repo>
cd ${n}
cp .env.example .env      # completar los valores
docker compose up -d
\`\`\`

## Qué hay acá

| Archivo | Qué es |
|---|---|
| \`decisiones.md\` | Por qué se hizo cada cosa, y la declaración de uso de IA |
| \`evidencias.md\` | Las capturas 📸 que pide cada TP |
`,
  'decisiones.md': () => `# Decisiones

> Se escribe hacia abajo: cada TP agrega su sección, no se reemplaza.
> El historial del semestre es uno solo.

## TP1 — Git colaborativo

### Qué decidí y por qué

<!-- Por qué Git no pudo resolver el conflicto solo. -->

### Problemas que encontré y cómo los resolví

<!-- Las cicatrices bien explicadas valen más que un repo perfecto sin explicación. -->

### Declaración de uso de IA

<!-- Qué usaste, para qué, y cómo verificaste lo que te devolvió. -->
`,
  'evidencias.md': () => `# Evidencias

> Una captura por ítem, con el 📸 y una línea de qué se está mirando.

## TP1 — Git colaborativo

- [ ] 📸 Push directo a \`main\` rechazado
- [ ] 📸 Aviso de conflicto en el Pull Request
- [ ] 📸 Marcadores del conflicto en el archivo
- [ ] 📸 Release publicada
`,
  '.gitignore': () => `# Entorno
.env
*.local

# Dependencias
node_modules/
__pycache__/
venv/
.venv/

# Build
dist/
build/
target/

# Sistema
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*
`,
  '.env.example': () => `# Copiá este archivo a .env y completá los valores.
# El .env NO se commitea nunca.

DB_HOST=db
DB_PORT=5432
DB_NAME=app
DB_USER=app
DB_PASSWORD=cambiar
`,
};

async function ghCrearRepo({ nombre, descripcion, privado = true, scaffold = true, materia }) {
  const token = await ghToken();
  if (!token) throw new Error('Para crear un repo hace falta un token de GitHub con permiso sobre repositorios');
  if (!/^[\w.-]{1,90}$/.test(String(nombre || ''))) throw new Error('Nombre de repo inválido');

  const repo = await gh(token, '/user/repos', 'POST', {
    name: nombre,
    description: descripcion || '',
    private: !!privado,
    auto_init: true,
  });

  const creados = [];
  if (scaffold) {
    for (const [ruta, gen] of Object.entries(SCAFFOLD)) {
      try {
        await gh(token, `/repos/${repo.full_name}/contents/${ruta}`, 'PUT', {
          message: `Andamiaje: ${ruta}`,
          content: Buffer.from(gen(nombre), 'utf8').toString('base64'),
        });
        creados.push(ruta);
      } catch (err) {
        creados.push(`${ruta} (falló: ${err.message})`);
      }
    }
  }

  if (materia) {
    const g = await readGithub();
    if (!g.vinculos.some((v) => v.full_name === repo.full_name))
      g.vinculos.push({ materia, full_name: repo.full_name, rol: 'propio' });
    await writeGithub(g);
  }

  return { repo: { full_name: repo.full_name, url: repo.html_url, privado: repo.private }, creados };
}

// ---------------------------------------------------------------------------
// La declaración de uso de IA, generada desde el registro real del hub
// ---------------------------------------------------------------------------

async function declaracionIA({ desde, hasta } = {}) {
  const log = await almacen.leer('ia-log', []);
  const filtrado = log.filter((l) => (!desde || l.fecha >= desde) && (!hasta || l.fecha <= hasta));
  if (!filtrado.length)
    return {
      markdown: '### Declaración de uso de IA\n\nNo usé asistentes de IA para este trabajo.\n',
      llamadas: 0,
    };

  const porModelo = new Map();
  let tokIn = 0, tokOut = 0;
  const notas = new Set();
  for (const l of filtrado) {
    porModelo.set(l.modelo, (porModelo.get(l.modelo) || 0) + 1);
    tokIn += l.tokens_entrada || 0;
    tokOut += l.tokens_salida || 0;
    if (l.rel) notas.add(l.rel);
  }
  const f = (s) => String(s).slice(0, 10);
  const md = `### Declaración de uso de IA

Usé un asistente de IA (Claude, vía la API de Anthropic) integrado en una herramienta propia
que escribe sobre mis apuntes. El registro que sigue no es una estimación: sale del log que
la herramienta escribe en cada llamada.

| | |
|---|---|
| Llamadas | ${filtrado.length} |
| Período | ${f(filtrado[0].fecha)} a ${f(filtrado[filtrado.length - 1].fecha)} |
| Modelos | ${[...porModelo.entries()].map(([m, n]) => `${m} (${n})`).join(' · ')} |
| Tokens | ${tokIn.toLocaleString('es-AR')} de entrada · ${tokOut.toLocaleString('es-AR')} de salida |
| Archivos tocados | ${notas.size} |

**Para qué lo usé:** ordenar apuntes escritos a mano alzada en clase según una convención de
formato, y proponer borradores de notas a partir de material de cátedra.

**Cómo verifiqué la salida:** la herramienta no aplica nada sola. Muestra un diff línea por
línea contra el texto original y hay que aceptarlo explícitamente. Además valida del lado del
servidor que todo enlace propuesto apunte a un archivo que existe de verdad, y marca en rojo
los que no — o sea que no confío en que el modelo no invente referencias: lo chequeo.

**Qué NO le delegué:** <!-- completar: las decisiones técnicas, el diseño de la solución, etc. -->
`;
  return { markdown: md, llamadas: filtrado.length, tokens: { entrada: tokIn, salida: tokOut } };
}

// ---------------------------------------------------------------------------
// Asistente
//
// Corre el CLI de Claude Code como proceso hijo, parado en el vault. La ventaja
// no es ahorrarse la API: es que el agente ABRE los archivos por su cuenta, así
// que no hay que adivinar qué contexto meterle. El vault ya tiene un CLAUDE.md
// por materia y Convenciones.md — eso se carga solo.
//
// Dos decisiones que importan:
//
// 1. NO se le dan herramientas de escritura. Ninguna. Para cambiar un archivo
//    tiene que emitir un bloque ```hub:escribir <ruta> y el hub lo muestra como
//    diff. Las escrituras las hace el hub, nunca el agente. En modo -p el CLI no
//    tiene forma de pedir permiso interactivo, así que ésta es la única manera
//    honesta de tener "confirmación".
//
// 2. Se BORRA ANTHROPIC_API_KEY del entorno del hijo. Si está seteada, Claude
//    Code la usa y factura la API en vez de consumir la suscripción. El hub
//    guarda una clave para otras funciones: no debe filtrarse acá.
// ---------------------------------------------------------------------------

const { spawn } = require('child_process');
const { crearAlmacen } = require('./db/almacen');

// Estado propio del hub: repaso, eventos y registro de IA. Va a Postgres si hay
// DATABASE_URL, a archivos si no. Las notas NUNCA pasan por acá: son .md.
const almacen = crearAlmacen(HUB_DATA);

const AGENTE_TOOLS = 'Read,Glob,Grep';
// Modo directo: escribe solo. Se habilita únicamente con git de por medio, así
// que cada turno tiene un punto de restauración y un botón de deshacer.
const AGENTE_TOOLS_ESCRITURA = 'Read,Glob,Grep,Write,Edit,MultiEdit,NotebookEdit';
const AGENTE_TIMEOUT = 10 * 60 * 1000;

let CLI_CACHE = null;

/** ¿Está el CLI instalado? Se cachea: no tiene sentido preguntarlo por turno. */
function cliDisponible(force = false) {
  if (CLI_CACHE && !force) return Promise.resolve(CLI_CACHE);
  return new Promise((resolve) => {
    let salida = '';
    let listo = false;
    // El timeout NO puede pisar el caché después de que el proceso ya respondió:
    // si lo hace, ocho segundos más tarde el CLI "deja de existir" solo.
    const terminar = (r) => {
      if (listo) return;
      listo = true;
      clearTimeout(reloj);
      CLI_CACHE = r;
      resolve(r);
    };
    const p = spawn('claude', ['--version'], { env: entornoLimpio() });
    p.stdout.on('data', (c) => (salida += c));
    p.on('error', () => terminar({ ok: false, error: 'no encontré el comando `claude` en el PATH' }));
    p.on('close', (code) => {
      if (code !== 0) return terminar({ ok: false, error: `\`claude --version\` salió con código ${code}` });
      terminar({ ok: true, version: salida.trim() });
    });
    const reloj = setTimeout(() => { p.kill(); terminar({ ok: false, error: 'el CLI no respondió' }); }, 8000);
  });
}

/**
 * El entorno del proceso hijo, sin la clave de API.
 * Con ANTHROPIC_API_KEY presente, Claude Code cobra la API en vez de usar la
 * suscripción. Es el error más caro que puede tener esta integración.
 */
function entornoLimpio() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  return env;
}

const SISTEMA_AGENTE = `Sos el asistente de estudio de Agustín, integrado en un hub web que vive sobre su vault de Obsidian. Estás parado en la raíz del vault y podés leer cualquier archivo.

## Cómo hablás

Español rioplatense, voseo. Directo, sin relleno, sin "es importante destacar". Si no sabés algo, leelo antes de contestar: tenés las herramientas.

## Las reglas del vault

Están en 00-Sistema/Convenciones.md y cada materia tiene su CLAUDE.md. Leelos cuando vayas a escribir o proponer algo. Lo esencial: wikilinks siempre (nunca rutas), sin stems duplicados entre materias, Mermaid nunca ASCII art, fórmulas en LaTeX, notas de concepto atómicas con bloque ## Conexiones de 3 a 6 enlaces y bloque ## En el parcial.

El bloque "## En el parcial" no es decorativo: el hub lo convierte en tarjeta de repaso espaciado. Escribí ahí una consigna concreta y accionable, no una generalidad.

## DÓNDE PODÉS TOCAR, EN CUALQUIER MODO

Sólo archivos .md dentro del vault. Nunca:

- \`00-Sistema/_hub/\` — es el código de la app, no una nota
- \`**/99-Material-Catedra/\` — son los PDFs originales de la cátedra
- \`.git/\`, \`.obsidian/\`, ni nada fuera de la raíz del vault

Antes de crear una nota, verificá que el stem no exista ya en OTRA materia: es la regla que más fácil se rompe y la que rompe el grafo.

## MODO PROPUESTA

No tenés herramientas de escritura, y es a propósito. Cuando quieras crear o modificar un archivo, emitilo así, con el contenido COMPLETO del archivo resultante:

\`\`\`hub:escribir Economia/04-Conceptos/Nombre del Concepto.md
---
tipo: concepto
materia: Economia
---

# Nombre del Concepto

...el archivo entero, no un fragmento...
\`\`\`

El hub se lo muestra a Agustín como diff línea por línea y él decide si se aplica. Vos proponés, él acepta. Podés emitir varios bloques en una misma respuesta.

Reglas de esos bloques: la ruta va relativa a la raíz del vault y siempre termina en .md; el contenido es el archivo COMPLETO, porque reemplaza al anterior; nunca los uses para archivos fuera del vault ni dentro de 00-Sistema/_hub/.

## No inventes

Si algo no está en los archivos que leíste, no lo afirmes. Un hueco declarado vale más que un dato inventado — es la regla con la que está construido todo este vault.`;

/** Foto compacta del estado del hub, para que no tenga que ir a buscarlo. */
async function contextoHub() {
  const partes = [];
  try {
    const r = await repasoEstado();
    const p = r.plan.map((x) => `${x.materia}: ${x.total} tarjetas, ${x.sinVer} sin ver${x.dias != null ? `, parcial en ${x.dias} días` : ''}`);
    partes.push(`Repaso hoy: ${r.resumen.pendientes} pendientes de ${r.resumen.totalTarjetas}. ${p.join(' · ')}`);
  } catch {}
  try {
    const h = await health();
    partes.push(`Salud: ${(h.rotos || []).length} wikilinks rotos, ${(h.duplicados || []).length} stems duplicados, ${(h.huerfanos || []).length} conceptos huérfanos.`);
  } catch {}
  try {
    const evs = await allEvents();
    const hoy = hoyISO();
    const prox = evs.filter((e) => e.fecha >= hoy).slice(0, 5)
      .map((e) => `${e.fecha} ${e.titulo} (${e.materia || '—'})`);
    if (prox.length) partes.push(`Próximos hitos: ${prox.join(' · ')}`);
  } catch {}
  try {
    const cob = await cobertura(null);
    const c = cob.filter((x) => !x.sinPrograma)
      .map((x) => `${x.materia}: ${x.nota}/${x.total} temas con nota, ${x.falta} sin cubrir`);
    if (c.length) partes.push(`Cobertura del programa: ${c.join(' · ')}`);
  } catch {}
  if (!partes.length) return '';
  return `\n\n## Estado del hub ahora mismo\n\n${partes.map((p) => '- ' + p).join('\n')}\n\nEs una foto del momento: si necesitás el detalle, leé los archivos.`;
}

/**
 * Lanza un turno y devuelve el proceso. Los eventos de stream-json salen por
 * stdout, una línea por evento; el router los reenvía tal cual al navegador.
 */
const SISTEMA_DIRECTO = `

## MODO DIRECTO — tenés Write y Edit

En este turno SÍ podés escribir archivos, sin pedir permiso. El vault está bajo git y el hub hizo un punto de restauración antes de largarte, así que un error es reversible con un botón. Eso no es excusa para ser descuidado: es la razón por la que podés trabajar sin interrumpir.

Cómo trabajar bien acá:

1. **Leé antes de escribir.** Nunca reemplaces un archivo que no abriste. Si vas a tocar una nota, leela entera primero.
2. **Preferí Edit sobre Write** en archivos que ya existen. Write pisa todo; Edit cambia lo que hay que cambiar y deja el resto intacto.
3. **Verificá al final.** Después de escribir, releé lo que escribiste. Si creaste wikilinks, comprobá con Glob o Grep que las notas destino existan de verdad.
4. **Contá lo que hiciste.** Terminá el turno con un resumen corto: qué archivos tocaste y por qué. Es lo que Agustín va a leer para decidir si lo deja o lo revierte.
5. **Si algo es ambiguo, preguntá en vez de adivinar.** Tener permiso de escritura no es una orden de escribir.

No uses los bloques \`hub:escribir\` en este modo: escribí directamente.`;

async function agenteTurno({ prompt, sesion, contexto, modelo, modo }) {
  const disp = await cliDisponible();
  if (!disp.ok) throw new Error(`No puedo usar el asistente: ${disp.error}`);

  const directo = modo === 'directo';
  const sistema = SISTEMA_AGENTE + (directo ? SISTEMA_DIRECTO : '') + (await contextoHub()) +
    (contexto ? `\n\n## Dónde está parado Agustín\n\n${contexto}` : '');

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--allowedTools', directo ? AGENTE_TOOLS_ESCRITURA : AGENTE_TOOLS,
    '--append-system-prompt', sistema,
  ];
  if (directo) args.push('--permission-mode', 'acceptEdits');
  if (modelo) args.push('--model', modelo);
  if (sesion) args.push('--resume', sesion);

  // Sin --bare: hace falta para que use la suscripción y para que cargue los
  // CLAUDE.md del vault, que es de donde sale la mitad del contexto útil.
  return spawn('claude', args, { cwd: VAULT, env: entornoLimpio() });
}

/** Saca los bloques ```hub:escribir del texto final. */
function extraerPropuestas(texto) {
  const out = [];
  const re = /```hub:escribir\s+([^\n]+)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(texto)) !== null) {
    const rel = m[1].trim();
    if (!rel.endsWith('.md')) continue;
    if (rel.includes('..') || rel.startsWith('/') || rel.startsWith('00-Sistema/_hub/')) continue;
    out.push({ rel, contenido: m[2].replace(/\n$/, '') });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Git sobre el vault
//
// Es la red que hace posible dejar que el asistente escriba solo. Antes de cada
// turno en modo directo se hace un checkpoint; si el resultado no gusta, se
// vuelve con un botón. Sin esto, "que edite por mí" sobre 200 notas sin control
// de versiones es una mala idea.
// ---------------------------------------------------------------------------

function git(args, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    const p = spawn('git', args, { cwd: VAULT, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', (e) => resolve({ ok: false, code: -1, out: '', err: e.message }));
    // `raw` sin trim: el porcelain de git arranca con un espacio significativo.
    p.on('close', (code) => resolve({ ok: code === 0, code, out: out.trim(), raw: out, err: err.trim() }));
    setTimeout(() => p.kill(), timeout);
  });
}

const GIT_ID = ['-c', 'user.email=hub@local', '-c', 'user.name=Hub Facultad'];

async function gitEstado() {
  const rev = await git(['rev-parse', '--is-inside-work-tree']);
  if (!rev.ok) return { repo: false, motivo: rev.err || 'no es un repositorio git' };
  const [head, sucio, ultimo] = await Promise.all([
    git(['rev-parse', '--short', 'HEAD']),
    git(['status', '--porcelain']),
    git(['log', '-1', '--format=%h|%ad|%s', '--date=iso']),
  ]);
  const [sha, fecha, msg] = (ultimo.out || '||').split('|');
  // Se usa `raw` y no `out`: el porcelain de git arranca con un espacio
  // significativo (" M archivo") que un trim() se comería, y la ruta saldría
  // cortada un carácter.
  const cambios = (sucio.raw || '').split('\n').filter((l) => l.length > 3);
  return {
    repo: true,
    head: head.out,
    limpio: cambios.length === 0,
    cambios: cambios.length,
    archivos: cambios.slice(0, 40).map((l) => ({ estado: l.slice(0, 2).trim(), ruta: desquotear(l.slice(3)) })),
    ultimo: { sha, fecha, mensaje: msg },
  };
}

/** Inicializa el repo. Lo corre el hub en la máquina del usuario, no a mano. */
async function gitInicializar() {
  const rev = await git(['rev-parse', '--is-inside-work-tree']);
  if (rev.ok) return { ya: true, ...(await gitEstado()) };

  const gi = path.join(VAULT, '.gitignore');
  if (!fs.existsSync(gi)) {
    await fsp.writeFile(gi, `# El hub entero. Tiene su propio repo: versionarlo también acá significa
# que un "deshacer" sobre el vault te revierte el código de la app.
00-Sistema/_hub/

# Material de cátedra: pesado y no es propio.
**/99-Material-Catedra/

# Papelera y paquetes de transferencia.
00-Sistema/_papelera/
*.tgz
*.zip

# Obsidian
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.trash/

# Sistema
.DS_Store
node_modules/
*.log
`, 'utf8');
  }
  await sembrarGitkeep();
  const init = await git(['init', '-b', 'main']);
  if (!init.ok) return { error: init.err || 'no pude inicializar el repo' };
  await git(['add', '-A']);
  const c = await git([...GIT_ID, 'commit', '-m', 'Vault de Facultad — estado inicial']);
  if (!c.ok && !/nothing to commit/i.test(c.out + c.err)) return { error: c.err || c.out };
  return { creado: true, ...(await gitEstado()) };
}

/**
 * Pone un .gitkeep en cada subcarpeta de materia vacía. git no versiona carpetas
 * vacías, así que sin esto el botón de deshacer (que corre `git clean -fd`) se
 * llevaría puesta la estructura del vault.
 */
async function sembrarGitkeep() {
  let puestos = 0;
  const carpetas = await carpetasMateria();
  for (const m of carpetas) {
    for (const sub of SUBCARPETAS) {
      const d = path.join(VAULT, m, sub);
      if (!fs.existsSync(d)) continue;
      try {
        const hay = await fsp.readdir(d);
        if (hay.filter((x) => !x.startsWith('.')).length) continue;
        await fsp.writeFile(path.join(d, '.gitkeep'), '', 'utf8');
        puestos++;
      } catch {}
    }
  }
  return puestos;
}

/**
 * Deja el árbol limpio antes de una operación que va a escribir sola.
 * Devuelve el sha al que se puede volver.
 */
async function gitCheckpoint(motivo) {
  const st = await gitEstado();
  if (!st.repo) return { repo: false };
  if (st.limpio) return { repo: true, sha: st.head, nuevo: false };
  await git(['add', '-A']);
  const c = await git([...GIT_ID, 'commit', '-m', `checkpoint: ${motivo || 'antes del asistente'}`]);
  if (!c.ok && !/nothing to commit/i.test(c.out + c.err)) return { repo: true, error: c.err || c.out };
  const head = await git(['rev-parse', '--short', 'HEAD']);
  return { repo: true, sha: head.out, nuevo: true };
}

/**
 * git cita las rutas con espacios o acentos: "Economia/Bien Giffen.md". Sin
 * desarmar eso, la ruta que llega al navegador no abre ningún archivo.
 */
function desquotear(r) {
  if (!r.startsWith('"')) return r;
  try { return JSON.parse(r); } catch { return r.slice(1, -1); }
}

/** Qué cambió desde un sha, en archivos y líneas. */
async function gitCambiosDesde(sha) {
  if (!sha) return { archivos: [] };
  const [stat, nombres] = await Promise.all([
    git(['diff', '--numstat', sha, '--']),
    git(['status', '--porcelain']),
  ]);
  const archivos = [];
  for (const l of (stat.out || '').split('\n').filter(Boolean)) {
    const [mas, menos, ruta] = l.split('\t');
    archivos.push({ ruta: desquotear(ruta), mas: Number(mas) || 0, menos: Number(menos) || 0, estado: 'modificado' });
  }
  // Lo que todavía no está commiteado (el asistente acaba de escribirlo).
  for (const l of (nombres.raw || '').split('\n').filter((x) => x.length > 3)) {
    const ruta = desquotear(l.slice(3));
    if (archivos.some((a) => a.ruta === ruta)) continue;
    archivos.push({ ruta, mas: 0, menos: 0, estado: l.slice(0, 2).trim() === '??' ? 'nuevo' : 'modificado' });
  }
  return { archivos };
}

/** Vuelve el árbol al sha, tirando todo lo posterior. Es el botón de deshacer. */
async function gitRevertir(sha) {
  if (!/^[0-9a-f]{4,40}$/i.test(String(sha || ''))) throw new Error('sha inválido');
  const existe = await git(['cat-file', '-e', `${sha}^{commit}`]);
  if (!existe.ok) throw new Error('no encuentro ese punto de restauración');
  const r = await git(['reset', '--hard', sha]);
  if (!r.ok) throw new Error(r.err || 'no pude revertir');
  const limpiar = await git(['clean', '-fd']);
  await buildIndex(true);
  return { ok: true, sha, salida: (r.out + '\n' + limpiar.out).trim() };
}

/** Diff de un archivo contra un punto, para mostrarlo en el navegador. */
async function gitDiffArchivo(sha, ruta) {
  const antes = await git(['show', `${sha}:${ruta}`]);
  let ahora = '';
  try {
    ahora = await fsp.readFile(safeVaultPath(ruta), 'utf8');
  } catch {}
  return { antes: antes.ok ? antes.out : '', ahora, existiaAntes: antes.ok };
}

// ---------------------------------------------------------------------------
// Motor: CLI o API
//
// Las funciones que generan (ordenar una nota, ingerir un PDF) pueden correr por
// el CLI de Claude Code —que consume la suscripción— o por la API con clave, que
// se cobra por token. Se prefiere el CLI cuando está; la clave queda de respaldo.
// ---------------------------------------------------------------------------

/**
 * Un turno de una sola vuelta con salida estructurada, por el CLI.
 * El grueso del texto va por stdin, no por argumento: un PDF de 120k caracteres
 * no entra en la línea de comandos de ningún sistema.
 */
function claudeJSON({ instruccion, cuerpo, sistema, schema, modelo, tools = 'Read,Grep,Glob' }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', instruccion,
      '--output-format', 'json',
      '--allowedTools', tools,
      '--append-system-prompt', sistema,
    ];
    if (schema) args.push('--json-schema', JSON.stringify(schema));
    if (modelo) args.push('--model', modelo);

    const p = spawn('claude', args, { cwd: VAULT, env: entornoLimpio() });
    let out = '';
    let err = '';
    const cortar = setTimeout(() => p.kill('SIGTERM'), 8 * 60 * 1000);
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', (e) => { clearTimeout(cortar); reject(new Error(`No pude ejecutar el CLI: ${e.message}`)); });
    p.on('close', (code) => {
      clearTimeout(cortar);
      if (code !== 0) return reject(new Error(err.trim().slice(0, 400) || `el CLI salió con código ${code}`));
      let j;
      try {
        j = JSON.parse(out);
      } catch {
        return reject(new Error('El CLI no devolvió JSON reconocible'));
      }
      if (j.is_error) return reject(new Error(String(j.result || 'el CLI reportó un error').slice(0, 400)));
      let datos = j.structured_output;
      if (!datos && typeof j.result === 'string') {
        const m = j.result.match(/\{[\s\S]*\}/);
        if (m) { try { datos = JSON.parse(m[0]); } catch {} }
      }
      if (!datos) return reject(new Error('El CLI no devolvió la estructura esperada'));
      resolve({
        datos,
        uso: {
          modelo: j.modelUsage ? Object.keys(j.modelUsage)[0] : (modelo || 'cli'),
          tokens_entrada: j.usage?.input_tokens ?? null,
          tokens_salida: j.usage?.output_tokens ?? null,
          costo_usd: j.total_cost_usd ?? null,
          ms: j.duration_ms ?? null,
        },
      });
    });
    if (cuerpo) { p.stdin.write(cuerpo); }
    p.stdin.end();
  });
}

/** Qué motor conviene usar, y por qué. */
async function motorDisponible(preferido) {
  const cli = await cliDisponible();
  const cfg = await readConfig();
  const hayClave = !!cfg.apiKey;
  if (preferido === 'api' && hayClave) return { motor: 'api' };
  if (preferido === 'cli' && !cli.ok) throw new Error(`No puedo usar el CLI: ${cli.error}`);
  if (cli.ok) return { motor: 'cli', version: cli.version };
  if (hayClave) return { motor: 'api', aviso: 'El CLI no está instalado: se usa la clave de API, que SÍ se cobra por token.' };
  throw new Error('No hay motor disponible: instalá el CLI de Claude Code, o cargá una clave de API en Ajustes.');
}

const SCHEMA_ORDENAR = {
  type: 'object',
  properties: {
    nota: { type: 'string', description: 'el markdown completo de la nota, frontmatter incluido' },
    conceptos_nuevos: { type: 'array', items: { type: 'string' } },
    cambios: { type: 'array', items: { type: 'string' } },
  },
  required: ['nota', 'conceptos_nuevos', 'cambios'],
};

const SCHEMA_INGERIR = {
  type: 'object',
  properties: {
    unidad: {
      type: 'object',
      properties: { stem: { type: 'string' }, contenido: { type: 'string' } },
      required: ['stem', 'contenido'],
    },
    conceptos: {
      type: 'array',
      items: {
        type: 'object',
        properties: { stem: { type: 'string' }, contenido: { type: 'string' } },
        required: ['stem', 'contenido'],
      },
    },
    resumen: { type: 'string' },
    descartados: { type: 'array', items: { type: 'string' } },
  },
  required: ['conceptos', 'resumen'],
};

/** Anota la llamada en el registro, venga del motor que venga. */
async function registrarUso(uso) {
  const log = await almacen.leer('ia-log', []);
  log.push(uso);
  await almacen.escribir('ia-log', log);
}

// ---------------------------------------------------------------------------
// Google Drive
//
// Cuatro trabajos: bajar material de cátedra al vault, subir y bajar archivos
// sueltos, hacer backup del vault fuera de esta máquina, y publicar una materia
// o una unidad como HTML para compartir.
//
// Sin dependencias: OAuth 2.0 y la Drive API son HTTPS plano. El token va a
// datos/config.json con permisos 600, igual que el de GitHub.
//
// SOBRE LOS PERMISOS, que es la decisión que importa acá:
// se piden dos scopes acotados en vez de acceso total.
//
//   drive.readonly → leer y bajar CUALQUIER archivo. Hace falta para navegar la
//                    carpeta de la cátedra y bajarse los PDFs.
//   drive.file     → escribir SÓLO los archivos que crea esta app. Alcanza para
//                    los backups y para publicar.
//
// La consecuencia práctica: el hub no puede modificar ni borrar ninguno de tus
// archivos anteriores de Drive, ni con un bug ni con una instrucción inyectada
// en una nota. Sólo toca lo que él mismo subió.
// ---------------------------------------------------------------------------

const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
].join(' ');

const DRIVE_REDIR = () => `http://127.0.0.1:${PORT}/api/drive/callback`;

/** POST application/x-www-form-urlencoded a un host de Google. */
function googleForm(host, ruta, campos) {
  return new Promise((resolve, reject) => {
    const cuerpo = new URLSearchParams(campos).toString();
    const req = https.request(
      {
        hostname: host,
        path: ruta,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(cuerpo),
        },
        timeout: 30000,
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let j;
          try {
            j = JSON.parse(d);
          } catch {
            return reject(new Error(`Respuesta no válida de Google (HTTP ${res.statusCode})`));
          }
          if (res.statusCode >= 400)
            return reject(new Error(j.error_description || j.error || `HTTP ${res.statusCode}`));
          resolve(j);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Google tardó demasiado')));
    req.on('error', reject);
    req.write(cuerpo);
    req.end();
  });
}

/** Llamada a la API de Drive con el token vigente. `crudo` devuelve el Buffer. */
function driveApi(token, { host = 'www.googleapis.com', ruta, metodo = 'GET', cuerpo = null, tipo = null, crudo = false }) {
  return new Promise((resolve, reject) => {
    const headers = { Authorization: `Bearer ${token}` };
    let payload = null;
    if (cuerpo != null) {
      payload = Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo));
      headers['Content-Type'] = tipo || 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = https.request({ hostname: host, path: ruta, method: metodo, headers, timeout: 180000 }, (res) => {
      const trozos = [];
      res.on('data', (c) => trozos.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(trozos);
        if (res.statusCode >= 400) {
          let msg = `HTTP ${res.statusCode}`;
          try {
            msg = JSON.parse(buf.toString()).error?.message || msg;
          } catch {}
          if (res.statusCode === 401) msg = 'TOKEN_VENCIDO';
          if (res.statusCode === 403 && /insufficient/i.test(msg))
            msg = 'Permiso insuficiente. El hub sólo puede modificar archivos que subió él mismo.';
          return reject(new Error(msg));
        }
        if (crudo) return resolve(buf);
        try {
          resolve(buf.length ? JSON.parse(buf.toString()) : {});
        } catch {
          resolve({});
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Drive tardó demasiado')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function driveConfig() {
  const cfg = await readConfig();
  return {
    clientId: cfg.driveClientId || null,
    clientSecret: cfg.driveClientSecret || null,
    refresh: cfg.driveRefresh || null,
    cuenta: cfg.driveCuenta || null,
  };
}

/** Token de acceso vigente. Se refresca solo con el refresh_token. */
let TOKEN_CACHE = { valor: null, vence: 0 };
async function driveToken(forzar = false) {
  if (!forzar && TOKEN_CACHE.valor && Date.now() < TOKEN_CACHE.vence - 60000) return TOKEN_CACHE.valor;
  const c = await driveConfig();
  if (!c.clientId || !c.clientSecret) throw new Error('Falta configurar las credenciales de Google en Ajustes');
  if (!c.refresh) throw new Error('Drive no está conectado todavía');
  const r = await googleForm('oauth2.googleapis.com', '/token', {
    client_id: c.clientId,
    client_secret: c.clientSecret,
    refresh_token: c.refresh,
    grant_type: 'refresh_token',
  });
  TOKEN_CACHE = { valor: r.access_token, vence: Date.now() + (r.expires_in || 3600) * 1000 };
  return TOKEN_CACHE.valor;
}

/** Reintenta una vez si el token venció en el medio. */
async function conToken(fn) {
  try {
    return await fn(await driveToken());
  } catch (err) {
    if (err.message !== 'TOKEN_VENCIDO') throw err;
    return fn(await driveToken(true));
  }
}

async function driveUrlAuth() {
  const c = await driveConfig();
  if (!c.clientId) throw new Error('Falta el Client ID');
  const p = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: DRIVE_REDIR(),
    response_type: 'code',
    scope: DRIVE_SCOPES,
    access_type: 'offline',
    prompt: 'consent', // fuerza que Google devuelva refresh_token
    include_granted_scopes: 'true',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function driveCanjear(code) {
  const c = await driveConfig();
  const r = await googleForm('oauth2.googleapis.com', '/token', {
    code,
    client_id: c.clientId,
    client_secret: c.clientSecret,
    redirect_uri: DRIVE_REDIR(),
    grant_type: 'authorization_code',
  });
  if (!r.refresh_token)
    throw new Error('Google no devolvió refresh_token. Revocá el acceso en myaccount.google.com/permissions y probá de nuevo.');
  TOKEN_CACHE = { valor: r.access_token, vence: Date.now() + (r.expires_in || 3600) * 1000 };
  let cuenta = null;
  try {
    const u = await driveApi(r.access_token, { ruta: '/drive/v3/about?fields=user(emailAddress,displayName)' });
    cuenta = u.user?.emailAddress || null;
  } catch {}
  const cfg = await readConfig();
  cfg.driveRefresh = r.refresh_token;
  cfg.driveCuenta = cuenta;
  await writeConfig(cfg);
  return { cuenta };
}

async function driveEstado() {
  const c = await driveConfig();
  const base = {
    credenciales: !!(c.clientId && c.clientSecret),
    conectado: !!c.refresh,
    cuenta: c.cuenta,
    scopes: DRIVE_SCOPES.split(' '),
    redirect: DRIVE_REDIR(),
  };
  if (!base.conectado) return base;
  try {
    const q = await conToken((t) => driveApi(t, { ruta: '/drive/v3/about?fields=storageQuota,user(emailAddress)' }));
    base.cuenta = q.user?.emailAddress || base.cuenta;
    if (q.storageQuota) {
      base.espacio = {
        usado: Number(q.storageQuota.usage || 0),
        total: Number(q.storageQuota.limit || 0) || null,
      };
    }
  } catch (err) {
    base.error = err.message;
  }
  return base;
}

const CAMPOS = 'id,name,mimeType,size,modifiedTime,parents,webViewLink,iconLink';

async function driveListar({ carpeta, q, pagina }) {
  return conToken(async (t) => {
    let query;
    if (q && q.trim()) {
      const seguro = q.replace(/['\\]/g, '\\$&');
      query = `name contains '${seguro}' and trashed = false`;
    } else {
      query = `'${(carpeta || 'root').replace(/'/g, "\\'")}' in parents and trashed = false`;
    }
    const p = new URLSearchParams({
      q: query,
      fields: `nextPageToken, files(${CAMPOS})`,
      pageSize: '100',
      orderBy: 'folder,name',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pagina) p.set('pageToken', pagina);
    const r = await driveApi(t, { ruta: `/drive/v3/files?${p}` });
    let ruta = [];
    if (carpeta && carpeta !== 'root') {
      // Migas de pan: se sube por los padres hasta la raíz.
      let id = carpeta;
      for (let i = 0; i < 8 && id && id !== 'root'; i++) {
        try {
          const f = await driveApi(t, { ruta: `/drive/v3/files/${id}?fields=id,name,parents&supportsAllDrives=true` });
          ruta.unshift({ id: f.id, nombre: f.name });
          id = f.parents?.[0];
        } catch {
          break;
        }
      }
    }
    return { archivos: r.files || [], siguiente: r.nextPageToken || null, ruta };
  });
}

/** Baja un archivo de Drive a una ruta del vault. */
async function driveBajar({ id, destino }) {
  const rel = String(destino || '').replace(/^\/+/, '');
  if (rel.includes('..')) throw new Error('Destino inválido');
  const abs = safeVaultPath(rel);
  if (fs.existsSync(abs)) throw new Error(`Ya existe ${rel} en el vault. Renombralo o elegí otro destino.`);

  return conToken(async (t) => {
    const meta = await driveApi(t, { ruta: `/drive/v3/files/${id}?fields=${CAMPOS}&supportsAllDrives=true` });
    let buf;
    if (String(meta.mimeType || '').startsWith('application/vnd.google-apps')) {
      // Un Doc o una Slide de Google no es un archivo: hay que exportarlo.
      const comoPdf = 'application/pdf';
      buf = await driveApi(t, {
        ruta: `/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(comoPdf)}`,
        crudo: true,
      });
    } else {
      buf = await driveApi(t, { ruta: `/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, crudo: true });
    }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, buf);
    await buildIndex(true);
    return { ok: true, rel, bytes: buf.length, nombre: meta.name, exportado: String(meta.mimeType).startsWith('application/vnd.google-apps') };
  });
}

/** Sube un buffer a Drive. Multipart armado a mano: no hace falta ninguna librería. */
async function driveSubirBuffer({ nombre, buf, tipo = 'application/octet-stream', carpeta = null }) {
  return conToken(async (t) => {
    const meta = { name: nombre, ...(carpeta ? { parents: [carpeta] } : {}) };
    const lim = '----hubfacultad' + Math.abs(buf.length * 2654435761 % 1e12).toString(36);
    const cuerpo = Buffer.concat([
      Buffer.from(`--${lim}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`),
      Buffer.from(`--${lim}\r\nContent-Type: ${tipo}\r\n\r\n`),
      buf,
      Buffer.from(`\r\n--${lim}--\r\n`),
    ]);
    const r = await driveApi(t, {
      ruta: '/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,size&supportsAllDrives=true',
      metodo: 'POST',
      cuerpo,
      tipo: `multipart/related; boundary=${lim}`,
    });
    return r;
  });
}

/** Sube un archivo que ya está en el vault. */
async function driveSubirDelVault({ rel, carpeta }) {
  const abs = safeVaultPath(String(rel || ''));
  const buf = await fsp.readFile(abs);
  const ext = path.extname(rel).toLowerCase();
  const tipo = { '.md': 'text/markdown', '.pdf': 'application/pdf', '.html': 'text/html', '.png': 'image/png', '.json': 'application/json' }[ext] || 'application/octet-stream';
  return driveSubirBuffer({ nombre: path.basename(rel), buf, tipo, carpeta });
}

/** Carpeta del hub en Drive, creada una sola vez. */
async function driveCarpetaHub(nombre = 'Hub Facultad') {
  return conToken(async (t) => {
    const p = new URLSearchParams({
      q: `name = '${nombre}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id,name)',
    });
    const r = await driveApi(t, { ruta: `/drive/v3/files?${p}` });
    if (r.files?.length) return r.files[0];
    return driveApi(t, {
      ruta: '/drive/v3/files?fields=id,name',
      metodo: 'POST',
      cuerpo: { name: nombre, mimeType: 'application/vnd.google-apps.folder' },
    });
  });
}

/**
 * Backup: un .tar.gz del vault, sin el material de cátedra ni el hub ni datos/.
 * Hoy git es local: si se muere el disco, se van 200 notas con él.
 */
async function driveBackup() {
  const carpeta = await driveCarpetaHub('Hub Facultad — backups');
  const nombre = `vault-${hoyISO()}-${new Date().toTimeString().slice(0, 5).replace(':', '')}.tar.gz`;
  const tmp = path.join(HUB_DATA, `_${nombre}`);
  await fsp.mkdir(HUB_DATA, { recursive: true });

  await new Promise((resolve, reject) => {
    const p = spawn('tar', [
      '-czf', tmp,
      '--exclude', '99-Material-Catedra',
      '--exclude', '_hub',
      '--exclude', '_papelera',
      '--exclude', '.git',
      '--exclude', '.obsidian',
      '-C', VAULT, '.',
    ]);
    let err = '';
    p.stderr.on('data', (c) => (err += c));
    p.on('error', reject);
    // tar avisa con código 1 por archivos que cambiaron mientras leía: no es fatal.
    p.on('close', (code) => (code === 0 || code === 1 ? resolve() : reject(new Error(err.slice(0, 300) || `tar salió con ${code}`))));
  });

  const buf = await fsp.readFile(tmp);
  const r = await driveSubirBuffer({ nombre, buf, tipo: 'application/gzip', carpeta: carpeta.id });
  await fsp.unlink(tmp).catch(() => {});
  const { notes } = await buildIndex();
  return { ...r, bytes: buf.length, notas: notes.length, carpeta: carpeta.name };
}

/**
 * Publicar: una materia o una unidad como HTML de un solo archivo.
 *
 * marked va embebido (43 KB) porque sin él no se renderiza nada. KaTeX y Mermaid
 * se cargan de CDN: son opcionales, pesan 4 MB juntos, y algo que compartís por
 * link se abre con internet igual.
 */
async function drivePublicar({ materia, unidad, soloHtml }) {
  const { notes } = await buildIndex();
  let sel = notes.filter((n) => n.materia === materia && !n.rel.includes('/99-Material-Catedra/'));
  if (unidad) sel = sel.filter((n) => n.unidad === unidad);
  if (!sel.length) throw new Error('No hay notas para publicar con ese filtro');

  const orden = { moc: 0, unidad: 1, concepto: 2, clase: 3, tp: 4 };
  sel.sort((a, b) => (orden[a.tipo] ?? 9) - (orden[b.tipo] ?? 9) || a.title.localeCompare(b.title));

  const marked = await fsp.readFile(path.join(HUB_DIR, 'frontend', 'public', 'vendor', 'marked.js'), 'utf8');
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const titulo = `${materia}${unidad ? ' — ' + unidad : ''}`;

  const docs = sel.map((n) => ({
    stem: n.stem,
    titulo: n.title,
    tipo: n.tipo,
    unidad: n.unidad,
    md: n.cuerpo,
  }));

  const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<style>
:root{--ink:#111;--ink2:#555;--linea:#e3e2dc;--fondo:#fff;--acento:#6247d4}
@media(prefers-color-scheme:dark){:root{--ink:#eee;--ink2:#aaa;--linea:#2c2c2a;--fondo:#151514;--acento:#8b7ff0}}
*{box-sizing:border-box}
body{margin:0;background:var(--fondo);color:var(--ink);
 font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
#wrap{display:grid;grid-template-columns:250px 1fr;max-width:1180px;margin:0 auto;gap:36px;padding:0 20px}
nav{position:sticky;top:0;align-self:start;height:100vh;overflow-y:auto;padding:28px 0;border-right:1px solid var(--linea)}
nav h1{font-size:17px;margin:0 0 4px}
nav .sub{font-size:12px;color:var(--ink2);margin-bottom:18px}
nav a{display:block;padding:5px 10px 5px 0;color:var(--ink2);text-decoration:none;font-size:13.5px;border-radius:6px}
nav a:hover{color:var(--ink)}
main{padding:28px 0 80px;min-width:0}
article{padding-bottom:30px;margin-bottom:30px;border-bottom:1px solid var(--linea)}
article:last-child{border:none}
h2{font-size:25px;letter-spacing:-.02em;margin:0 0 6px;scroll-margin-top:16px}
h3{font-size:18px;margin:26px 0 8px}
.meta{font-size:12px;color:var(--ink2);margin-bottom:16px}
blockquote{border-left:3px solid var(--acento);margin:0 0 16px;padding:2px 0 2px 15px;color:var(--ink2)}
table{border-collapse:collapse;width:100%;margin:0 0 18px;font-size:14px}
th,td{border:1px solid var(--linea);padding:7px 10px;text-align:left}
th{background:color-mix(in oklab,var(--ink) 5%,transparent)}
code{background:color-mix(in oklab,var(--ink) 8%,transparent);padding:1px 5px;border-radius:4px;font-size:.9em}
pre{background:color-mix(in oklab,var(--ink) 5%,transparent);padding:13px;border-radius:9px;overflow-x:auto}
pre code{background:none;padding:0}
.wl{color:var(--acento);text-decoration:none;border-bottom:1px solid color-mix(in oklab,var(--acento) 35%,transparent)}
.wl.ext{color:var(--ink2);border-bottom-style:dotted}
footer{grid-column:1/-1;padding:24px 0 60px;font-size:12px;color:var(--ink2);border-top:1px solid var(--linea)}
@media(max-width:820px){#wrap{grid-template-columns:1fr;gap:0}nav{position:static;height:auto;border:none;border-bottom:1px solid var(--linea)}}
</style></head><body>
<div id="wrap">
<nav><h1>${esc(titulo)}</h1><div class="sub">${sel.length} notas · ${new Date().toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' })}</div><div id="toc"></div></nav>
<main id="main"></main>
<footer>
Exportado desde el hub de apuntes de Agustín Di Tomaso. Los enlaces punteados apuntan a notas que no entraron en esta publicación.
</footer>
</div>
<script>${marked}</script>
<script>
const DOCS = ${JSON.stringify(docs)};
const STEMS = new Set(DOCS.map(d => d.stem));
const id = s => s.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').replace(/[^a-z0-9]+/g,'-');
const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const main = document.getElementById('main'), toc = document.getElementById('toc');

for (const d of DOCS) {
  const a = document.createElement('a');
  a.href = '#' + id(d.stem); a.textContent = d.titulo; toc.appendChild(a);

  const art = document.createElement('article');
  art.id = id(d.stem);
  const h = document.createElement('h2'); h.textContent = d.titulo; art.appendChild(h);
  if (d.tipo || d.unidad) {
    const m = document.createElement('div'); m.className = 'meta';
    m.textContent = [d.tipo, d.unidad].filter(Boolean).join(' · ');
    art.appendChild(m);
  }
  let md = d.md.replace(/^#\\s+.+$/m, '');
  md = md.replace(/\\[\\[([^\\]|#]+)(?:\\|([^\\]]+))?\\]\\]/g, (m, t, l) => {
    const target = t.trim(), txt = (l || t).trim();
    return STEMS.has(target)
      ? '<a class="wl" href="#' + id(target) + '">' + esc(txt) + '</a>'
      : '<span class="wl ext" title="No está en esta publicación">' + esc(txt) + '</span>';
  });
  const body = document.createElement('div');
  body.innerHTML = marked.parse(md, { gfm: true, breaks: false });
  art.appendChild(body);
  main.appendChild(art);
}

// KaTeX y Mermaid son opcionales: si no hay internet, el texto se lee igual.
function cargar(src, cb){ const s=document.createElement('script'); s.src=src; s.onload=cb; document.head.appendChild(s); }
if (document.body.textContent.includes('$')) {
  cargar('https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js', () =>
    cargar('https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js', () =>
      renderMathInElement(document.body, { delimiters: [
        {left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}], throwOnError:false })));
}
document.querySelectorAll('pre code.language-mermaid').forEach(c => {
  const d = document.createElement('div'); d.className='mermaid'; d.textContent=c.textContent;
  c.closest('pre').replaceWith(d);
});
if (document.querySelector('.mermaid')) {
  cargar('https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js', () => {
    mermaid.initialize({ startOnLoad:true, securityLevel:'loose',
      theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default' });
  });
}
</script></body></html>`;

  const nombre = `${titulo.replace(/[\\/:*?"<>|]/g, '-')}.html`;
  // Previsualizar no toca Drive: sirve para ver el resultado antes de subir, y
  // para probar el generador sin credenciales.
  if (soloHtml) return { html, nombre, notas: sel.length, bytes: Buffer.byteLength(html) };

  const carpeta = await driveCarpetaHub('Hub Facultad — publicado');
  const r = await driveSubirBuffer({ nombre, buf: Buffer.from(html, 'utf8'), tipo: 'text/html', carpeta: carpeta.id });
  return { ...r, notas: sel.length, bytes: Buffer.byteLength(html), carpeta: carpeta.name };
}

// ---------------------------------------------------------------------------
// Salud del vault
// ---------------------------------------------------------------------------

async function health() {
  const { notes, byStem } = await buildIndex(true);
  const stems = new Set(notes.map((n) => n.stem));

  const rotos = [];
  for (const n of notes) {
    if (n.rel.startsWith('00-Sistema/Plantillas/')) continue;
    for (const l of n.links) {
      if (!stems.has(l)) rotos.push({ desde: n.rel, destino: l });
    }
  }

  const duplicados = [];
  for (const [stem, list] of byStem) {
    if (list.length > 1) duplicados.push({ stem, rutas: list.map((n) => n.rel) });
  }

  const derivaEstado = [];
  const contador = new Map();
  for (const n of notes) {
    if (!n.estadoRaw) continue;
    const v = n.estadoRaw.toLowerCase();
    if (ESTADOS_CANON.includes(v)) continue;
    if (v.includes('|')) continue; // la línea de ejemplo de Convenciones.md
    if (!contador.has(v)) contador.set(v, []);
    contador.get(v).push(n.rel);
  }
  for (const [valor, rutas] of contador) {
    derivaEstado.push({ valor, sugerido: ESTADO_ALIAS[valor] || null, rutas });
  }

  const sinFrontmatter = notes
    .filter((n) => !n.tipo && !n.rel.startsWith('00-Sistema/'))
    .map((n) => n.rel);

  const huerfanas = [];
  const linkeadas = new Set();
  for (const n of notes) for (const l of n.links) linkeadas.add(l);
  for (const n of notes) {
    if (n.tipo !== 'concepto') continue;
    if (!linkeadas.has(n.stem)) huerfanas.push(n.rel);
  }

  const conexionesPobres = notes
    .filter((n) => n.tipo === 'concepto' && n.links.length < 3)
    .map((n) => ({ rel: n.rel, enlaces: n.links.length }));

  return {
    ok: rotos.length === 0,
    totales: { notas: notes.length, enlaces: notes.reduce((a, n) => a + n.links.length, 0) },
    rotos,
    duplicados,
    derivaEstado,
    sinFrontmatter,
    huerfanas,
    conexionesPobres,
  };
}

// ---------------------------------------------------------------------------
// Grafo
// ---------------------------------------------------------------------------

async function graph() {
  const { notes, byStem } = await buildIndex();
  const nodes = notes
    .filter((n) => !n.rel.startsWith('00-Sistema/'))
    .map((n) => ({
      id: n.stem,
      rel: n.rel,
      titulo: n.title,
      tipo: n.tipo || 'nota',
      materia: n.materia,
      unidad: n.unidad,
      estado: n.estado,
      grado: 0,
    }));
  const index = new Map(nodes.map((n) => [n.id, n]));
  const links = [];
  const seen = new Set();
  for (const n of notes) {
    if (!index.has(n.stem)) continue;
    for (const l of n.links) {
      if (!index.has(l) || l === n.stem) continue;
      const key = n.stem < l ? `${n.stem}|${l}` : `${l}|${n.stem}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ source: n.stem, target: l });
      index.get(n.stem).grado += 1;
      index.get(l).grado += 1;
    }
  }
  return { nodes, links };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function json(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 8e6) reject(new Error('cuerpo demasiado grande'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

async function serveStatic(res, name) {
  const file = path.join(PUBLIC_DIR, name);
  if (!file.startsWith(PUBLIC_DIR)) return json(res, { error: 'no' }, 400);
  try {
    const buf = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No encontrado');
  }
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);
  const q = parsed.query;

  try {
    // --- API -------------------------------------------------------------
    if (pathname === '/api/estado') {
      const [mats, evs, idx] = await Promise.all([materias(), allEvents(), buildIndex()]);
      return json(res, {
        vault: VAULT,
        generado: new Date().toISOString(),
        materias: mats,
        eventos: evs,
        notas: idx.notes.map((n) => ({
          rel: n.rel,
          stem: n.stem,
          titulo: n.title,
          tipo: n.tipo,
          materia: n.materia,
          unidad: n.unidad,
          parcial: n.parcial,
          estado: n.estado,
          estadoRaw: n.estadoRaw,
          tags: n.tags,
          enlaces: n.links.length,
          palabras: n.words,
          mtime: n.mtime,
          excerpt: n.excerpt,
        })),
      });
    }

    if (pathname === '/api/nota' && req.method === 'GET') {
      const abs = safeVaultPath(String(q.rel || ''));
      const text = await fsp.readFile(abs, 'utf8');
      const { data, body } = parseFrontmatter(text);
      const { byStem } = await buildIndex();
      const backlinks = [];
      const stem = path.basename(abs, '.md');
      for (const n of CACHE.notes) {
        if (n.links.includes(stem) && n.stem !== stem) {
          backlinks.push({ rel: n.rel, titulo: n.title, tipo: n.tipo });
        }
      }
      return json(res, { rel: String(q.rel), contenido: text, fm: data, cuerpo: body, backlinks });
    }

    if (pathname === '/api/nota' && (req.method === 'PUT' || req.method === 'POST')) {
      const body = await readBody(req);
      const abs = safeVaultPath(String(body.rel || ''));
      if (!abs.endsWith('.md')) return json(res, { error: 'solo .md' }, 400);
      const existe = fs.existsSync(abs);
      if (req.method === 'POST' && existe) return json(res, { error: 'ya existe' }, 409);
      if (req.method === 'PUT' && !existe) return json(res, { error: 'no existe' }, 404);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, String(body.contenido ?? ''), 'utf8');
      await buildIndex(true);
      return json(res, { ok: true, rel: body.rel });
    }

    if (pathname === '/api/plantilla') {
      const tipo = String(q.tipo || 'concepto');
      const materia = String(q.materia || '');
      const fm = { tipo, materia: materia || 'OAE', estado: 'pendiente', tags: [materia || 'OAE'] };
      if (tipo === 'concepto' || tipo === 'unidad' || tipo === 'tp') {
        fm.unidad = '';
        fm.parcial = '';
      }
      const titulo = String(q.titulo || 'Nueva nota');
      let cuerpo = `\n# ${titulo}\n\n> Resumen en una frase.\n\n**Materia:** [[${materia || 'OAE'}]]\n\n## Desarrollo\n\n`;
      if (tipo === 'concepto') {
        cuerpo += `\n## Conexiones\n\n- [[ ]] — por qué se conecta\n- [[ ]] — por qué se conecta\n- [[ ]] — por qué se conecta\n\n## En el parcial\n\n`;
      }
      return json(res, { contenido: serializeFrontmatter(fm) + cuerpo });
    }

    if (pathname === '/api/eventos' && req.method === 'POST') {
      const body = await readBody(req);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.fecha || '')))
        return json(res, { error: 'fecha inválida' }, 400);
      if (!String(body.titulo || '').trim()) return json(res, { error: 'falta título' }, 400);
      const list = await readUserEvents();
      const ev = {
        id: `user:${Date.now()}:${Math.round(Number(body.fecha.replace(/-/g, '')))}`,
        fecha: body.fecha,
        titulo: String(body.titulo).trim(),
        materia: body.materia || null,
        tipo: body.tipo || 'hito',
        nota: body.nota || '',
        origen: 'hub',
        editable: true,
      };
      list.push(ev);
      await writeUserEvents(list);
      return json(res, { ok: true, evento: ev });
    }

    if (pathname === '/api/eventos' && req.method === 'DELETE') {
      const body = await readBody(req);
      const list = await readUserEvents();
      const next = list.filter((e) => e.id !== body.id);
      await writeUserEvents(next);
      return json(res, { ok: true, borrados: list.length - next.length });
    }

    if (pathname === '/api/materia-impacto') {
      return json(res, await impactoMateria(String(q.id || '')));
    }

    if (pathname === '/api/materia' && req.method === 'POST') {
      const b = await readBody(req);
      const id = String(b.id || '').trim();
      const sufijo = String(b.sufijo || '').trim().toLowerCase();
      if (!/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9][A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 _-]{1,40}$/.test(id))
        return json(res, { error: 'Nombre de carpeta inválido' }, 400);
      if (!/^[a-z0-9-]{2,12}$/.test(sufijo))
        return json(res, { error: 'El sufijo va en minúsculas, 2 a 12 caracteres' }, 400);
      const resultado = await crearMateria({
        id,
        nombre: String(b.nombre || id).trim(),
        corto: String(b.corto || id).trim(),
        sufijo,
        conProyecto: !!b.conProyecto,
      });
      return json(res, { ok: true, ...resultado });
    }

    if (pathname === '/api/materia' && req.method === 'PATCH') {
      const b = await readBody(req);
      const id = String(b.id || '');
      const dir = safeVaultPath(id);
      if (!fs.existsSync(dir)) return json(res, { error: 'no existe' }, 404);
      const cfg = await readMateriasCfg();
      const prev = { ...(MATERIA_META[id] || {}), ...(cfg[id] || {}) };
      const slot = b.slot != null ? Number(b.slot) : prev.slot;
      if (slot != null && (!Number.isInteger(slot) || slot < 0 || slot > SLOTS_COLOR))
        return json(res, { error: `slot fuera de rango (0 a ${SLOTS_COLOR})` }, 400);
      cfg[id] = {
        ...prev,
        nombre: b.nombre != null ? String(b.nombre).trim() : prev.nombre,
        corto: b.corto != null ? String(b.corto).trim() : prev.corto,
        slot,
        orden: b.orden != null ? Number(b.orden) : prev.orden,
        archivada: b.archivada != null ? !!b.archivada : !!prev.archivada,
      };
      await writeMateriasCfg(cfg);
      return json(res, { ok: true, materia: cfg[id] });
    }

    if (pathname === '/api/materia' && req.method === 'DELETE') {
      const b = await readBody(req);
      const id = String(b.id || '');
      if (b.confirmar !== id)
        return json(res, { error: 'Falta confirmar escribiendo el nombre exacto' }, 400);
      return json(res, { ok: true, ...(await borrarMateria(id)) });
    }

    if (pathname === '/api/config' && req.method === 'GET') {
      const cfg = await readConfig();
      const log = await almacen.leer('ia-log', []);
      const gastos = log.reduce(
        (a, u) => ({ entrada: a.entrada + (u.tokens_entrada || 0), salida: a.salida + (u.tokens_salida || 0) }),
        { entrada: 0, salida: 0 }
      );
      return json(res, {
        // La clave nunca vuelve entera: solo si está puesta y sus últimos 4.
        tieneClave: !!cfg.apiKey,
        claveCola: cfg.apiKey ? cfg.apiKey.slice(-4) : null,
        modelo: cfg.modelo || null,
        llamadas: log.length,
        tokens: gastos,
        ultimas: log.slice(-10).reverse(),
      });
    }

    if (pathname === '/api/config' && req.method === 'POST') {
      const b = await readBody(req);
      const cfg = await readConfig();
      if (typeof b.apiKey === 'string') {
        const k = b.apiKey.trim();
        if (k === '') delete cfg.apiKey;
        else if (!/^sk-ant-/.test(k))
          return json(res, { error: 'Una clave de Anthropic empieza con sk-ant-' }, 400);
        else cfg.apiKey = k;
      }
      if (typeof b.modelo === 'string' && b.modelo.trim()) cfg.modelo = b.modelo.trim();
      await writeConfig(cfg);
      return json(res, { ok: true });
    }

    if (pathname === '/api/motor') {
      try {
        return json(res, await motorDisponible(q.preferido ? String(q.preferido) : null));
      } catch (err) {
        return json(res, { motor: null, error: err.message });
      }
    }

    if (pathname === '/api/modelos') {
      const cfg = await readConfig();
      if (!cfg.apiKey) return json(res, { error: 'Falta la clave de API' }, 400);
      // Se pregunta a la API en vez de hardcodear IDs: así no envejece.
      const r = await anthropic(cfg.apiKey, '/v1/models?limit=100', 'GET', null);
      return json(res, { modelos: (r.data || []).map((m) => ({ id: m.id, nombre: m.display_name })) });
    }

    if (pathname === '/api/ordenar' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.contenido || !String(b.contenido).trim())
        return json(res, { error: 'La nota está vacía' }, 400);
      return json(res, await ordenarNota({
        rel: String(b.rel || ''),
        contenido: String(b.contenido),
        motor: b.motor ? String(b.motor) : null,
      }));
    }

    if (pathname === '/api/buscar') {
      return json(res, await buscar(String(q.q || ''), Number(q.limite) || 30));
    }

    if (pathname === '/api/salud') return json(res, await health());
    if (pathname === '/api/grafo') return json(res, await graph());

    // --- Repaso espaciado --------------------------------------------------
    if (pathname === '/api/repaso' && req.method === 'GET') {
      return json(res, await repasoEstado());
    }

    if (pathname === '/api/repaso' && req.method === 'POST') {
      const b = await readBody(req);
      const rel = String(b.rel || '');
      const nota = Number(b.nota);
      if (!rel) return json(res, { error: 'falta rel' }, 400);
      if (![0, 1, 2, 3].includes(nota)) return json(res, { error: 'nota inválida' }, 400);
      const st = await readRepaso();
      const { notes } = await buildIndex();
      const n = notes.find((x) => x.rel === rel);
      const examen = await proximosExamenes();
      const ex = n && examen[n.materia] ? examen[n.materia] : null;
      const tope = ex ? Math.max(1, diasEntre(hoyISO(), ex.fecha) - 1) : null;
      st[rel] = programar(st[rel], nota, tope);
      await writeRepaso(st);
      return json(res, { ok: true, estado: st[rel] });
    }

    if (pathname === '/api/repaso' && req.method === 'DELETE') {
      const b = await readBody(req);
      const st = await readRepaso();
      if (b.rel) delete st[b.rel];
      else if (b.todo === true) {
        for (const k of Object.keys(st)) delete st[k];
      }
      await writeRepaso(st);
      return json(res, { ok: true });
    }

    // --- Cobertura del programa -------------------------------------------
    if (pathname === '/api/cobertura') {
      return json(res, { materias: await cobertura(q.materia ? String(q.materia) : null) });
    }

    // --- Captura rápida ----------------------------------------------------
    if (pathname === '/api/captura' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, await crearCaptura({
        materia: String(b.materia || ''),
        titulo: String(b.titulo || ''),
        unidad: String(b.unidad || ''),
      }));
    }

    // --- Git ---------------------------------------------------------------
    // Healthcheck del contenedor: barato, sin tocar el vault.
    if (pathname === '/api/vivo') {
      return json(res, { ok: true, almacen: await almacen.salud(), version: 3 });
    }

    if (pathname === '/api/git/estado') return json(res, await gitEstado());

    if (pathname === '/api/git/init' && req.method === 'POST') {
      return json(res, await gitInicializar());
    }

    if (pathname === '/api/git/checkpoint' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, await gitCheckpoint(b.motivo ? String(b.motivo) : null));
    }

    if (pathname === '/api/git/revertir' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, await gitRevertir(String(b.sha || '')));
    }

    if (pathname === '/api/git/diff') {
      return json(res, await gitDiffArchivo(String(q.sha || ''), String(q.ruta || '')));
    }

    // --- Google Drive ------------------------------------------------------
    if (pathname === '/api/drive/estado') return json(res, await driveEstado());

    if (pathname === '/api/drive/config' && req.method === 'POST') {
      const b = await readBody(req);
      const cfg = await readConfig();
      if (b.clientId != null) cfg.driveClientId = String(b.clientId).trim() || undefined;
      if (b.clientSecret != null) cfg.driveClientSecret = String(b.clientSecret).trim() || undefined;
      await writeConfig(cfg);
      return json(res, await driveEstado());
    }

    if (pathname === '/api/drive/auth') {
      return json(res, { url: await driveUrlAuth() });
    }

    // Google redirige acá con el código. Se responde HTML porque lo abre el
    // navegador, no el hub.
    if (pathname === '/api/drive/callback') {
      const pagina = (titulo, cuerpo, color) => {
        const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${titulo}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;background:#0d0d0d;color:#fff;display:grid;place-items:center;height:100vh;margin:0;text-align:center;padding:20px}
.c{max-width:460px}h1{font-size:22px;margin:0 0 10px;color:${color}}p{color:#c3c2b7;margin:0 0 8px}</style></head>
<body><div class="c"><h1>${titulo}</h1>${cuerpo}</div></body></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      };
      if (q.error) return pagina('Autorización cancelada', `<p>Google devolvió: ${String(q.error)}</p><p>Podés cerrar esta pestaña.</p>`, '#d55181');
      if (!q.code) return pagina('Falta el código', '<p>Google no mandó ningún código de autorización.</p>', '#d55181');
      try {
        const r = await driveCanjear(String(q.code));
        return pagina('Drive conectado ✓', `<p>Cuenta: <b>${r.cuenta || '—'}</b></p><p>Ya podés cerrar esta pestaña y volver al hub.</p>`, '#12a596');
      } catch (err) {
        return pagina('No pude completar la conexión', `<p>${String(err.message)}</p>`, '#d55181');
      }
    }

    if (pathname === '/api/drive/desconectar' && req.method === 'POST') {
      const cfg = await readConfig();
      delete cfg.driveRefresh;
      delete cfg.driveCuenta;
      await writeConfig(cfg);
      return json(res, { ok: true });
    }

    if (pathname === '/api/drive/listar') {
      return json(res, await driveListar({
        carpeta: q.carpeta ? String(q.carpeta) : null,
        q: q.q ? String(q.q) : null,
        pagina: q.pagina ? String(q.pagina) : null,
      }));
    }

    if (pathname === '/api/drive/bajar' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, await driveBajar({ id: String(b.id || ''), destino: String(b.destino || '') }));
    }

    if (pathname === '/api/drive/subir' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, await driveSubirDelVault({ rel: String(b.rel || ''), carpeta: b.carpeta ? String(b.carpeta) : null }));
    }

    if (pathname === '/api/drive/backup' && req.method === 'POST') {
      return json(res, await driveBackup());
    }

    if (pathname === '/api/drive/publicar' && req.method === 'POST') {
      const b = await readBody(req);
      const pub = await drivePublicar({
        materia: String(b.materia || ''),
        unidad: b.unidad ? String(b.unidad) : null,
        soloHtml: !!b.previsualizar,
      });
      if (b.previsualizar) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(pub.html);
      }
      return json(res, pub);
    }

    // --- Asistente ---------------------------------------------------------
    if (pathname === '/api/agente/estado') {
      const [d, g] = await Promise.all([cliDisponible(q.force === '1'), gitEstado()]);
      return json(res, {
        ...d,
        herramientas: AGENTE_TOOLS.split(','),
        herramientasEscritura: AGENTE_TOOLS_ESCRITURA.split(','),
        git: g,
        vault: VAULT,
      });
    }

    if (pathname === '/api/agente' && req.method === 'POST') {
      const b = await readBody(req);
      const prompt = String(b.prompt || '').trim();
      if (!prompt) return json(res, { error: 'falta el prompt' }, 400);

      const directo = b.modo === 'directo';
      // El modo directo NO existe sin git: el punto de restauración es lo único
      // que convierte "que escriba solo" en una operación reversible.
      let checkpoint = null;
      if (directo) {
        checkpoint = await gitCheckpoint('antes del asistente');
        if (!checkpoint.repo)
          return json(res, { error: 'El modo directo necesita que el vault esté bajo git. Inicializalo desde Ajustes.' }, 409);
        if (checkpoint.error) return json(res, { error: `No pude hacer el punto de restauración: ${checkpoint.error}` }, 500);
      }

      let hijo;
      try {
        hijo = await agenteTurno({
          prompt,
          sesion: b.sesion ? String(b.sesion) : null,
          contexto: b.contexto ? String(b.contexto).slice(0, 4000) : null,
          modelo: b.modelo ? String(b.modelo) : null,
          modo: directo ? 'directo' : 'propuesta',
        });
      } catch (err) {
        return json(res, { error: err.message }, 503);
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const enviar = (tipo, dato) => {
        if (res.writableEnded) return;
        res.write(`event: ${tipo}\ndata: ${JSON.stringify(dato)}\n\n`);
      };

      let buf = '';
      let textoFinal = '';
      let errStd = '';

      hijo.stdout.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const linea = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!linea) continue;
          let ev;
          try {
            ev = JSON.parse(linea);
          } catch {
            continue;
          }
          if (ev.type === 'result' && typeof ev.result === 'string') textoFinal = ev.result;
          enviar('evento', ev);
        }
      });

      hijo.stderr.on('data', (c) => { errStd += c; });

      const cortar = setTimeout(() => {
        enviar('error', { mensaje: 'El asistente tardó demasiado y lo corté.' });
        hijo.kill('SIGTERM');
      }, AGENTE_TIMEOUT);

      hijo.on('error', (err) => {
        clearTimeout(cortar);
        enviar('error', { mensaje: err.message });
        if (!res.writableEnded) res.end();
      });

      hijo.on('close', async (code) => {
        clearTimeout(cortar);
        // Las propuestas de escritura se extraen del lado del servidor, no del
        // navegador: es el mismo criterio que con los wikilinks del ordenador.
        const propuestas = extraerPropuestas(textoFinal).map((p) => {
          let actual = null;
          try {
            actual = fs.readFileSync(safeVaultPath(p.rel), 'utf8');
          } catch {}
          return { ...p, existe: actual !== null, actual };
        });
        let escrituras = null;
        if (directo && checkpoint?.sha) {
          await buildIndex(true);
          const d = await gitCambiosDesde(checkpoint.sha);
          escrituras = { desde: checkpoint.sha, archivos: d.archivos };
        }
        enviar('fin', {
          code,
          propuestas,
          escrituras,
          stderr: code === 0 ? '' : errStd.slice(0, 2000),
        });
        if (!res.writableEnded) res.end();
      });

      req.on('close', () => {
        clearTimeout(cortar);
        if (hijo.exitCode === null) hijo.kill('SIGTERM');
      });
      return;
    }

    // --- GitHub ------------------------------------------------------------
    if (pathname === '/api/github/estado') {
      const token = await ghToken();
      const g = await readGithub();
      let usuario = null;
      if (token) {
        try {
          const u = await gh(token, '/user');
          usuario = { login: u.login, nombre: u.name, avatar: u.avatar_url, repos: u.public_repos };
        } catch (err) {
          return json(res, { token: true, tokenError: err.message, vinculos: g.vinculos, limite: ULTIMO_LIMITE });
        }
      }
      return json(res, { token: !!token, usuario, vinculos: g.vinculos, visto: g.visto, limite: ULTIMO_LIMITE });
    }

    if (pathname === '/api/github/config' && req.method === 'POST') {
      const b = await readBody(req);
      const token = String(b.token || '').trim();
      const cfg = await readConfig();
      if (!token) {
        delete cfg.githubToken;
        await writeConfig(cfg);
        return json(res, { ok: true, token: false });
      }
      const u = await gh(token, '/user'); // valida antes de guardar
      cfg.githubToken = token;
      await writeConfig(cfg);
      return json(res, { ok: true, token: true, usuario: { login: u.login, nombre: u.name } });
    }

    if (pathname === '/api/github/vinculo' && req.method === 'POST') {
      const b = await readBody(req);
      const full = normalizarRepo(b.full_name);
      if (!full) return json(res, { error: 'No entiendo ese repo. Pegá la URL o owner/repo.' }, 400);
      const carpetas = await carpetasMateria();
      if (!carpetas.includes(String(b.materia || ''))) return json(res, { error: 'Materia desconocida' }, 400);
      const r = await gh(await ghToken(), `/repos/${full}`);
      if (r.__404) return json(res, { error: `No encuentro ${full}. Si es privado, hace falta un token que lo alcance.` }, 404);
      const g = await readGithub();
      g.vinculos = g.vinculos.filter((v) => v.full_name !== full);
      g.vinculos.push({
        materia: String(b.materia),
        full_name: full,
        rol: b.rol === 'propio' ? 'propio' : 'catedra',
        url: r.html_url,
        privado: r.private,
      });
      await writeGithub(g);
      return json(res, { ok: true, vinculos: g.vinculos });
    }

    if (pathname === '/api/github/vinculo' && req.method === 'DELETE') {
      const b = await readBody(req);
      const g = await readGithub();
      g.vinculos = g.vinculos.filter((v) => v.full_name !== b.full_name);
      delete g.visto[b.full_name];
      await writeGithub(g);
      return json(res, { ok: true, vinculos: g.vinculos });
    }

    if (pathname === '/api/github/novedades') return json(res, await ghNovedades());

    if (pathname === '/api/github/visto' && req.method === 'POST') {
      const b = await readBody(req);
      const g = await readGithub();
      g.visto[String(b.full_name)] = { sha: String(b.sha || ''), fecha: new Date().toISOString() };
      await writeGithub(g);
      return json(res, { ok: true });
    }

    if (pathname === '/api/github/commit') {
      return json(res, { archivos: await ghArchivosDeCommit(String(q.full_name || ''), String(q.sha || '')) });
    }

    if (pathname === '/api/github/actividad') {
      return json(res, await ghActividad({ dias: Number(q.dias) || 371 }));
    }

    if (pathname === '/api/github/entregables') {
      return json(res, await ghEntregables(normalizarRepo(q.full_name)));
    }

    if (pathname === '/api/github/repo' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, await ghCrearRepo({
        nombre: String(b.nombre || ''),
        descripcion: String(b.descripcion || ''),
        privado: b.privado !== false,
        scaffold: b.scaffold !== false,
        materia: b.materia ? String(b.materia) : null,
      }));
    }

    if (pathname === '/api/github/declaracion-ia') return json(res, await declaracionIA(q));

    // --- Ingesta de material de cátedra ------------------------------------
    if (pathname === '/api/ingerir' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, await ingerir({
        materia: String(b.materia || ''),
        unidad: String(b.unidad || ''),
        texto: String(b.texto || ''),
        fuente: String(b.fuente || ''),
        modelo: b.modelo ? String(b.modelo) : null,
      }));
    }

    if (pathname === '/api/calendario.ics') {
      const ics = buildICS(await allEvents());
      res.writeHead(200, {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'attachment; filename="facultad.ics"',
      });
      return res.end(ics);
    }

    // --- Estáticos --------------------------------------------------------
    if (pathname === '/' || pathname === '/index.html') return serveStatic(res, 'index.html');
    if (pathname.startsWith('/vendor/')) return serveStatic(res, pathname.slice(1));
    if (pathname.startsWith('/public/')) return serveStatic(res, pathname.slice(8));
    if (/^\/[\w.-]+\.(js|css|svg|json)$/.test(pathname)) return serveStatic(res, pathname.slice(1));

    // El resto son rutas del SPA.
    return serveStatic(res, 'index.html');
  } catch (err) {
    return json(res, { error: err.message }, 500);
  }
});

if (!fs.existsSync(VAULT)) {
  console.error(`\n  ✗ No encuentro el vault en:\n    ${VAULT}\n`);
  console.error('  Corré el server desde <vault>/00-Sistema/_hub/ o definí VAULT_DIR.\n');
  process.exit(1);
}

const HOST = process.env.HOST || '127.0.0.1';

server.listen(PORT, HOST, async () => {
  try {
    await almacen.iniciar();
  } catch (err) {
    console.error(`No pude inicializar el almacén (${almacen.modo}): ${err.message}`);
  }
  const idx = await buildIndex(true);
  console.log('');
  console.log('  ┌────────────────────────────────────────────┐');
  console.log('  │  Hub Facultad                              │');
  console.log('  └────────────────────────────────────────────┘');
  console.log('');
  console.log(`   Vault   ${VAULT}`);
  console.log(`   Notas   ${idx.notes.length}`);
  console.log(`   Abrí    http://localhost:${PORT}`);
  console.log('');
  console.log('   Ctrl+C para cortar.');
  console.log('');
});
