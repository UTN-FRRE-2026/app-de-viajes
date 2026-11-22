// Después de `vite build`: el resultado tiene que poder correr con la CSP de nginx
// (`script-src 'self'; style-src 'self'`, sin 'unsafe-inline'). Falla si encuentra código en línea.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const html = readFileSync(`${dist}index.html`, 'utf8');
const problemas = [];

for (const etiqueta of html.match(/<script\b[^>]*>/gi) ?? []) {
  if (!/\bsrc=/i.test(etiqueta)) problemas.push(`script en línea: ${etiqueta}`);
}
if (/<style\b/i.test(html)) problemas.push('etiqueta <style> en línea');
if (/\sstyle\s*=/i.test(html)) problemas.push('atributo style= en línea');
if (/\son[a-z]+\s*=/i.test(html)) problemas.push('manejador de eventos en línea (on...=)');
if (/javascript:/i.test(html)) problemas.push('URL javascript:');

// En el CSS, ningún recurso embebido salvo imágenes (img-src permite data:).
for (const archivo of readdirSync(`${dist}assets`).filter((a) => a.endsWith('.css'))) {
  const css = readFileSync(`${dist}assets/${archivo}`, 'utf8');
  for (const [, tipo] of css.matchAll(/url\(\s*['"]?data:([a-z]+\/[a-z0-9.+-]+)/gi)) {
    if (!tipo.startsWith('image/')) problemas.push(`${archivo}: recurso data:${tipo} embebido`);
  }
}

if (problemas.length) {
  console.error('revisar-csp: el build no cumple la CSP de la página:');
  for (const p of problemas) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('revisar-csp: dist/index.html sin scripts, estilos ni manejadores en línea.');
