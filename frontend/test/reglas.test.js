import { describe, expect, it, vi } from 'vitest';
import {
  avisosDeNota,
  cargarIndice,
  cortesDeActividad,
  diffLineas,
  fechaRel,
  nivelActividad,
  splitFm,
} from '../public/reglas.js';

const AHORA = new Date('2026-10-19T15:00:00Z').getTime();

describe('fechaRel', () => {
  it.each([
    ['2026-10-19T14:30:00Z', 'hace minutos'],
    ['2026-10-19T12:00:00Z', 'hace 3 h'],
    ['2026-10-18T15:00:00Z', 'hace 1 día'],
    ['2026-10-16T15:00:00Z', 'hace 3 días'],
  ])('%s se lee como %s', (iso, texto) => {
    expect(fechaRel(iso, AHORA)).toBe(texto);
  });

  it('sin fecha no inventa una', () => {
    expect(fechaRel('', AHORA)).toBe('—');
    expect(fechaRel(null, AHORA)).toBe('—');
  });
});

describe('avisosDeNota', () => {
  const nota = (cuerpo, fm = 'tipo: concepto\nestado: borrador') =>
    `---\n${fm}\n---\n${cuerpo}`;

  it('marca el wikilink que no existe y se queda callado con el que sí', () => {
    const avisos = avisosDeNota(nota('Ver [[Isocuanta]] y [[Existe]].'), new Set(['Existe']));
    const rotos = avisos.find((a) => a.tipo === 'bad' && a.txt.includes('Wikilinks'));
    expect(rotos.txt).toContain('[[Isocuanta]]');
    expect(rotos.txt).not.toContain('[[Existe]]');
  });

  it('no cuenta el wikilink que está dentro de un bloque de código', () => {
    const avisos = avisosDeNota(nota('```\n[[Fantasma]]\n```'), new Set());
    expect(avisos.some((a) => a.txt.includes('Fantasma'))).toBe(false);
  });

  it('un estado fuera de la convención es un aviso, no un guardado bloqueado', () => {
    const avisos = avisosDeNota(nota('texto', 'tipo: clase\nestado: publicado'), new Set());
    expect(avisos.some((a) => a.txt.includes('publicado'))).toBe(true);
  });

  it('un concepto sin ## Conexiones avisa', () => {
    const avisos = avisosDeNota(nota('solo texto', 'tipo: concepto\nestado: pendiente'), new Set());
    expect(avisos.some((a) => a.txt.includes('Conexiones'))).toBe(true);
  });

  it('ASCII art es un error de convención', () => {
    const avisos = avisosDeNota(nota('+---+\n| a |\n+---+'), new Set());
    expect(avisos.some((a) => a.txt.includes('ASCII'))).toBe(true);
  });

  it('menos de tres conexiones no cumple la convención', () => {
    const cuerpo = '## Conexiones\n- [[Una]]\n- [[Dos]]';
    const avisos = avisosDeNota(nota(cuerpo), new Set(['Una', 'Dos']));
    expect(avisos.some((a) => a.txt.includes('2 enlaces'))).toBe(true);
  });
});

describe('splitFm', () => {
  it('un frente sin cierre no se parte: el cuerpo es el archivo entero', () => {
    const texto = '---\ntipo: concepto\nsin cierre';
    const r = splitFm(texto);
    expect(r.fm).toBe('');
    expect(r.body).toBe(texto);
  });
});

describe('diffLineas', () => {
  it('marca la línea que se fue y la que entró', () => {
    const d = diffLineas('a\nb\nc', 'a\nx\nc');
    expect(d.map((x) => x.t + x.l).join('|')).toBe('=a|-b|+x|=c');
  });
});

describe('nivelActividad', () => {
  it('el cero queda en el escalón vacío y el resto cae en su cuartil', () => {
    const cortes = cortesDeActividad([
      { n: 0 }, { n: 1 }, { n: 2 }, { n: 4 }, { n: 8 },
    ]);
    expect(nivelActividad(0, cortes)).toBe(0);
    expect(nivelActividad(1, cortes)).toBe(1);
    expect(nivelActividad(100, cortes)).toBe(4);
  });

  it('sin días activos los cortes no se dividen por cero', () => {
    expect(cortesDeActividad([])).toEqual([1, 1, 1]);
    expect(cortesDeActividad([{ n: 0 }])).toEqual([1, 1, 1]);
  });
});

describe('cargarIndice', () => {
  it('le pide /api/estado al cliente inyectado y no llama a la red', async () => {
    const cliente = vi.fn(async (ruta) => {
      expect(ruta).toBe('/api/estado');
      return { notas: [{ stem: 'A' }], materias: [{ id: 'eco' }] };
    });
    const data = await cargarIndice(cliente);
    expect(cliente).toHaveBeenCalledOnce();
    expect(data.notas).toHaveLength(1);
  });

  it('rechaza un índice sin materias', async () => {
    const cliente = vi.fn(async () => ({ notas: [] }));
    await expect(cargarIndice(cliente)).rejects.toMatchObject({ code: 'INDICE' });
  });
});
