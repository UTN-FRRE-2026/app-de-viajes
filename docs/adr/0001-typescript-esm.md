# ADR 0001 — TypeScript estricto con módulos ES (ESM) en todo el backend

- **Estado:** aceptado
- **Fecha:** 2026-10-28 (esqueleto del monorepo, PR #1). Escrito como ADR el 2026-11-20.
- **Quiénes participaron:** Ivan (armó el esqueleto en el PR #1, que se mergeó sin revisión). Revisión de este ADR: Agos y Maxi.
- **Alcance:** los tres servicios y los paquetes compartidos (`kernel`, `contracts`, `platform`)

## Contexto

El backend corre en Node.js 22 y está repartido en tres servicios y tres paquetes compartidos, en un monorepo con npm workspaces. Lo escribimos entre tres personas, y cualquiera tiene que poder explicar cualquier parte en la defensa.

Lo que más se rompe en un sistema así son los **bordes**:
- el cuerpo de un pedido que llega de afuera;
- la respuesta de otro servicio, por ejemplo los candidatos que location le devuelve a dispatch;
- los datos que salen de la base.

Hay que validar esos datos en ejecución (bloque 5: lista blanca, prototype pollution) y, además, que el resto del código sepa qué forma tienen sin repetir la definición.

Hay que elegir dos cosas:
- **El lenguaje:** JavaScript o TypeScript.
- **El formato de módulos:** CommonJS (`require`) o módulos ES (`import`).

## Opciones consideradas

1. **JavaScript con CommonJS.**
   - A favor: sin paso de compilación y el formato histórico de Node.
   - En contra: sin tipos, un cambio de contrato entre servicios (un campo que cambia de nombre) recién aparece en ejecución. Y CommonJS no es el formato del frontend (Vite y React usan ESM), así que habría dos formas de escribir módulos en el mismo repositorio.
2. **JavaScript con ESM y tipos en JSDoc**, verificado con `tsc --checkJs`.
   - A favor: sin compilación y con algo de verificación.
   - En contra: los tipos en comentarios son verbosos. Los tipos derivados de los esquemas de Zod (`z.infer`) y los genéricos del dominio se vuelven difíciles de leer, y en la práctica se terminan salteando.
3. **TypeScript con CommonJS.**
   - A favor: tipos y la compatibilidad más amplia con librerías viejas.
   - En contra: mezcla dos sistemas de módulos con el frontend y pierde lo propio de ESM: `await` de nivel superior e `import.meta.url` para ubicar archivos sin `__dirname`.
4. **TypeScript estricto con ESM** (elegida).

## Decisión

Todo el backend es **TypeScript estricto con módulos ES**:

- **ESM en todos lados:** cada `package.json` tiene `"type": "module"` y el compilador usa `module` y `moduleResolution` `NodeNext`. Los imports relativos llevan la extensión `.js`, como exige ESM en Node.
- **Modo estricto y más:** `tsconfig.base.json` activa `strict`, `noUncheckedIndexedAccess` (un índice de arreglo puede ser `undefined`), `noImplicitOverride` y `verbatimModuleSyntax`.
- **Un esquema, dos usos:** los contratos son esquemas de Zod en `packages/contracts`. El mismo esquema valida en ejecución (`strictObject`, lista blanca) y da el tipo estático (`z.infer`). Lo usan los dos lados: location valida lo que recibe y dispatch valida lo que le devuelven.
- **Sin compilar en desarrollo:** los paquetes exportan el código fuente con la condición `development` y lo compilado (`dist/`) por defecto. `tsx` (en `npm run dev`) y Vitest usan `development`, así que en desarrollo y en los tests no hace falta compilar nada. La imagen de Docker compila con `tsc` y corre JavaScript.
- **Prisma genera su cliente como ESM** (`moduleFormat = "esm"`) dentro de cada servicio.

## Consecuencias

**Ganamos:**
- Un cambio de contrato entre servicios rompe `npm run typecheck` en el CI, no en ejecución. Por ejemplo, el adaptador de dispatch y la ruta de location usan el mismo esquema `CandidatosRespuesta` de `contracts`: si location cambia un campo, no compila ninguno de los dos hasta ajustarlos.
- Una sola definición por contrato, que valida y tipa a la vez.
- El mismo formato de módulos en el backend y en el frontend.

**Perdemos:**
- Hay un paso de compilación para producción (`npm run build`; la imagen lo hace en su etapa de build).
- Los imports relativos llevan `.js` aunque el archivo sea `.ts`. Confunde al principio.

**Queda más difícil:**
- Hay que acordarse de la condición `development`: sin ella, Node busca `dist/` y falla si no se compiló. Por eso `npm run dev` y los tests la pasan siempre.
- Alguna librería escrita para CommonJS se importa con su exportación con nombre, por ejemplo `import { Redis } from 'ioredis'`.

## Qué nos haría cambiar de decisión

- **La cátedra pide JavaScript sin compilar.** Pasaríamos a la opción 2, ESM con JSDoc, y seguiríamos verificando con `tsc --checkJs`.
- **Node ejecuta TypeScript sin compilar de forma estable en la versión LTS que usemos.** Podríamos sacar `tsx` y la condición `development`. Antes habría que dejar de usar lo que esa ejecución no soporta: hoy usamos propiedades en el constructor (`constructor(private readonly repo: ...)`), que necesitan una transformación y no solo borrar los tipos.
- **Una dependencia necesaria existe solo para CommonJS y no se puede importar desde ESM.** No pasó hasta ahora.
