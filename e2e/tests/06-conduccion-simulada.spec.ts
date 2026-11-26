import { expect, test, type Page, type Route } from '@playwright/test';
import { api, entrar, entrarPorApi, exigir, noDisponible, prepararContexto, SEED, sinViajeActivo, vigilarCsp } from './soporte';

// Flujo 6: la conducción simulada del chofer («Simulada (demo)», su modo por defecto). El auto va solo
// a buscar al pasajero por la ruta, frena al llegar, arranca cuando el chofer toca «Inició el viaje» y
// finaliza solo en el destino; las dos pantallas lo ven moverse a la vez.
//
// La ruta la responde el test (una L corta, sin OSRM ni dispatch) y la velocidad es la de siempre
// (40 km/h): lo que se acorta es el recorrido, unos 140 m hasta el origen y 230 m hasta el destino.

/** Donde queda el auto simulado sin una posición guardada (`PARTIDA_SIMULADA`, la de `simular-chofer.mjs`). */
const PARTIDA = { lat: -27.462, lng: -58.996 };
/** A unos 140 m de la partida por la L (90 m al norte y 50 m al este), en la zona «Resistencia». */
const ORIGEN = { lat: -27.4612, lng: -58.9955 };
/** A unos 230 m del origen por la L. */
const DESTINO = { lat: -27.46, lng: -58.9945 };

