'use strict';
/**
 * Reglas de negocio del hub, sin red ni disco.
 *
 * Vivían dentro de server.js. Salieron de ahí porque un test no puede
 * importar el servidor: al cargarlo, escucha un puerto. Acá está lo que
 * cambia el comportamiento que ve el estudiante — el calendario, el repaso
 * y si un tema del programa está escrito. El HTTP se queda en server.js.
 */

const ESTADOS_CANON = ['pendiente', 'borrador', 'estudiado', 'dominado'];
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

const WIKILINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

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

function normalizar(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function toISO(d, m, y) {
  const yy = y.length === 2 ? `20${y}` : y;
  return `${yy}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/**
 * El orden importa: "recuperatorio del parcial" es un recuperatorio.
 * Si el examen se evaluara antes, esa fecha se pintaría como parcial.
 */
function classifyEvento(texto) {
  const t = texto.toLowerCase();
  if (/recuperatorio/.test(t)) return 'recuperatorio';
  if (/parcial|examen|final/.test(t)) return 'examen';
  if (/defensa/.test(t)) return 'defensa';
  if (/entrega|deadline|informe/.test(t)) return 'entrega';
  if (/feriado/.test(t)) return 'feriado';
  return 'hito';
}

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
  'de', 'del', 'la', 'el', 'los', 'las', 'y', 'o', 'en', 'a', 'al', 'un', 'una', 'unos', 'unas', 'para', 'por', 'con',
  'su', 'sus', 'se', 'que', 'como', 'sobre', 'entre', 'sin', 'ni', 'lo', 'es', 'son', 'ser', 'the', 'of', 'and', 'to',
  'segun', 'ante', 'tras', 'mas', 'pero', 'cada', 'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas',
]);

function tokens(s) {
  return normalizar(s)
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

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

const EASE_INI = 2.5;
const EASE_MIN = 1.3;
const EASE_MAX = 2.8;

/**
 * SM-2 recortado. `tope` es el margen en días hasta el parcial: un intervalo
 * nunca puede saltar por encima de la fecha del examen.
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

function evaluarTema(tema, notasMateria, notaManual, byStem) {
  if (notaManual) {
    const hit = (byStem.get(notaManual) || [])[0];
    if (hit) return { estado: 'nota', rel: hit.rel, titulo: hit.title, score: 1, via: 'manual' };
    return { estado: 'falta', via: 'manual-roto', manual: notaManual };
  }
  const t = [...raices(tema)];
  if (!t.length) return { estado: 'indeterminado' };
  const temaNorm = normalizar(tema);

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

  const otras = (elegida) => top.filter((c) => c.rel !== elegida);
  if (cands[0] && cands[0].score >= 0.6)
    return { estado: 'nota', rel: cands[0].rel, titulo: cands[0].titulo, score: Number(cands[0].score.toFixed(2)), via: 'titulo', candidatos: otras(cands[0].rel) };
  if (mejorCuerpo && mejorCuerpo.score >= 0.8)
    return { estado: 'mencionado', rel: mejorCuerpo.rel, titulo: mejorCuerpo.titulo, score: Number(mejorCuerpo.score.toFixed(2)), via: 'cuerpo', candidatos: otras(mejorCuerpo.rel) };
  return { estado: 'falta', candidatos: top };
}

/**
 * Cuántas tarjetas nuevas por día hacen falta para verlas todas antes del
 * parcial. `dias` es el margen que queda; cero o negativo no es un plan.
 */
function nuevasPorDia(sinVer, dias) {
  if (!Number.isInteger(dias) || dias < 1) {
    const err = new Error('dias tiene que ser un entero mayor a cero');
    err.code = 'DIAS';
    throw err;
  }
  if (!Number.isInteger(sinVer) || sinVer < 0) {
    const err = new Error('sinVer tiene que ser un entero mayor o igual a cero');
    err.code = 'SIN_VER';
    throw err;
  }
  if (sinVer === 0) return 0;
  return Math.ceil(sinVer / dias);
}

/**
 * ¿El ritmo diario alcanza para ver lo que falta antes del corte?
 * `topeDiario` es el máximo que el estudiante dijo que puede hacer.
 * No es lo mismo que `nuevasPorDia`: esa dice cuántas tocan por día,
 * esta dice si ese número entra en el tope y cuántas quedan afuera.
 */
function alcanzaElRitmo(sinVer, dias, topeDiario) {
  if (!Number.isInteger(dias) || dias < 1) {
    const err = new Error('dias tiene que ser un entero mayor a cero');
    err.code = 'DIAS';
    throw err;
  }
  if (!Number.isInteger(sinVer) || sinVer < 0) {
    const err = new Error('sinVer tiene que ser un entero mayor o igual a cero');
    err.code = 'SIN_VER';
    throw err;
  }
  if (!Number.isInteger(topeDiario) || topeDiario < 1) {
    const err = new Error('topeDiario tiene que ser un entero mayor a cero');
    err.code = 'TOPE';
    throw err;
  }
  if (sinVer === 0) {
    return { alcanza: true, porDia: 0, faltan: 0, sobra: topeDiario * dias };
  }
  const porDia = Math.ceil(sinVer / dias);
  const capacidad = topeDiario * dias;
  const alcanza = porDia <= topeDiario;
  return {
    alcanza,
    porDia,
    faltan: alcanza ? 0 : sinVer - capacidad,
    sobra: alcanza ? capacidad - sinVer : 0,
  };
}

module.exports = {
  ESTADOS_CANON,
  ESTADO_ALIAS,
  parseFrontmatter,
  serializeFrontmatter,
  extractLinks,
  normalizeEstado,
  normalizar,
  toISO,
  classifyEvento,
  ymd,
  hoyISO,
  sumarDias,
  diasEntre,
  secciones,
  resumenNota,
  raices,
  programar,
  parsearPrograma,
  evaluarTema,
  nuevasPorDia,
  alcanzaElRitmo,
};
