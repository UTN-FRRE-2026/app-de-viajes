import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { expect, type BrowserContext, type Page } from '@playwright/test';

// Lo que comparten los flujos: la API para preparar datos (lo que no es el objeto del flujo), el login
// por la pantalla, las teselas del mapa y la vigilancia de la CSP.

export const BASE = process.env.E2E_URL ?? 'http://localhost:8080';

/** La contraseña de los usuarios del seed: E2E_CONTRASENA, o IDENTITY_SEED_CONTRASENA del .env. */
function contrasenaDelSeed(): string {
  if (process.env.E2E_CONTRASENA) return process.env.E2E_CONTRASENA;
  const env = new URL('../../.env', import.meta.url);
  if (existsSync(env)) {
    const linea = readFileSync(env, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('IDENTITY_SEED_CONTRASENA='));
    if (linea) return linea.slice(linea.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('Falta la contraseña del seed: E2E_CONTRASENA o IDENTITY_SEED_CONTRASENA en el .env');
}
export const CONTRASENA = contrasenaDelSeed();

export const SEED = {
  pasajero: 'pasajero@viajes.test',
  chofer: 'chofer@viajes.test',
  operador: 'operador@viajes.test',
  admin: 'admin@viajes.test',
  flota: 'admin.flota@viajes.test',
  flota2: 'admin.flota2@viajes.test',
} as const;

/** A unos 270 m de la Plaza 25 de Mayo, dentro de la zona «Resistencia» de la demo (`npm run demo:flotas`). */
export const CERCA_DE_LA_PLAZA = { latitude: -27.449, longitude: -58.988 };
/** A 1,7 km de la plaza: el segundo chofer más cercano. */
export const UN_POCO_MAS_LEJOS = { latitude: -27.46, longitude: -59.0 };

export interface Sesion {
  token: string;
  usuario: { id: string; rol: string; fleetId: string | null };
}

export interface Respuesta<T = unknown> {
  estado: number;
  json: T;
  codigo?: string;
}

/**
 * Lo que devuelve la API en los tests: JSON sin tipar. Los flujos leen dos o tres campos de cada
 * respuesta, y la forma exacta ya la cubren los contratos y los tests de cada servicio.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** Un pedido a la API por nginx (`/api/...`). Los que no son GET llevan una Idempotency-Key nueva. */
export async function api<T = Json>(sesion: Sesion | null, metodo: string, ruta: string, cuerpo?: unknown): Promise<Respuesta<T>> {
  const h: Record<string, string> = { accept: 'application/json' };
  if (sesion) h.authorization = `Bearer ${sesion.token}`;
  if (cuerpo !== undefined) h['content-type'] = 'application/json';
  if (metodo !== 'GET') h['idempotency-key'] = randomUUID();
  const r = await fetch(`${BASE}/api${ruta}`, { method: metodo, headers: h, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  const texto = await r.text();
  const json = texto ? JSON.parse(texto) : null;
  return { estado: r.status, json, codigo: json?.error?.code };
}

export function exigir<T>(r: Respuesta<T>, esperado: number, que: string): T {
  if (r.estado !== esperado) throw new Error(`${que}: ${r.estado} ${r.codigo ?? JSON.stringify(r.json)}`);
  return r.json;
}

export async function entrarPorApi(email: string, contrasena = CONTRASENA): Promise<Sesion & { refreshToken: string }> {
  return exigir(await api(null, 'POST', '/identity/login', { email, contrasena }), 200, `login de ${email}`);
}

/** Un sufijo distinto en cada corrida (emails y patentes). */
export const unico = () => randomUUID().slice(0, 8);

/** Una patente válida (AB123CD) que no se repite entre corridas. */
export function patenteNueva(): string {
  const letras = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  const l = () => letras[Math.floor(Math.random() * letras.length)];
  return `${l()}${l()}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}${l()}${l()}`;
}

/**
 * Un chofer nuevo, registrado en identity y dado de alta en la flota de `adminFlota`, con un vehículo.
 * `habilitar` (lo hace el admin de la plataforma) y `activar` (el admin de su flota) son opcionales.
 */
export async function choferNuevo(
  adminFlota: Sesion,
  opciones: { habilitar?: Sesion; activar?: boolean } = {},
): Promise<{ id: string; email: string; patente: string }> {
  const email = `e2e-chofer-${unico()}@viajes.test`;
  const registro = exigir(
    await api(null, 'POST', '/identity/registro', { email, contrasena: CONTRASENA, nombre: 'Chofer E2E', rol: 'chofer' }),
    201,
    'registro del chofer',
  );
  const id: string = registro.id ?? registro.usuario?.id;
  const patente = patenteNueva();
  exigir(await api(adminFlota, 'POST', '/viajes/flota/choferes', { choferId: id, vehiculo: { patente, marca: 'Fiat', modelo: 'Cronos' } }), 201, 'alta en la flota');
  if (opciones.habilitar) exigir(await api(opciones.habilitar, 'POST', `/viajes/admin/choferes/${id}/habilitar`, {}), 200, 'habilitar');
  if (opciones.activar) exigir(await api(adminFlota, 'POST', `/viajes/flota/choferes/${id}/activar`, {}), 200, 'activar');
  return { id, email, patente };
}

const ACTIVOS = ['BUSCANDO', 'ASIGNADO', 'EN_CAMINO', 'EN_CURSO'];

/**
 * Deja al pasajero sin viaje activo (un flujo anterior pudo quedar a mitad de camino): el operador
 * cancela lo que haya, en cualquier estado activo.
 */
export async function sinViajeActivo(pasajero: Sesion, operador: Sesion): Promise<void> {
  const r = exigir(await api(pasajero, 'GET', '/viajes/historial?limite=5'), 200, 'historial');
  for (const v of r.viajes.filter((x: { estado: string }) => ACTIVOS.includes(x.estado))) {
    exigir(await api(operador, 'POST', `/viajes/solicitudes/${v.id}/cancelar`, { motivo: 'limpieza del e2e' }), 200, 'cancelar el viaje anterior');
  }
}

/** Un chofer deja de estar disponible (ignora si no está en una flota). */
export async function noDisponible(chofer: Sesion): Promise<void> {
  await api(chofer, 'PUT', '/viajes/chofer/disponibilidad', { disponible: false });
}

/** Un PNG transparente de 1×1: las teselas del mapa en los tests, sin pedirle nada a OpenStreetMap. */
const TESELA = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

/**
 * Un contexto de navegador listo para los flujos: las teselas de OpenStreetMap se responden con una
 * imagen local (la política de uso de OSM no admite tráfico automatizado), y la CSP se vigila.
 */
export async function prepararContexto(contexto: BrowserContext): Promise<void> {
  await contexto.route('https://tile.openstreetmap.org/**', (ruta) => ruta.fulfill({ status: 200, contentType: 'image/png', body: TESELA }));
}

/** Junta los avisos de CSP de la consola de una página. Al final del flujo tiene que estar vacía. */
export function vigilarCsp(pagina: Page): string[] {
  const violaciones: string[] = [];
  pagina.on('console', (m) => {
    if (/Content Security Policy|Refused to (load|apply|execute|connect)/i.test(m.text())) violaciones.push(m.text());
  });
  return violaciones;
}

/** El login por la pantalla, como lo haría la persona. Espera a salir de /login. */
export async function entrar(pagina: Page, email: string, contrasena = CONTRASENA): Promise<void> {
  await pagina.goto('/login');
  await pagina.getByLabel('Email').fill(email);
  await pagina.getByLabel('Contraseña').fill(contrasena);
  await pagina.getByRole('button', { name: /entrar/i }).click();
  await expect(pagina).not.toHaveURL(/\/login/);
}