function metros(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (g: number) => (g * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** `GET /api/viajes/rutas` de prueba: una L (primero norte-sur, después este-oeste) entre los dos puntos. */
async function rutaEnL(ruta: Route): Promise<void> {
  const q = new URL(ruta.request().url()).searchParams;
  const a = { lat: Number(q.get('origenLat')), lng: Number(q.get('origenLng')) };
  const b = { lat: Number(q.get('destinoLat')), lng: Number(q.get('destinoLng')) };
  const esquina = { lat: b.lat, lng: a.lng };
  const largo = metros(a, esquina) + metros(esquina, b);
  await ruta.fulfill({
    json: {
      distanciaMetros: Math.round(largo),
      duracionSegundos: Math.round(largo / (40 / 3.6)),
      puntos: [
        [a.lat, a.lng],
        [esquina.lat, esquina.lng],
        [b.lat, b.lng],
      ],
      fuente: 'calles',
    },
  });
}

/** Una posición enviada es el origen (el auto simulado frena justo en el punto; 1e-7° son ~1 cm). */
const enOrigen = (p: { lat: number; lng: number }) => Math.abs(p.lat - ORIGEN.lat) < 1e-7 && Math.abs(p.lng - ORIGEN.lng) < 1e-7;

/** Dónde dibuja Leaflet el auto ahora (su `transform`). */
const autoEnPantalla = (p: Page) => p.locator('.mapa-auto').evaluate((el) => (el as HTMLElement).style.transform);

/** Junta dónde está el auto durante unos segundos: si se mueve, son varias posiciones distintas. */
async function posicionesDelAuto(paginas: Page[], segundos: number): Promise<number[]> {
  const vistas = paginas.map(() => new Set<string>());
  for (let i = 0; i < segundos * 2; i++) {
    const ahora = await Promise.all(paginas.map(autoEnPantalla));
    ahora.forEach((t, j) => vistas[j]!.add(t));
    await paginas[0]!.waitForTimeout(500);
  }
  return vistas.map((v) => v.size);
}

test.beforeEach(async () => {
  const [pasajero, operador, chofer] = await Promise.all([entrarPorApi(SEED.pasajero), entrarPorApi(SEED.operador), entrarPorApi(SEED.chofer)]);
  await sinViajeActivo(pasajero, operador);
  await noDisponible(chofer);
});

test.afterEach(async () => {
  const [pasajero, operador, chofer] = await Promise.all([entrarPorApi(SEED.pasajero), entrarPorApi(SEED.operador), entrarPorApi(SEED.chofer)]);
  await sinViajeActivo(pasajero, operador);
  await noDisponible(chofer);
});

test('en «Simulada» el auto va solo a buscar al pasajero, frena, y al iniciar lo lleva y finaliza solo', async ({ browser }) => {
  test.setTimeout(120_000);
  expect(metros(PARTIDA, ORIGEN)).toBeLessThan(150);

  // El chofer, sin GPS: la posición es la del auto simulado.
  const ctxChofer = await browser.newContext();
  const ctxPasajero = await browser.newContext();
  await prepararContexto(ctxChofer);
  await prepararContexto(ctxPasajero);
  const rutasPedidas: string[] = [];
  await ctxChofer.route(
    (url) => url.pathname === '/api/viajes/rutas',
    (ruta) => {
      rutasPedidas.push(ruta.request().url());
      return rutaEnL(ruta);
    },
  );
  const chofer = await ctxChofer.newPage();
  const pasajero = await ctxPasajero.newPage();
  const csp = [chofer, pasajero].map(vigilarCsp);
  // Las posiciones que location aceptó (POST /api/ubicacion/ubicaciones con 204), en orden: el chofer
  // no superpone envíos, así que llegan en el orden en que salieron.
  const aceptadas: { lat: number; lng: number }[] = [];
  chofer.on('response', (r) => {
    const pedido = r.request();
    if (pedido.method() === 'POST' && new URL(pedido.url()).pathname === '/api/ubicacion/ubicaciones' && r.status() === 204) {
      aceptadas.push(pedido.postDataJSON());
    }
  });

  // «Simulada (demo)» viene elegida: se pone disponible y el auto, quieto, manda su posición cada 1 s.
  await entrar(chofer, SEED.chofer);
  await expect(chofer.getByRole('radio', { name: 'Simulada (demo)' })).toBeChecked();
  await chofer.getByRole('button', { name: 'Ponerme disponible' }).click();
  await expect(chofer.getByText('Disponible', { exact: true })).toBeVisible();
  await expect(chofer.getByText(/enviando cada 1 s · último envío/)).toBeVisible();

  // El pedido va por la API (la pantalla del pedido ya la prueba el flujo 2); el pasajero lo sigue en la suya.
  const sesionPasajero = await entrarPorApi(SEED.pasajero);
  exigir(await api(sesionPasajero, 'POST', '/viajes/solicitudes', { origen: ORIGEN, destino: DESTINO }), 201, 'pedir');
  await entrar(pasajero, SEED.pasajero);
  const actual = pasajero.locator('.linea-tiempo .paso.actual');

  // Acepta, y «Voy en camino» sale solo: el chofer no lo toca.
  await chofer.getByRole('button', { name: 'Aceptar' }).click();
  await expect(actual).toContainText('En camino a buscarte');
  await expect(chofer.getByText('El auto va solo a buscar al pasajero.')).toBeVisible();
  await expect(pasajero.getByText('Tu chofer llegó')).toHaveCount(0);

  // Se mueve, y se ve en las dos pantallas a la vez.
  const [enChofer, enPasajero] = await posicionesDelAuto([chofer, pasajero], 4);
  expect(enChofer).toBeGreaterThanOrEqual(3);
  expect(enPasajero).toBeGreaterThanOrEqual(3);

  // Llega al origen: location acepta una posición que es justo el origen. El pasajero ve «Tu chofer
  // llegó» y el chofer, su cartel de llegada con «Inició el viaje» como acción principal. El viaje sigue
  // en camino (llegar es solo de pantalla).
  await expect.poll(() => aceptadas.findIndex(enOrigen), { timeout: 30_000 }).toBeGreaterThanOrEqual(0);
  const llegada = aceptadas.findIndex(enOrigen);
  await expect(pasajero.getByText('Tu chofer llegó')).toBeVisible();
  await expect(chofer.locator('.cartel')).toContainText('esperá al pasajero');
  const iniciar = chofer.getByRole('button', { name: 'Inició el viaje' });
  await expect(iniciar).toHaveClass(/principal/);
  await expect(actual).toContainText('En camino a buscarte');

  // Frenó: hasta que el chofer toca «Inició el viaje», cada envío aceptado repite el origen (sigue
  // mandando cada 1 s, quieto). Se miran unos cuantos, no uno solo.
  await expect.poll(() => aceptadas.length - llegada, { timeout: 10_000 }).toBeGreaterThanOrEqual(4);
  const hastaIniciar = aceptadas.slice(llegada);
  expect(hastaIniciar.filter((p) => !enOrigen(p))).toEqual([]);

  // El chofer inicia a mano; el auto arranca solo hacia el destino y, al llegar, finaliza solo.
  await iniciar.click();
  await expect(actual).toContainText('En viaje');
  await expect(chofer.getByText('El auto va solo al destino y finaliza el viaje al llegar.')).toBeVisible();
  await expect(chofer.getByRole('heading', { name: 'Viaje terminado' })).toBeVisible({ timeout: 45_000 });
  await expect(pasajero.locator('.linea-tiempo .paso.hecho', { hasText: 'Terminado' })).toBeVisible();
  await expect(pasajero.getByText('Tarifa final')).toBeVisible();

  // La ruta del auto salió del test, no de OSRM.
  expect(rutasPedidas.length).toBeGreaterThan(0);
  expect(csp.flat()).toEqual([]);
  await ctxChofer.close();
  await ctxPasajero.close();
});
