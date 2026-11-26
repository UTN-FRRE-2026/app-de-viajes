// node apps/web/scripts/iconos.mjs
//
// Genera los PNG de la PWA a partir de public/icono.svg, con el Chromium de Playwright (el de los E2E):
// - icono-192.png e icono-512.png: el ícono tal cual (esquinas redondeadas, fondo transparente);
// - icono-maskable-512.png: fondo verde hasta el borde y el dibujo dentro de la zona segura (80 %), para
//   que Android lo recorte en círculo, gota o cuadrado sin cortar la flecha;
// - apple-touch-icon.png (180): cuadrado y sin transparencia, como lo pide iOS.
// Se corre a mano cuando cambia el SVG; los PNG se versionan. Después, cada PNG lleva su origen en un
// metadato (`impeccable embed-prompt <png> --prompt "Origen: …"`): regenerarlos lo borra.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const publico = fileURLToPath(new URL('../public/', import.meta.url));
const svg = readFileSync(`${publico}icono.svg`, 'utf8');
const datos = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

/** [archivo, lado, escala del dibujo, fondo verde detrás] */
const salidas = [
  ['icono-192.png', 192, 1, false],
  ['icono-512.png', 512, 1, false],
  ['icono-maskable-512.png', 512, 0.8, true],
  ['apple-touch-icon.png', 180, 1, true],
];

const navegador = await chromium.launch();
try {
  const pagina = await navegador.newPage();
  for (const [archivo, lado, escala, fondo] of salidas) {
    await pagina.setViewportSize({ width: lado, height: lado });
    const dibujo = Math.round(lado * escala);
    await pagina.setContent(
      `<body style="margin:0;width:${lado}px;height:${lado}px;display:grid;place-items:center;background:${fondo ? '#00563f' : 'transparent'}">` +
        `<img src="${datos}" width="${dibujo}" height="${dibujo}"></body>`,
    );
    await pagina.locator('img').evaluate((img) => img.decode());
    await pagina.screenshot({ path: `${publico}${archivo}`, omitBackground: !fondo });
    console.log(`${archivo} (${lado} px)`);
  }
} finally {
  await navegador.close();
}
