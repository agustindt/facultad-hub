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

const HUB_DIR = __dirname;
// Por defecto el hub vive en <vault>/00-Sistema/_hub/ → el vault está dos arriba.
const VAULT = path.resolve(process.env.VAULT_DIR || path.join(HUB_DIR, '..', '..'));
const PORT = Number(process.env.PORT || 4177);
const HUB_DATA = path.join(HUB_DIR, 'datos');
const EVENTS_FILE = path.join(HUB_DATA, 'eventos.json');
const MATERIAS_FILE = path.join(HUB_DATA, 'materias.json');
const CONFIG_FILE = path.join(HUB_DATA, 'config.json');
const IA_LOG = path.join(HUB_DATA, 'ia-log.json');
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
  for (const s of subs) await fsp.mkdir(path.join(dir, s), { recursive: true });

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

async function readUserEvents() {
  try {
    return JSON.parse(await fsp.readFile(EVENTS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

async function writeUserEvents(list) {
  await fsp.mkdir(HUB_DATA, { recursive: true });
  await fsp.writeFile(EVENTS_FILE, JSON.stringify(list, null, 2), 'utf8');
}

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

async function ordenarNota({ rel, contenido }) {
  const cfg = await readConfig();
  if (!cfg.apiKey) throw new Error('Falta configurar la clave de API en Ajustes');
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
  const resp = await anthropic(cfg.apiKey, '/v1/messages', 'POST', {
    model: modelo,
    max_tokens: 8000,
    system: SISTEMA_ORDENAR,
    messages: [{ role: 'user', content: usuario }],
  });

  const texto = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try {
    parsed = JSON.parse(texto);
  } catch {
    const m = texto.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('El modelo no devolvió JSON reconocible');
    parsed = JSON.parse(m[0]);
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
    modelo,
    tokens_entrada: resp.usage?.input_tokens ?? null,
    tokens_salida: resp.usage?.output_tokens ?? null,
    ms: Date.now() - t0,
  };
  let log = [];
  try {
    log = JSON.parse(await fsp.readFile(IA_LOG, 'utf8'));
  } catch {}
  log.push(uso);
  await fsp.mkdir(HUB_DATA, { recursive: true });
  await fsp.writeFile(IA_LOG, JSON.stringify(log, null, 2), 'utf8');

  return {
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

const REPASO_FILE = path.join(HUB_DATA, 'repaso.json');
const EASE_INI = 2.5;
const EASE_MIN = 1.3;
const EASE_MAX = 2.8;
const NUEVAS_TOPE = 12;
const NUEVAS_PISO = 3;

async function readRepaso() {
  try {
    return JSON.parse(await fsp.readFile(REPASO_FILE, 'utf8'));
  } catch {
    return {};
  }
}
async function writeRepaso(st) {
  await fsp.mkdir(HUB_DATA, { recursive: true });
  await fsp.writeFile(REPASO_FILE, JSON.stringify(st, null, 2), 'utf8');
}

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

async function ingerir({ materia, unidad, texto, fuente, modelo: modeloPedido }) {
  const cfg = await readConfig();
  if (!cfg.apiKey) throw new Error('Falta configurar la clave de API en Ajustes');
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
  const resp = await anthropic(cfg.apiKey, '/v1/messages', 'POST', {
    model: modelo,
    max_tokens: 16000,
    system: SISTEMA_INGERIR,
    messages: [{ role: 'user', content: usuario }],
  });

  const salida = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try {
    parsed = JSON.parse(salida);
  } catch {
    const m = salida.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('El modelo no devolvió JSON reconocible');
    parsed = JSON.parse(m[0]);
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
    modelo,
    tokens_entrada: resp.usage?.input_tokens ?? null,
    tokens_salida: resp.usage?.output_tokens ?? null,
    ms: Date.now() - t0,
  };
  let log = [];
  try {
    log = JSON.parse(await fsp.readFile(IA_LOG, 'utf8'));
  } catch {}
  log.push(uso);
  await fsp.mkdir(HUB_DATA, { recursive: true });
  await fsp.writeFile(IA_LOG, JSON.stringify(log, null, 2), 'utf8');

  return {
    propuestas,
    resumen: parsed.resumen || '',
    descartados: Array.isArray(parsed.descartados) ? parsed.descartados : [],
    recortado,
    caracteres: crudo.length,
    uso,
  };
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
  const file = path.join(HUB_DIR, 'public', name);
  if (!file.startsWith(path.join(HUB_DIR, 'public'))) return json(res, { error: 'no' }, 400);
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
      let log = [];
      try {
        log = JSON.parse(await fsp.readFile(IA_LOG, 'utf8'));
      } catch {}
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
      return json(res, await ordenarNota({ rel: String(b.rel || ''), contenido: String(b.contenido) }));
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

server.listen(PORT, '127.0.0.1', async () => {
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
