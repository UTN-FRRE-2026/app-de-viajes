import { expect, test } from '@playwright/test';
import { BASE, entrar, prepararContexto, SEED, unico } from './soporte';

// Flujo 5 (PLAN 5.3): manejo de errores. Un formulario inválido no sale de la pantalla y dice qué está
// mal; una sesión que terminó lleva al login.

test.beforeEach(async ({ context }) => {
  await prepararContexto(context);
});

test('login con credenciales incorrectas: lo dice y no entra', async ({ page }) => {
  // Un email que no existe: no suma intentos fallidos a los usuarios del seed (límite por email).
  await page.goto('/login');
  await page.getByLabel('Email').fill(`nadie-${unico()}@viajes.test`);
  await page.getByLabel('Contraseña').fill('no-es-la-contraseña');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('alert')).toHaveText('Email o contraseña incorrectos.');
  await expect(page).toHaveURL(/\/login/);
});

test('alta de chofer con datos inválidos: marca cada campo y no manda nada', async ({ page }) => {
  await entrar(page, SEED.flota);
  const altas: string[] = [];
  page.on('request', (r) => r.method() === 'POST' && r.url().includes('/flota/choferes') && altas.push(r.url()));

  await page.locator('input[name=choferId]').fill('no-es-un-codigo');
  await page.locator('input[name=patente]').fill('12');
  await page.getByRole('button', { name: /dar de alta/i }).click();

  await expect(page.locator('input[name=choferId]')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('input[name=patente]')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Patente inválida: ABC123 o AB123CD.')).toBeVisible();
  expect(altas).toEqual([]);
});

test('pedir un viaje sin origen ni destino no se puede', async ({ page }) => {
  await entrar(page, SEED.pasajero);
  await expect(page.getByText('Elegí el origen y el destino para ver cuánto sale.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pedir viaje' })).toBeDisabled();
});

test('sesión terminada: al recargar, lleva al login', async ({ page }) => {
  await entrar(page, SEED.pasajero);
  // La sesión se cierra desde otro lado (otro dispositivo, o vence el refresh): identity revoca el
  // refresh que guardó esta pestaña.
  const guardado = await page.evaluate(() => sessionStorage.getItem('viajes:sesion'));
  const refreshToken = JSON.parse(guardado ?? '{}')?.state?.refreshToken as string | undefined;
  expect(refreshToken).toBeTruthy();
  const r = await fetch(`${BASE}/api/identity/logout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  expect(r.ok).toBe(true);

  await page.reload();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible();
});
