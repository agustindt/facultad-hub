import { expect, test } from '@playwright/test';

const API = process.env.API_BASE_URL || 'http://localhost:8080';

async function estado(request) {
  const r = await request.get(`${API}/api/estado`);
  expect(r.status()).toBe(200);
  return r.json();
}

test('el alta de un evento queda en la base, y el borrado lo saca', async ({ request }) => {
  const titulo = `api ${Date.now()}`;
  const alta = await request.post(`${API}/api/eventos`, {
    data: { fecha: '2026-11-02', titulo, tipo: 'hito' },
  });
  expect(alta.status()).toBe(200);
  const { evento } = await alta.json();

  const lista = await estado(request);
  expect(lista.eventos.some((e) => e.titulo === titulo)).toBe(true);

  const borrado = await request.delete(`${API}/api/eventos`, { data: { id: evento.id } });
  expect(borrado.status()).toBe(200);

  const despues = await estado(request);
  expect(despues.eventos.some((e) => e.titulo === titulo)).toBe(false);
});

test('un título vacío lo rechaza la api, y no crea nada', async ({ request }) => {
  const antes = await estado(request);

  const alta = await request.post(`${API}/api/eventos`, {
    data: { fecha: '2026-11-02', titulo: '   ' },
  });
  expect(alta.status()).toBe(400);

  const despues = await estado(request);
  expect(despues.eventos.length).toBe(antes.eventos.length);
});

test('una nota creada aparece en el índice, y borrarla la saca', async ({ request }) => {
  const titulo = `nota ${Date.now()}`;
  const rel = `e2e/${titulo}.md`;
  const contenido = `---\ntipo: concepto\nmateria: e2e\nestado: pendiente\n---\n\n# ${titulo}\n`;

  const alta = await request.post(`${API}/api/nota`, { data: { rel, contenido } });
  expect(alta.status()).toBe(200);

  const lista = await estado(request);
  expect(lista.notas.some((n) => n.titulo === titulo && n.rel === rel)).toBe(true);

  const borrado = await request.delete(`${API}/api/nota`, { data: { rel } });
  expect(borrado.status()).toBe(200);

  const despues = await estado(request);
  expect(despues.notas.some((n) => n.rel === rel)).toBe(false);
});
