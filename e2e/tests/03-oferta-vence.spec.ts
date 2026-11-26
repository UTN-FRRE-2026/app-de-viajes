import { expect, test } from '@playwright/test';
import {
  api,
  CERCA_DE_LA_PLAZA,
  choferNuevo,
  entrar,
  entrarPorApi,
  exigir,
  noDisponible,
  prepararContexto,
  SEED,
  sinViajeActivo,
  UN_POCO_MAS_LEJOS,
  type Sesion,
} from './soporte';

// Flujo 3 (PLAN 5.3): una oferta que vence pasa al siguiente chofer. Necesita el sistema levantado con
// `npm run e2e:levantar` (OFERTAS_SIMULTANEAS=1, OFERTA_TTL_SEGUNDOS=6): con varias ofertas a la vez, los
// dos choferes la recibirían juntos.

const PLAZA = { lat: -27.4511, lng: -58.9865 };
const DOMO = { lat: -27.4369, lng: -58.9808 };

let segundo: { id: string; email: string };
let adminFlota: Sesion;

test.beforeEach(async () => {
  const [pasajero, operador, chofer, admin] = await Promise.all([
    entrarPorApi(SEED.pasajero),
    entrarPorApi(SEED.operador),
    entrarPorApi(SEED.chofer),
    entrarPorApi(SEED.admin),
  ]);
  adminFlota = await entrarPorApi(SEED.flota);
  await sinViajeActivo(pasajero, operador);
  await noDisponible(chofer);
  // Un segundo chofer en la misma flota, habilitado y activo.
  segundo = await choferNuevo(adminFlota, { habilitar: admin, activar: true });
});

test.afterEach(async () => {
  const [pasajero, operador, chofer] = await Promise.all([entrarPorApi(SEED.pasajero), entrarPorApi(SEED.operador), entrarPorApi(SEED.chofer)]);
  await sinViajeActivo(pasajero, operador);
  await noDisponible(chofer);
  // Libera el cupo de la flota: si no, las corridas locales la llenarían.
  if (segundo) await api(adminFlota, 'POST', `/viajes/flota/choferes/${segundo.id}/desactivar`, {});
});

test('el primer chofer deja vencer la oferta y el viaje se le ofrece al siguiente', async ({ browser }) => {
  // El chofer del seed está más cerca del origen: la oferta es primero para él.
  const ctxCerca = await browser.newContext({ geolocation: CERCA_DE_LA_PLAZA, permissions: ['geolocation'] });
  const ctxLejos = await browser.newContext({ geolocation: UN_POCO_MAS_LEJOS, permissions: ['geolocation'] });
  for (const c of [ctxCerca, ctxLejos]) await prepararContexto(c);
  const cerca = await ctxCerca.newPage();
  const lejos = await ctxLejos.newPage();

  for (const [pagina, email] of [
    [cerca, SEED.chofer],
    [lejos, segundo.email],
  ] as const) {
    await entrar(pagina, email);
    // Con el GPS del contexto: la «Simulada» por defecto los pondría a los dos en el mismo punto.
    await pagina.getByRole('radio', { name: 'GPS' }).check();
    await pagina.getByRole('button', { name: 'Ponerme disponible' }).click();
    await expect(pagina.getByText(/Enviando cada 5 s/)).toBeVisible();
  }

  // El pedido va por la API: la pantalla del pasajero ya se prueba en el flujo 2.
  const pasajero = await entrarPorApi(SEED.pasajero);
  const viaje = exigir(await api(pasajero, 'POST', '/viajes/solicitudes', { origen: PLAZA, destino: DOMO }), 201, 'pedir');

  // Primero le llega al más cercano, y solo a él. Que al otro no le llegó se comprueba en la base
  // (`GET /chofer/estado`), no en su pantalla: ahí una oferta podría estar todavía en camino por el SSE.
  await expect(cerca.locator('.oferta')).toHaveCount(1);
  await expect(cerca.getByText(/Vence en \d+ s/)).toBeVisible();
  const delSegundo = exigir(await api(await entrarPorApi(segundo.email), 'GET', '/viajes/chofer/estado'), 200, 'estado del segundo chofer');
  expect(delSegundo.ofertas).toEqual([]);

  // No la acepta: vence, se le va de la pantalla y el viaje pasa al otro chofer. No se espera la etiqueta
  // «Venció»: si el OfferExpired llega por SSE antes del siguiente tic de la cuenta regresiva, la oferta
  // sale de la lista sin llegar a mostrarla.
  await expect(cerca.locator('.oferta')).toHaveCount(0, { timeout: 15_000 });
  await expect(lejos.getByRole('button', { name: 'Aceptar' })).toBeVisible({ timeout: 15_000 });
  await lejos.getByRole('button', { name: 'Aceptar' }).click();
  await expect(lejos.getByRole('button', { name: 'Voy en camino' })).toBeVisible();
  // Y al primero ya no le queda nada que aceptar.
  await expect(cerca.locator('.oferta')).toHaveCount(0);

  const final = exigir(await api(pasajero, 'GET', `/viajes/solicitudes/${viaje.id}`), 200, 'leer el viaje');
  expect(final).toMatchObject({ estado: 'ASIGNADO', choferId: segundo.id });
  await ctxCerca.close();
  await ctxLejos.close();
});
