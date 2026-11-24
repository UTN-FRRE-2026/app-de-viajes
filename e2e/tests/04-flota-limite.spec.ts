import { expect, test, type Page } from '@playwright/test';
import { api, choferNuevo, entrar, entrarPorApi, exigir, prepararContexto, SEED, type Sesion } from './soporte';

// Flujo 4 (PLAN 5.3): el admin de flota activa choferes hasta el límite, y no ve los de otra flota.
// Usa la Flota Norte (admin.flota2), así no toca la Flota Demo de los otros flujos.

let admin: Sesion;
let norte: Sesion;
let flota: { id: string; nombre: string; maxActivos: number; activos: number };
let choferes: { id: string; patente: string }[] = [];

test.beforeEach(async ({ context }) => {
  await prepararContexto(context);
  [admin, norte] = await Promise.all([entrarPorApi(SEED.admin), entrarPorApi(SEED.flota2)]);
  flota = exigir(await api(norte, 'GET', '/viajes/flota'), 200, 'leer la flota');
  // Dos choferes nuevos, habilitados y sin activar; el límite, uno más de los activos de hoy.
  choferes = [await choferNuevo(norte, { habilitar: admin }), await choferNuevo(norte, { habilitar: admin })];
  exigir(
    await api(admin, 'PUT', `/viajes/admin/flotas/${norte.usuario.fleetId}`, { nombre: flota.nombre, maxActivos: flota.activos + 1 }),
    200,
    'ajustar el límite',
  );
});

test.afterEach(async () => {
  for (const c of choferes) await api(norte, 'POST', `/viajes/flota/choferes/${c.id}/desactivar`, {});
  await api(admin, 'PUT', `/viajes/admin/flotas/${norte.usuario.fleetId}`, { nombre: flota.nombre, maxActivos: flota.maxActivos });
});

/** La fila de un chofer por su patente; si la lista tiene varias páginas, va pidiendo más. */
async function fila(pagina: Page, patente: string) {
  const f = pagina.locator('li.chofer', { hasText: patente });
  for (let i = 0; i < 20 && (await f.count()) === 0; i++) {
    const mas = pagina.getByRole('button', { name: 'Ver más' });
    if ((await mas.count()) === 0) break;
    await mas.click();
    await pagina.waitForTimeout(300);
  }
  await expect(f).toBeVisible();
  return f;
}

test('activa hasta el límite; el siguiente no entra y lo dice', async ({ page }) => {
  await entrar(page, SEED.flota2);
  await expect(page).toHaveURL(/\/flota$/);
  await expect(page.getByRole('heading', { level: 1, name: flota.nombre })).toBeVisible();

  const primero = await fila(page, choferes[0]!.patente);
  await primero.getByRole('button', { name: 'Activar' }).click();
  await expect(primero.getByText('Activo', { exact: true })).toBeVisible();
  // Con la flota llena, el aviso del límite en el cupo.
  await expect(page.getByRole('status').filter({ hasText: 'llegó a su límite' })).toBeVisible();

  const segundo = await fila(page, choferes[1]!.patente);
  await segundo.getByRole('button', { name: 'Activar' }).click();
  await expect(segundo).toContainText('llegó a su límite');
  await expect(segundo.getByText('Inactivo', { exact: true })).toBeVisible();
});

test('no ve a los choferes de otra flota: ni en la lista ni por la API', async ({ page }) => {
  const choferDeOtraFlota = await entrarPorApi(SEED.chofer); // está en la Flota Demo
  await entrar(page, SEED.flota2);
  await expect(page.getByRole('heading', { level: 2, name: 'Choferes' })).toBeVisible();
  await expect(page.locator('li.chofer', { hasText: 'AB123CD' })).toHaveCount(0);
  // La autorización es de la API, no de la pantalla: pedirlo directo da 404, como si no existiera.
  const r = await api(norte, 'GET', `/viajes/flota/choferes/${choferDeOtraFlota.usuario.id}`);
  expect(r.estado).toBe(404);
});
