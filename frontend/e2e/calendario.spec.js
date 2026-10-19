import { expect, test } from '@playwright/test';

function hoyISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function abrirFormulario(page) {
  await page.goto('/#/calendario');
  await page.getByRole('button', { name: '+ Evento' }).click();
}

async function borrar(page, titulo) {
  page.once('dialog', (d) => d.accept());
  await page.locator('.ev', { hasText: titulo }).click();
}

test('crear un evento lo muestra, y borrarlo lo saca', async ({ page }) => {
  const titulo = `e2e ${Date.now()}`;
  await abrirFormulario(page);
  await page.locator('input[type=date]').fill(hoyISO());
  await page.getByPlaceholder('Qué pasa ese día').fill(titulo);
  await page.getByRole('button', { name: 'Agregar' }).click();
  await expect(page.locator('.ev', { hasText: titulo })).toBeVisible();
  await borrar(page, titulo);
  await expect(page.locator('.ev', { hasText: titulo })).toHaveCount(0);
});

test('un título vacío muestra el error y no crea nada', async ({ page }) => {
  await page.goto('/#/calendario');
  const antes = await page.locator('.ev').count();
  await page.getByRole('button', { name: '+ Evento' }).click();
  await page.getByRole('button', { name: 'Agregar' }).click();
  await expect(page.getByRole('alert')).toHaveText('Falta el título.');
  await expect(page.locator('.ev')).toHaveCount(antes);
});

test('el evento sigue en el calendario después de recargar', async ({ page }) => {
  const titulo = `e2e recarga ${Date.now()}`;
  await abrirFormulario(page);
  await page.locator('input[type=date]').fill(hoyISO());
  await page.getByPlaceholder('Qué pasa ese día').fill(titulo);
  await page.getByRole('button', { name: 'Agregar' }).click();
  await expect(page.locator('.ev', { hasText: titulo })).toBeVisible();

  await page.reload();
  await page.goto('/#/calendario');
  await expect(page.locator('.ev', { hasText: titulo })).toBeVisible();

  await borrar(page, titulo);
  await expect(page.locator('.ev', { hasText: titulo })).toHaveCount(0);
});
