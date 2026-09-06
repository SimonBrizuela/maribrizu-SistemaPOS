/**
 * Recibe las mediciones de uso de la tienda y las suma en la base.
 *
 * El navegador manda tandas de eventos (`{ v: 1, eventos: [...] }`): una
 * visita que empieza, una pantalla que se abre, una búsqueda con cuántos
 * resultados dio, una ficha, algo que entra al carrito, el checkout, un
 * mensaje al chat. Acá se revisan uno por uno con `validarEvento()` —el
 * navegador puede mandar cualquier cosa y esta es la única puerta— y se
 * convierten en incrementos sobre el documento del día en
 * `tienda_estadisticas`, con la cuenta de servicio.
 *
 * Por qué una función y no escribir desde el navegador:
 *
 *   · La colección queda cerrada del todo. Nadie sin sesión del panel puede
 *     leerla, y nadie —ni con sesión— puede escribirla desde afuera: solo
 *     entra lo que pasa por acá, ya limpio.
 *   · Los contadores se suman con incrementos atómicos en una sola escritura,
 *     así dos visitas que llegan en el mismo instante no se pisan.
 *   · No se guarda ningún evento suelto ni ningún identificador de persona:
 *     lo que entra es "una búsqueda más de 'cuaderno'", nada más.
 *
 * Contesta siempre rápido y casi siempre 204: al navegador no le importa el
 * resultado y no lo espera. Lo que viene de localhost va a una colección de
 * pruebas aparte, para no mezclar el desarrollo con lo que mira el local.
 */
import { hayCredenciales, sumarAlDoc } from './lib/firestore.mjs';
import { agregarEventos, MAX_EVENTOS } from '../../src/estadisticas.js';

export const COLECCION = 'tienda_estadisticas';
export const COLECCION_PRUEBAS = 'tienda_estadisticas_pruebas';

const MAX_CUERPO = 24 * 1024;

// Desde dónde se acepta una tanda. Un navegador manda el Origin en cada POST
// y no lo puede falsear, así que esto deja afuera a cualquier otra página
// que quiera meterle números a la tienda. Un script de línea de comandos lo
// puede inventar, y contra eso no hay barrera sin estado compartido: las
// cifras son orientativas, no plata.
const ORIGENES_PERMITIDOS = [
  /^https:\/\/([a-z0-9-]+\.)*liceolibreria\.com$/,
  /^https:\/\/liceo-tienda\.netlify\.app$/,
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
];

export default async (peticion) => {
  if (peticion.method !== 'POST') {
    return new Response('Método no permitido', { status: 405 });
  }
  if (!hayCredenciales()) {
    return Response.json({ error: 'sin_credenciales' }, { status: 501 });
  }

  const origen = peticion.headers.get('origin') || '';
  if (origen && !ORIGENES_PERMITIDOS.some(re => re.test(origen))) {
    return new Response('Origen no permitido', { status: 403 });
  }

  const largo = Number(peticion.headers.get('content-length'));
  if (Number.isFinite(largo) && largo > MAX_CUERPO) {
    return new Response('Demasiado grande', { status: 413 });
  }

  let cuerpo;
  try {
    const texto = await peticion.text();
    if (texto.length > MAX_CUERPO) return new Response('Demasiado grande', { status: 413 });
    cuerpo = JSON.parse(texto);
  } catch {
    return new Response('Cuerpo inválido', { status: 400 });
  }
  if (cuerpo?.warmup) return new Response(null, { status: 204 });
  if (!cuerpo || typeof cuerpo !== 'object' || !Array.isArray(cuerpo.eventos)) {
    return new Response('Cuerpo inválido', { status: 400 });
  }

  const dias = agregarEventos(cuerpo.eventos.slice(0, MAX_EVENTOS), Date.now());
  const entradas = Object.entries(dias);
  if (!entradas.length) return new Response(null, { status: 204 });

  const coleccion = esDePrueba(origen) ? COLECCION_PRUEBAS : COLECCION;

  try {
    await Promise.all(entradas.map(([dia, agregado]) => sumarAlDoc(coleccion, dia, agregado)));
  } catch (err) {
    console.error('[medir] no se pudieron sumar las estadísticas:', err);
    return new Response('No se pudo guardar', { status: 502 });
  }

  return new Response(null, { status: 204 });
};

function esDePrueba(origen) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origen);
}
