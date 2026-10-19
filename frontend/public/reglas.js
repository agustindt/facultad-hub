/**
 * Reglas del cliente, sin DOM.
 *
 * El index las usa (avisos al guardar, fechas del panel de GitHub, el color
 * de la matriz, el arranque). Están acá para poder testearlas con vitest
 * sin levantar el navegador. Si una regla cambia, el test correspondiente
 * tiene que ponerse en rojo.
 */

export const ESTADOS_NOTA = ['pendiente', 'borrador', 'estudiado', 'dominado'];

export function splitFm(text) {
  if (!text.startsWith('---')) return { fm: '', body: text };
  const i = text.indexOf('\n---', 3);
  if (i === -1) return { fm: '', body: text };
  return { fm: text.slice(0, i + 4), body: text.slice(text.indexOf('\n', i + 1) + 1) };
}

export function stripCodeCliente(s) {
  return s.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

function bloque(body, titulo) {
  const re = new RegExp(`^##\\s*${titulo}\\s*$`, 'm');
  const m = re.exec(body);
  if (!m) return '';
  const rest = body.slice(m.index + m[0].length);
  const next = rest.search(/\n##\s/);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/** Chequeos deterministas que corren al guardar. No bloquean: avisan. */
export function avisosDeNota(texto, stems, estados = ESTADOS_NOTA) {
  const avisos = [];
  const { fm, body } = splitFm(texto);
  const conocidos = stems instanceof Set ? stems : new Set(stems || []);
  const rotos = [...new Set([...stripCodeCliente(body).matchAll(/\[\[([^\]|#\n]+)/g)]
    .map((m) => m[1].trim()).filter((t) => t && !conocidos.has(t)))];
  if (rotos.length) avisos.push({ tipo: 'bad', txt: `Wikilinks rotos: ${rotos.map((r) => '[[' + r + ']]').join(', ')}` });
  if (!fm) avisos.push({ tipo: 'warn', txt: 'La nota no tiene frontmatter.' });
  else {
    const est = (fm.match(/^estado:\s*(.+)$/m) || [])[1];
    if (est && !estados.includes(est.trim().toLowerCase()))
      avisos.push({ tipo: 'warn', txt: `El estado "${est.trim()}" no está en la convención (pendiente · borrador · estudiado · dominado).` });
    if (/^tipo:\s*concepto/m.test(fm) && !/^##\s*Conexiones/m.test(body))
      avisos.push({ tipo: 'warn', txt: 'Es un concepto y no tiene bloque ## Conexiones.' });
  }
  // El original usaba `\Z`, que en JavaScript no es el final del texto.
  // Conexiones, cuando era la última sección, no se llegaba a contar.
  const conex = bloque(body, 'Conexiones');
  if (conex) {
    const n = (conex.match(/\[\[/g) || []).length;
    if (n > 0 && n < 3) avisos.push({ tipo: 'warn', txt: `El bloque Conexiones tiene ${n} enlace${n === 1 ? '' : 's'}; la convención pide entre 3 y 6.` });
  }
  if (/[│├└─┌┐┘┴┬┤]|─→|\+---/.test(body))
    avisos.push({ tipo: 'bad', txt: 'Parece haber ASCII art. La convención pide Mermaid.' });
  return avisos;
}

export function diffLineas(a, b) {
  const A = a.split('\n');
  const B = b.split('\n');
  const n = A.length;
  const m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--)
      L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: '=', l: A[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ t: '-', l: A[i] }); i++; }
    else { out.push({ t: '+', l: B[j] }); j++; }
  }
  while (i < n) out.push({ t: '-', l: A[i++] });
  while (j < m) out.push({ t: '+', l: B[j++] });
  return out;
}

/** `ahora` se inyecta en los tests. En la página es Date.now(). */
export function fechaRel(iso, ahora = Date.now()) {
  if (!iso) return '—';
  const d = new Date(iso);
  const h = (ahora - d.getTime()) / 3600000;
  if (h < 1) return 'hace minutos';
  if (h < 24) return `hace ${Math.round(h)} h`;
  const dd = Math.round(h / 24);
  if (dd < 30) return `hace ${dd} día${dd === 1 ? '' : 's'}`;
  return d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
}

/** Cuartiles de los días con actividad. Un día en cero no mueve la escala. */
export function cortesDeActividad(dias) {
  const nz = (dias || []).filter((d) => d.n > 0).map((d) => d.n).sort((x, y) => x - y);
  const q = (p) => (nz.length ? nz[Math.min(nz.length - 1, Math.floor(nz.length * p))] : 1);
  return [q(0.25), q(0.5), q(0.75)];
}

export function nivelActividad(n, cortes) {
  if (n === 0) return 0;
  if (n <= cortes[0]) return 1;
  if (n <= cortes[1]) return 2;
  if (n <= cortes[2]) return 3;
  return 4;
}

/**
 * El arranque pide el índice. `cliente` es `api` en la página y un doble
 * en el test: esta función no sabe de fetch.
 */
export async function cargarIndice(cliente) {
  const data = await cliente('/api/estado');
  if (!data || !Array.isArray(data.notas) || !Array.isArray(data.materias)) {
    const err = new Error('El índice no trae notas y materias');
    err.code = 'INDICE';
    throw err;
  }
  return data;
}
