import { expect, test } from '@playwright/test';
import { entrar, prepararContexto, SEED, vigilarCsp } from './soporte';

// Flujo 1 (PLAN 5.3): login por rol, cada uno a su inicio; una pantalla de otro rol, vedada. De paso,
// la página carga sin violaciones de la CSP de nginx (B5).

const ROLES = [
  { email: SEED.pasajero, inicio: '/pasajero', titulo: 'Pedir un viaje' },
  { email: SEED.chofer, inicio: '/chofer', titulo: 'Chofer' },
  { email: SEED.operador, inicio: '/operador', titulo: 'Viajes' },
  { email: SEED.admin, inicio: '/operador', titulo: 'Viajes' },
  { email: SEED.flota, inicio: '/flota', titulo: 'Flota Demo' },
] as const;

test.beforeEach(async ({ context }) => {
  await prepararContexto(context);
});

for (const rol of ROLES) {
  test(`${rol.email} entra a ${rol.inicio}, sin violaciones de CSP`, async ({ page }) => {
    const csp = vigilarCsp(page);
    await entrar(page, rol.email);
    await expect(page).toHaveURL(new RegExp(`${rol.inicio}$`));
    await expect(page.getByRole('heading', { level: 1, name: rol.titulo })).toBeVisible();
    expect(csp).toEqual([]);
  });
}

test('sin sesión, una pantalla protegida lleva al login', async ({ page }) => {
  await page.goto('/pasajero');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible();
});

test('la pantalla de otro rol está vedada: el pasajero no ve la del operador', async ({ page }) => {
  await entrar(page, SEED.pasajero);
  await page.goto('/operador');
  await expect(page.getByRole('alert')).toContainText('Esta pantalla no es para tu rol');
  // Y la tabla del operador no se llega a pedir: no hay nada de su panel.
  await expect(page.getByRole('heading', { name: 'Viajes' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Ir a tu inicio' }).click();
  await expect(page).toHaveURL(/\/pasajero$/);
});
