import { expect, test } from '@playwright/test';
import { CERCA_DE_LA_PLAZA, entrar, entrarPorApi, noDisponible, prepararContexto, SEED, sinViajeActivo, vigilarCsp } from './soporte';

// Flujo 2 (PLAN 5.3): un viaje completo con dos navegadores, pasajero y chofer. Del lado del pasajero,
// cada paso de la línea de tiempo se prende en vivo (SSE), sin recargar.

test.beforeEach(async () => {
  const [pasajero, operador, chofer] = await Promise.all([entrarPorApi(SEED.pasajero), entrarPorApi(SEED.operador), entrarPorApi(SEED.chofer)]);
  await sinViajeActivo(pasajero, operador);
  await noDisponible(chofer);
});

test.afterEach(async () => {
  await noDisponible(await entrarPorApi(SEED.chofer));
});

test('el pasajero pide, el chofer acepta y lo lleva; el pasajero lo ve en vivo hasta el final', async ({ browser }) => {
  const ctxPasajero = await browser.newContext();
  // El chofer comparte su GPS: el navegador le da una posición cerca de la Plaza 25 de Mayo.
  const ctxChofer = await browser.newContext({ geolocation: CERCA_DE_LA_PLAZA, permissions: ['geolocation'] });
  await prepararContexto(ctxPasajero);
  await prepararContexto(ctxChofer);
  const pasajero = await ctxPasajero.newPage();
  const chofer = await ctxChofer.newPage();
  const csp = [pasajero, chofer].map(vigilarCsp);

  // El chofer se pone disponible y empieza a mandar su posición.
  await entrar(chofer, SEED.chofer);
  await chofer.getByRole('button', { name: 'Ponerme disponible' }).click();
  await expect(chofer.getByText('Disponible', { exact: true })).toBeVisible();
  await expect(chofer.getByText(/Enviando cada 5 s/)).toBeVisible();

  // El pasajero elige origen y destino, ve la estimación y pide.
  await entrar(pasajero, SEED.pasajero);
  await expect(pasajero.getByRole('button', { name: 'Pedir viaje' })).toBeDisabled();
  await pasajero.getByLabel('Origen', { exact: true }).selectOption('plaza-25-de-mayo');
  await pasajero.getByLabel('Destino', { exact: true }).selectOption('domo-del-centenario');
  await expect(pasajero.locator('.columna-detalle .monto')).toContainText('$');
  await pasajero.getByRole('button', { name: 'Pedir viaje' }).click();
  const actual = pasajero.locator('.linea-tiempo .paso.actual');
  await expect(actual).toContainText('Pedido');

  // El chofer recibe la oferta y la acepta: el pasajero lo ve sin recargar.
  await chofer.getByRole('button', { name: 'Aceptar' }).click();
  await expect(actual).toContainText('Chofer asignado');
  await expect(pasajero.getByRole('heading', { name: 'Tu chofer' })).toBeVisible();
  // Y la posición del chofer en vivo, con la distancia al origen.
  await expect(pasajero.locator('.columna-detalle .distancia')).toBeVisible();

  for (const [boton, paso] of [
    ['Voy en camino', 'En camino a buscarte'],
    ['Inició el viaje', 'En viaje'],
  ] as const) {
    await chofer.getByRole('button', { name: boton }).click();
    await expect(actual).toContainText(paso);
  }
  // Ya en viaje, el pasajero no puede cancelar.
  await expect(pasajero.getByRole('button', { name: 'Cancelar viaje' })).toHaveCount(0);

  await chofer.getByRole('button', { name: 'Finalizar' }).click();
  await expect(chofer.getByRole('heading', { name: 'Viaje terminado' })).toBeVisible();
  await expect(pasajero.locator('.linea-tiempo .paso.hecho', { hasText: 'Terminado' })).toBeVisible();
  await expect(pasajero.getByText('Tarifa final')).toBeVisible();

  expect(csp.flat()).toEqual([]);
  await ctxPasajero.close();
  await ctxChofer.close();
});
