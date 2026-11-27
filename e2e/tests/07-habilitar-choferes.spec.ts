import { expect, test } from '@playwright/test';
import { api, choferNuevo, CONTRASENA, entrar, entrarPorApi, exigir, prepararContexto, SEED, unico, vigilarCsp, type Sesion } from './soporte';

// Flujo 7: el admin de la plataforma habilita, en pantalla, a un chofer que su flota dio de alta; su
// flota ya lo puede activar. El operador no ve esa pantalla. Usa la Flota Corrientes (admin.flota2),
// así no toca la Flota Demo de los otros flujos; los choferes quedan inactivos, sin ocupar cupo.

let admin: Sesion;
let norte: Sesion;

test.beforeEach(async ({ context }) => {
  await prepararContexto(context);
  [admin, norte] = await Promise.all([entrarPorApi(SEED.admin), entrarPorApi(SEED.flota2)]);
});

test('habilita con el código y su flota ya lo puede activar; después lo deshabilita', async ({ page, browser }) => {
  const chofer = await choferNuevo(norte); // dado de alta, sin habilitar
  const csp = vigilarCsp(page);

  await entrar(page, SEED.admin);
  await page.getByRole('link', { name: 'Choferes' }).click();
  await expect(page).toHaveURL(/\/operador\/choferes$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Habilitar choferes' })).toBeVisible();

  await page.getByLabel('Código del chofer').fill(` ${chofer.id.toUpperCase()} `);
  await page.getByRole('button', { name: 'Habilitar', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(`Habilitado: Fiat Cronos (${chofer.patente})`);
  const fila = page.locator('li.chofer', { hasText: chofer.patente });
  await expect(fila.getByText('Habilitado', { exact: true })).toBeVisible();
  await expect(fila.getByText('Inactivo', { exact: true })).toBeVisible();

  // En /flota, su admin ya tiene «Activar» disponible (no lo toca: no ocupa cupo).
  const ctxFlota = await browser.newContext();
  await prepararContexto(ctxFlota);
  const flota = await ctxFlota.newPage();
  await entrar(flota, SEED.flota2);
  const filaFlota = flota.locator('li.chofer', { hasText: chofer.patente });
  for (let i = 0; i < 20 && (await filaFlota.count()) === 0; i++) {
    const mas = flota.getByRole('button', { name: 'Ver más' });
    if ((await mas.count()) === 0) break;
    await mas.click();
    await flota.waitForTimeout(300);
  }
  await expect(filaFlota.getByText('Habilitado', { exact: true })).toBeVisible();
  await expect(filaFlota.getByRole('button', { name: 'Activar' })).toBeEnabled();
  await ctxFlota.close();

  // Deshabilitar desde la fila: vuelve a «Sin habilitar», también para la API.
  await fila.getByRole('button', { name: 'Deshabilitar' }).click();
  await expect(fila.getByText('Sin habilitar', { exact: true })).toBeVisible();
  const leido = exigir(await api(norte, 'GET', `/viajes/flota/choferes/${chofer.id}`), 200, 'leer el chofer');
  expect(leido.habilitado).toBe(false);
  expect(csp).toEqual([]);
});

test('un chofer que todavía no está en ninguna flota: lo dice y no cambia nada', async ({ page }) => {
  const email = `e2e-chofer-${unico()}@viajes.test`;
  const registro = exigir(await api(null, 'POST', '/identity/registro', { email, contrasena: CONTRASENA, nombre: 'Chofer E2E', rol: 'chofer' }), 201, 'registro');
  const id: string = registro.id ?? registro.usuario?.id;

  await entrar(page, SEED.admin);
  await page.goto('/operador/choferes');
  await page.getByLabel('Código del chofer').fill(id);
  await page.getByRole('button', { name: 'Habilitar', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('no está en ninguna flota');
  await expect(page.locator('li.chofer')).toHaveCount(0);
  // Sigue sin flota: el admin de la plataforma no lo creó.
  expect((await api(admin, 'POST', `/viajes/admin/choferes/${id}/habilitar`, {})).estado).toBe(404);
});

test('el operador no ve la habilitación: ni en el menú ni por la URL', async ({ page }) => {
  await entrar(page, SEED.operador);
  await expect(page.getByRole('link', { name: 'Panel' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Choferes' })).toHaveCount(0);
  await page.goto('/operador/choferes');
  await expect(page.getByRole('alert')).toContainText('Esta pantalla no es para tu rol');
});
