/**
 * Las funciones de Netlify, corriendo dentro del servidor de desarrollo.
 *
 * Sin esto, `npm run dev` no tiene servidor: cada pedido a
 * `/.netlify/functions/...` da 404, el autocompletado de direcciones se apaga
 * solo y el envio cotiza "a confirmar". Todo el checkout es exactamente la
 * parte de la tienda que no se puede probar sin funciones, asi que se
 * desarrollaba a ciegas.
 *
 * Monta cada `.mjs` de netlify/functions en su ruta y le pasa un `Request`
 * comun, que es la firma que reciben en Netlify. El mismo archivo corre en los
 * dos lados sin cambios: lo unico que cambia es quien lo invoca.
 *
 * Solo en desarrollo. En produccion las ejecuta Netlify y este archivo no entra
 * al bundle.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CARPETA = 'netlify/functions';
const RUTA = '/.netlify/functions/';

/**
 * Las claves salen de claves_google.txt, en la raiz del repositorio.
 *
 * Ese archivo esta en .gitignore y es donde ya viven las claves locales del
 * proyecto. Sin el, las funciones responden 503 y la tienda degrada sola, que
 * es lo mismo que pasa en produccion cuando falta la variable.
 *
 * `GOOGLE_CSE_KEY` es el nombre viejo, de cuando la clave se usaba para la
 * Custom Search API. Se sigue aceptando porque es el que tiene cargado el
 * archivo; en Netlify la variable va como GOOGLE_PLACES_KEY.
 */
function cargarClaves(raiz) {
  const archivo = path.join(raiz, 'claves_google.txt');
  if (!fs.existsSync(archivo)) return;

  for (const linea of fs.readFileSync(archivo, 'utf8').split(/\r?\n/)) {
    const limpia = linea.trim();
    if (!limpia || limpia.startsWith('#') || !limpia.includes('=')) continue;
    const corte = limpia.indexOf('=');
    const nombre = limpia.slice(0, corte).trim();
    const valor = limpia.slice(corte + 1).trim().replace(/^["']|["']$/g, '');
    if (valor && !process.env[nombre]) process.env[nombre] = valor;
  }

  const google = process.env.GOOGLE_PLACES_KEY || process.env.GOOGLE_ROUTES_KEY
              || process.env.GOOGLE_CSE_KEY;
  if (google) {
    process.env.GOOGLE_PLACES_KEY ||= google;
    process.env.GOOGLE_ROUTES_KEY ||= google;
  }
}

export function funcionesEnDesarrollo() {
  return {
    name: 'funciones-netlify-en-desarrollo',
    apply: 'serve',

    configureServer(servidor) {
      const raiz = path.resolve(servidor.config.root, '..');
      const carpeta = path.join(servidor.config.root, CARPETA);
      cargarClaves(raiz);

      const disponibles = fs.existsSync(carpeta)
        ? fs.readdirSync(carpeta).filter(f => f.endsWith('.mjs')).map(f => f.replace(/\.mjs$/, ''))
        : [];

      // Cada clave que falta se nombra por separado: "responden 503" a secas
      // manda a revisar las cinco funciones cuando la que falta es una sola.
      const faltan = [
        process.env.GOOGLE_PLACES_KEY ? null : 'GOOGLE_PLACES_KEY (direcciones, envío, mapa)',
        process.env.GEMINI_API_KEY ? null : 'GEMINI_API_KEY (el chat del catálogo)',
      ].filter(Boolean);

      servidor.config.logger.info(
        disponibles.length
          ? `  ➜  Funciones:  ${disponibles.join(', ')}` +
            (faltan.length ? `\n  ➜  Sin clave:   ${faltan.join('\n                  ')}` : '')
          : '  ➜  Funciones:  ninguna');

      servidor.middlewares.use(async (peticion, respuesta, siguiente) => {
        if (!peticion.url?.startsWith(RUTA)) return siguiente();

        const nombre = peticion.url.slice(RUTA.length).split('?')[0];
        const archivo = path.join(carpeta, `${nombre}.mjs`);
        if (!disponibles.includes(nombre) || !fs.existsSync(archivo)) return siguiente();

        try {
          // Con la marca de tiempo se recarga la funcion en cada pedido: se
          // edita el archivo y el cambio esta, sin reiniciar el servidor.
          const modulo = await import(`${pathToFileURL(archivo).href}?t=${Date.now()}`);
          const salida = await modulo.default(await comoRequest(peticion));

          respuesta.statusCode = salida.status;
          salida.headers.forEach((valor, clave) => respuesta.setHeader(clave, valor));
          respuesta.end(Buffer.from(await salida.arrayBuffer()));
        } catch (err) {
          servidor.config.logger.error(`[funciones] ${nombre} falló: ${err?.stack || err}`);
          respuesta.statusCode = 500;
          respuesta.end('La función falló. El detalle está en la terminal.');
        }
      });
    },
  };
}

/** El pedido de Node pasado a lo que reciben las funciones en Netlify. */
async function comoRequest(peticion) {
  const cuerpo = ['GET', 'HEAD'].includes(peticion.method)
    ? undefined
    : await leerCuerpo(peticion);

  return new Request(`http://localhost${peticion.url}`, {
    method: peticion.method,
    headers: peticion.headers,
    body: cuerpo,
  });
}

function leerCuerpo(peticion) {
  return new Promise((listo, falla) => {
    const partes = [];
    peticion.on('data', p => partes.push(p));
    peticion.on('end', () => listo(Buffer.concat(partes)));
    peticion.on('error', falla);
  });
}
