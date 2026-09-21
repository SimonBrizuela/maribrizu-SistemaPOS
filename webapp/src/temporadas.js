// ── Temporadas de venta ───────────────────────────────────────────────────────
// Qué hay que tener comprado para la fecha que se viene, y cuándo empezar a
// comprarlo.
//
// Pedido del dueño (21/09/2026), con un caso concreto arriba de la mesa: el 6
// de septiembre se vendió muchísimo amarillo —limpia pipa, cinta, cartulina— y
// se dio cuenta tarde. Lo que pidió es que el sistema se lo recuerde solo el
// año que viene, dos meses antes, y que en el Centro de Compras esos productos
// se vean DISTINTOS de los demás: no están ahí porque se estén acabando ni
// porque cayeron debajo del mínimo, sino por la época del año.
//
// Los números le dieron la razón: en los cinco días previos al 6 de septiembre
// se vendieron 228 unidades de cosas amarillas contra las 9 que correspondían
// al ritmo de agosto. Veintiséis veces más.
//
// ── Cómo funciona ────────────────────────────────────────────────────────────
//
// 1. Un almanaque de fechas que mueven venta en una librería/mercería
//    (`TEMPORADAS`). Cada una sabe cuándo cae —incluso las que se mueven, como
//    el tercer domingo de octubre— y cuántos días antes se vende de verdad.
//
// 2. Un estudio de las ventas viejas (`estudiarTemporadas`) que, para cada
//    fecha, compara lo que se vendió en su ventana contra lo que ese mismo
//    producto vende el resto del año. Esa proporción es el EMPUJE: 26 veces
//    más para el amarillo del 6 de septiembre. El estudio es caro (recorre
//    todas las ventas), así que se hace una vez y el resultado se guarda.
//
// 3. Con el estudio hecho, `recomendarParaTemporada` cruza esos productos con
//    el stock de hoy y dice cuántos faltan para llegar a la fecha.
//
// Para las fechas de las que todavía no hay historia —el local registra ventas
// desde abril de 2026, así que el primer Día de la Madre con datos es el de
// 2027— cada temporada trae PISTAS: palabras y colores con los que se
// reconocen los productos de esa época. La recomendación por pista se marca
// como corazonada, no como dato, y solo alcanza a productos que ya se vendieron
// alguna vez: el catálogo tiene 8.300 fichas y proponer a ciegas es ruido.
//
// Todo acá es lógica pura: sin DOM y sin Firebase, como `urgencia_compra.js`.
// Se prueba en `tienda/pruebas/temporadas.test.js` y se puede correr fuera del
// navegador contra un volcado de Firestore.

import { parseNombreItem, unidadesDelRenglon } from './nombre_item.js';
import { pascua, domingoN, ymd, addDays, diasEntre, sumarDiasYmd } from './fechas_ar.js';

// ── Parámetros ───────────────────────────────────────────────────────────────

/** Cuántos días antes avisar. Dos meses: lo que pidió el dueño para llegar a
 *  encargarlo al mayorista, que no viene todas las semanas. */
export const AVISO_DEFAULT_DIAS = 60;
/** Empuje mínimo para considerar que un producto es "de la época". Con menos
 *  del doble, la diferencia entra en lo que varía cualquier semana. */
export const EMPUJE_MINIMO = 2;
/** Unidades mínimas vendidas en la ventana para que el empuje signifique algo.
 *  Sin esto, pasar de 0,2 a 1 unidad da un empuje de 5 y no dice nada. */
export const UNIDADES_MINIMAS = 4;
/** Días distintos con venta que tiene que tener un producto dentro de la
 *  ventana para contar como temporada. Uno solo no es una época: es una venta.
 *  Es la misma trampa que dejó el mínimo de Pañolenci en 44 por un corte de 50
 *  metros. En ventanas cortas alcanza con dos. */
export const MIN_DIAS_VENTANA = 3;
export const MIN_DIAS_VENTANA_CORTA = 2;
/** Hasta dónde puede pesar UN solo día dentro de la ventana. Doscientos
 *  broches vendidos de una vez el 26 de agosto no son el Día del Maestro, son
 *  un cliente que se llevó la caja. Lo que pase de acá no cuenta. */
export const TOPE_UN_DIA = 0.6;
/** Suavizado de la línea de base. Un producto que fuera de la fecha vende cero
 *  daría empuje infinito; sumándole esto al denominador, el que vendió 80
 *  queda arriba del que vendió 5, que es el orden que sirve para comprar. */
export const SUAVIZADO_BASE = 0.5;
/** Tope del empuje al mostrarlo y al pesarlo. Más que esto ya es "solo se
 *  vende en esta fecha" y el número exacto no cambia ninguna decisión. */
export const EMPUJE_TOPE = 30;
/** Cuántos productos se guardan por temporada. El estudio entero no entra en
 *  un documento de Firestore (1 MB) y la cola no se compra nunca. */
export const TOPE_PRODUCTOS = 80;
/** Cada cuánto conviene rehacer el estudio. */
export const ESTUDIO_VIGENCIA_DIAS = 30;

// ── El almanaque ─────────────────────────────────────────────────────────────
// `cuando` dice en qué día cae:
//   { mes, dia }                      → fecha fija (mes 1–12)
//   { mes, domingo: n }               → n-ésimo domingo del mes
//   { pascua: n }                     → n días desde el Domingo de Pascua
//
// `previa` son los días de venta ANTES de la fecha: es la ventana en la que se
// mide y para la que hay que tener stock. `post` son los días de después que
// todavía cuentan (el Día del Niño se sigue comprando el lunes).
//
// `pistas` son para cuando todavía no hay historia: `rubros` y `palabras` se
// buscan en el producto, `colores` en la variedad vendida y `excluir` saca lo
// que no corresponde aunque el rubro coincida.

// Lo que NO entra aunque el rubro coincida.
//
// El rubro solo alcanza para saber "esto es para regalar", pero no distingue
// dentro del rubro. Medido contra el catálogo real el 21/09/2026: REGALERÍA
// tiene los portarretratos y los peluches, pero también mouses, teclados y
// cartuchos de toner — nadie le regala un mouse a la madre. Y COTILLON, que
// tiene 24 productos, mezcla los globos con la espada de San Martín y el
// banderín de primavera, que son de OTRAS fechas.
const NO_ES_REGALO = ['mouse', 'teclado', 'toner', 'cartucho', 'impresora', 'pendrive',
  'informatica', 'adaptador', 'cargador', 'lector', 'tripode', 'consola', 'pad'];
// Cosas que son claramente de otra fecha del almanaque: que no se las lleve la
// que esté más cerca en el calendario.
const DE_OTRA_FECHA = ['san martin', 'granadero', 'escarapela', 'bandera', 'patrio',
  'primavera', 'navidad', 'navideno', 'arbolito', 'egresado', 'diploma', 'birrete'];

export const TEMPORADAS = [
  {
    id: 'reyes', nombre: 'Reyes Magos', cuando: { mes: 1, dia: 6 },
    previa: 14, post: 1, aviso: 45,
    ideas: [
      { que: 'juguetes de verano: pelotas, inflables, juegos de playa', buscar: ['inflable'] },
      { que: 'antiparras de pileta', buscar: ['antiparra'] },
      { que: 'papel de regalo', buscar: ['papel regalo'] },
      { que: 'burbujeros', buscar: ['burbuj'] },
    ],
    pistas: { rubros: ['regaleria', 'jugueteria'], palabras: ['papel regalo', 'mono regalo', 'bolsa regalo', 'bolsa organza', 'tarjeta', 'souvenir', 'juguete', 'pelota', 'inflable', 'antiparra', 'juego de playa', 'balde', 'burbujero', 'muneco', 'hot wheels', 'rompecabeza', 'peluche'], colores: [], excluir: [...NO_ES_REGALO, ...DE_OTRA_FECHA] },
    nota: 'Se arma con lo del envoltorio: papel de regalo, moños y bolsas.',
  },
  {
    id: 'vuelta_clases', nombre: 'Vuelta a clases', cuando: { mes: 3, dia: 1 },
    previa: 50, post: 25, aviso: 75,
    ideas: [
      { que: 'forros para cuadernos', buscar: ['forro'] },
      { que: 'etiquetas con nombre', buscar: ['etiqueta', 'nombre'] },
      { que: 'mochilas: hay 409 fichas y 4 unidades', buscar: ['mochila', 'carro'] },
      { que: 'set de geometria escolar', buscar: ['set', 'geometria'] },
    ],
    pistas: {
      rubros: ['escolares'],
      palabras: ['cuaderno', 'carpeta', 'repuesto', 'mochila', 'cartuchera', 'lapiz', 'boligrafo', 'regla', 'compas', 'tijera', 'plasticola', 'voligoma', 'adhesivo', 'forro', 'etiqueta', 'block', 'folio', 'resma', 'marcador', 'cartulina', 'tempera', 'goma de borrar', 'sacapunta', 'agenda', 'calculadora', 'geometria', 'escuadra', 'transportador', 'media colegial', 'papel madera', 'crayon', 'acuarela', 'fibra', 'microfibra', 'corrector'],
      colores: [],
    },
    nota: 'La más grande del año. Se encarga en diciembre y enero.',
  },
  {
    id: 'san_valentin', nombre: 'San Valentín', cuando: { mes: 2, dia: 14 },
    previa: 12, post: 0, aviso: 45,
    ideas: [
      { que: 'peluches con corazon', buscar: ['peluche', 'corazon'] },
      { que: 'bolsas de organza chicas', buscar: ['organza'] },
      { que: 'tarjetas de enamorados', buscar: ['tarjeta', 'amor'] },
      { que: 'cajitas de regalo para el arito', buscar: ['caja regalo'] },
      { que: 'globos con forma de corazon', buscar: ['globo', 'corazon'] },
    ],
    pistas: { rubros: ['regaleria'], palabras: ['corazon', 'peluche', 'tarjeta', 'bolsa organza', 'organza', 'mono regalo', 'papel regalo', 'celofan', 'arito', 'acero quirurgico', 'collar', 'dije', 'pulsera', 'osito'], colores: ['rojo', 'fucsia'], combinaciones: [{ palabras: ['goma eva', 'cartulina', 'papel afiche', 'papel crepe', 'crepe', 'celofan', 'globo', 'brillantina', 'barrilete', 'fieltro', 'panolenci', 'tul', 'cinta', 'papel', 'bolsa'], colores: ['rojo', 'fucsia', 'rosa'] }], excluir: [...NO_ES_REGALO, ...DE_OTRA_FECHA] },
  },
  {
    id: 'carnaval', nombre: 'Carnaval', cuando: { pascua: -48 },
    previa: 15, post: 2, aviso: 45,
    ideas: [
      { que: 'nieve en aerosol y espuma', buscar: ['nieve'] },
      { que: 'serpentina', buscar: ['serpentina'] },
      { que: 'papel picado', buscar: ['papel picado'] },
      { que: 'antifaces de carton', buscar: ['antifaz'] },
      { que: 'talco perfumado', buscar: ['talco'] },
      { que: 'maquillaje artistico de colores', buscar: ['pinturita'] },
    ],
    pistas: { rubros: ['cotillon'], palabras: ['tull', 'papel picado', 'antifaz', 'mascara', 'gorro', 'serpentina', 'espuma loca', 'pluma marabu', 'marabu', 'tul', 'lentejuela', 'strass', 'vincha', 'tiara', 'colita', 'peluca', 'talco'], colores: [], excluir: [...DE_OTRA_FECHA] },
  },
  {
    id: 'dia_mujer', nombre: 'Día de la Mujer', cuando: { mes: 3, dia: 8 },
    previa: 8, post: 0, aviso: 30,
    ideas: [
      { que: 'flores artificiales', buscar: ['flor'] },
      { que: 'tarjetas', buscar: ['tarjeta'] },
      { que: 'souvenirs chicos', buscar: ['souvenir'] },
    ],
    pistas: { rubros: ['regaleria'], palabras: ['flor', 'tarjeta', 'souvenir', 'arito', 'acero quirurgico', 'collar', 'dije', 'pulsera', 'billetera', 'portacosmetico', 'scrunchy', 'scunzi', 'vincha', 'mono de pelo'], colores: ['violeta', 'lila', 'morado'], combinaciones: [{ palabras: ['goma eva', 'cartulina', 'papel afiche', 'papel crepe', 'crepe', 'celofan', 'globo', 'brillantina', 'barrilete', 'fieltro', 'panolenci', 'tul', 'cinta', 'papel', 'bolsa'], colores: ['violeta', 'lila', 'morado'] }], excluir: [...NO_ES_REGALO, ...DE_OTRA_FECHA] },
  },
  {
    id: 'pascua', nombre: 'Pascua', cuando: { pascua: 0 },
    previa: 14, post: 1, aviso: 45,
    ideas: [
      { que: 'moldes de huevo de pascua', buscar: ['molde', 'huevo'] },
      { que: 'papel foil para huevos', buscar: ['foil'] },
      { que: 'conejitos de decoracion', buscar: ['conejo'] },
    ],
    pistas: { rubros: [], palabras: ['huevo', 'conejo', 'canasta', 'celofan', 'metalizado', 'foil', 'bolsa organza', 'mono regalo', 'papel regalo', 'telgopor', 'esfera', 'molde'], colores: [], excluir: [...NO_ES_REGALO] },
    nota: 'Lo que se vende es el envoltorio del huevo: celofán, metalizado, cintas.',
  },
  {
    id: '25_mayo', nombre: '25 de Mayo', grupo: 'patrias', cuando: { mes: 5, dia: 25 },
    previa: 14, post: 0, aviso: 45,
    ideas: [
      { que: 'cucardas y cocardas', buscar: ['cucarda'] },
      { que: 'papel picado celeste y blanco', buscar: ['papel picado'] },
      { que: 'guirnalda de banderines patrios', buscar: ['guirnalda', 'banderin'] },
      { que: 'banderas de mano', buscar: ['bandera', 'mano'] },
    ],
    pistas: { rubros: [], palabras: ['escarapela', 'bandera', 'aplique', 'granadero', 'revolucion mayo', 'belgrano', 'colon', 'asta', 'tahali', 'panuelo', 'constitucion', 'peineton', 'cucarda', 'cocarda'], colores: ['celeste', 'blanco'], combinaciones: [{ palabras: ['goma eva', 'cartulina', 'papel afiche', 'papel crepe', 'crepe', 'celofan', 'globo', 'brillantina', 'barrilete', 'fieltro', 'panolenci', 'tul', 'cinta', 'papel', 'bolsa'], colores: ['celeste', 'blanco', 'blanca'] }] },
    nota: 'Fecha patria: escarapelas y todo lo celeste y blanco para los actos.',
  },
  {
    id: 'jardin', nombre: 'Día de los Jardines y la Maestra Jardinera', cuando: { mes: 5, dia: 28 },
    previa: 14, post: 0, aviso: 45,
    ideas: [
      { que: 'souvenirs de goma eva', buscar: ['goma eva'] },
      { que: 'pompones', buscar: ['pompon'] },
      { que: 'limpia pipas', buscar: ['limpia pipa'] },
      { que: 'imanes', buscar: ['iman'] },
    ],
    pistas: { rubros: ['regaleria'], palabras: ['souvenir', 'goma eva', 'flor', 'aplique', 'taza', 'iman', 'imán', 'tarjeta', 'pompon', 'pompones', 'limpia pipa'], colores: [], excluir: [...NO_ES_REGALO, ...DE_OTRA_FECHA] },
  },
  {
    id: 'dia_libro', nombre: 'Día del Libro', cuando: { mes: 6, dia: 15 },
    previa: 12, post: 0, aviso: 30,
    ideas: [
      { que: 'señaladores', buscar: ['senalador'] },
      { que: 'agendas', buscar: ['agenda'] },
      { que: 'diarios íntimos', buscar: ['diario intimo'] },
    ],
    pistas: { rubros: [], palabras: ['libro', 'senalador', 'señalador', 'tarjeta', 'agenda', 'diario intimo', 'diario íntimo'], colores: [] },
  },
  {
    id: 'bandera', nombre: 'Día de la Bandera', grupo: 'patrias', cuando: { mes: 6, dia: 20 },
    previa: 14, post: 0, aviso: 45,
    ideas: [
      { que: 'cucardas y cocardas', buscar: ['cucarda'] },
      { que: 'papel picado celeste y blanco', buscar: ['papel picado'] },
      { que: 'guirnalda de banderines patrios', buscar: ['guirnalda', 'banderin'] },
      { que: 'banderas de mano', buscar: ['bandera', 'mano'] },
    ],
    pistas: { rubros: [], palabras: ['escarapela', 'bandera', 'aplique', 'granadero', 'revolucion mayo', 'belgrano', 'colon', 'asta', 'tahali', 'panuelo', 'constitucion', 'peineton', 'cucarda', 'cocarda'], colores: ['celeste', 'blanco'], combinaciones: [{ palabras: ['goma eva', 'cartulina', 'papel afiche', 'papel crepe', 'crepe', 'celofan', 'globo', 'brillantina', 'barrilete', 'fieltro', 'panolenci', 'tul', 'cinta', 'papel', 'bolsa'], colores: ['celeste', 'blanco', 'blanca'] }] },
    nota: 'Fecha patria: escarapelas y todo lo celeste y blanco para los actos.',
  },
  {
    id: 'dia_padre', nombre: 'Día del Padre', cuando: { mes: 6, domingo: 3 },
    previa: 16, post: 1, aviso: 45,
    ideas: [
      { que: 'tazas para sublimar', buscar: ['taza'] },
      { que: 'sets materos', buscar: ['mate'] },
      { que: 'llaveros', buscar: ['llavero'] },
      { que: 'tarjetas', buscar: ['tarjeta'] },
    ],
    pistas: { rubros: ['regaleria'], palabras: ['tarjeta', 'bolsa regalo', 'bolsa organza', 'mono regalo', 'papel regalo', 'souvenir', 'taza', 'mate', 'llavero'], colores: [], excluir: [...NO_ES_REGALO, ...DE_OTRA_FECHA] },
  },
  {
    id: 'independencia', nombre: '9 de Julio', grupo: 'patrias', cuando: { mes: 7, dia: 9 },
    previa: 14, post: 0, aviso: 45,
    ideas: [
      { que: 'cucardas y cocardas', buscar: ['cucarda'] },
      { que: 'papel picado celeste y blanco', buscar: ['papel picado'] },
      { que: 'guirnalda de banderines patrios', buscar: ['guirnalda', 'banderin'] },
      { que: 'banderas de mano', buscar: ['bandera', 'mano'] },
    ],
    pistas: { rubros: [], palabras: ['escarapela', 'bandera', 'aplique', 'granadero', 'revolucion mayo', 'belgrano', 'colon', 'asta', 'tahali', 'panuelo', 'constitucion', 'peineton', 'cucarda', 'cocarda'], colores: ['celeste', 'blanco'], combinaciones: [{ palabras: ['goma eva', 'cartulina', 'papel afiche', 'papel crepe', 'crepe', 'celofan', 'globo', 'brillantina', 'barrilete', 'fieltro', 'panolenci', 'tul', 'cinta', 'papel', 'bolsa'], colores: ['celeste', 'blanco', 'blanca'] }] },
    nota: 'Fecha patria: escarapelas y todo lo celeste y blanco para los actos.',
  },
  {
    id: 'dia_amigo', nombre: 'Día del Amigo', cuando: { mes: 7, dia: 20 },
    previa: 12, post: 1, aviso: 45,
    ideas: [
      { que: 'tarjetas', buscar: ['tarjeta'] },
      { que: 'peluches chicos', buscar: ['peluche'] },
      { que: 'bolsas de organza', buscar: ['organza'] },
      { que: 'llaveros', buscar: ['llavero'] },
    ],
    pistas: { rubros: ['regaleria'], palabras: ['tarjeta', 'bolsa regalo', 'bolsa organza', 'souvenir', 'mono regalo', 'papel regalo', 'peluche', 'llavero'], colores: [], excluir: [...NO_ES_REGALO, ...DE_OTRA_FECHA] },
  },
  {
    id: 'dia_nino', nombre: 'Día del Niño', cuando: { mes: 8, domingo: 3 },
    previa: 20, post: 1, aviso: 60,
    ideas: [
      { que: 'juguetes de mostrador', buscar: ['juguete'] },
      { que: 'papel de regalo', buscar: ['papel regalo'] },
      { que: 'globos', buscar: ['globo'] },
      { que: 'burbujeros', buscar: ['burbuj'] },
    ],
    pistas: { rubros: ['jugueteria', 'regaleria', 'cotillon'], palabras: ['juguete', 'papel regalo', 'bolsa regalo', 'mono regalo', 'globo', 'peluche', 'tarjeta'], colores: [], excluir: [...NO_ES_REGALO, ...DE_OTRA_FECHA] },
  },
  {
    id: 'amarillo', nombre: 'El 6 de septiembre · todo amarillo', grupo: 'septiembre', cuando: { mes: 9, dia: 6 },
    previa: 12, post: 1, aviso: 60,
    ideas: [
      { que: 'girasoles y flores amarillas artificiales', buscar: ['girasol'] },
      { que: 'flores artificiales', buscar: ['flor', 'artificial'] },
      { que: 'mates amarillos economicos', buscar: ['mate', 'amarillo'] },
      { que: 'globos amarillos', buscar: ['globo', 'amarillo'] },
    ],
    pistas: { rubros: [], palabras: ['girasol'], colores: ['amarillo'], combinaciones: [{ palabras: ['goma eva', 'cartulina', 'papel afiche', 'papel crepe', 'crepe', 'celofan', 'globo', 'brillantina', 'barrilete', 'fieltro', 'panolenci', 'tul', 'tull', 'cinta', 'papel', 'bolsa', 'limpia pipa', 'flor', 'pompon', 'mate', 'pluma marabu'], colores: ['amarillo'] }] },
    nota: 'Se regala algo amarillo. Vuela todo lo amarillo: limpia pipa, cintas, cartulinas, flores.',
  },
  {
    id: 'dia_maestro', nombre: 'Día del Maestro', grupo: 'septiembre', cuando: { mes: 9, dia: 11 },
    previa: 14, post: 0, aviso: 45,
    ideas: [
      { que: 'tazas para sublimar', buscar: ['taza'] },
      { que: 'imanes', buscar: ['iman'] },
      { que: 'tarjetas', buscar: ['tarjeta'] },
      { que: 'souvenirs de escritorio', buscar: ['souvenir'] },
    ],
    pistas: { rubros: ['regaleria'], palabras: ['souvenir', 'tarjeta', 'taza', 'iman', 'imán', 'aplique', 'flor', 'mate', 'llavero', 'bolsa organza'], colores: [], excluir: [...NO_ES_REGALO, ...DE_OTRA_FECHA] },
  },
  {
    id: 'primavera', nombre: 'Día del Estudiante y la Primavera', grupo: 'septiembre', cuando: { mes: 9, dia: 21 },
    previa: 14, post: 1, aviso: 45,
    ideas: [
      { que: 'flores artificiales', buscar: ['flor', 'artificial'] },
      { que: 'girasoles', buscar: ['girasol'] },
      { que: 'guirnaldas', buscar: ['guirnalda'] },
      { que: 'vinchas de flores', buscar: ['vincha', 'flor'] },
    ],
    pistas: { rubros: [], palabras: ['primavera', 'flor', 'souvenir', 'globo', 'tarjeta', 'vincha', 'banderin', 'banderín', 'guirnalda'], colores: [], combinaciones: [{ palabras: ['goma eva', 'cartulina', 'papel afiche', 'papel crepe', 'crepe', 'celofan', 'globo', 'brillantina', 'barrilete', 'fieltro', 'panolenci', 'tul', 'cinta', 'papel', 'bolsa'], colores: ['amarillo', 'verde', 'rosa'] }], excluir: [...DE_OTRA_FECHA] },
  },
  {
    id: 'dia_madre', nombre: 'Día de la Madre', cuando: { mes: 10, domingo: 3 },
    previa: 20, post: 1, aviso: 60,
    ideas: [
      { que: 'tarjetas del Dia de la Madre: no hay ninguna', buscar: ['tarjeta', 'mama'] },
      { que: 'velas aromaticas', buscar: ['vela', 'aromatica'] },
      { que: 'bolsas de organza chicas', buscar: ['organza'] },
      { que: 'peluches', buscar: ['peluche'] },
      { que: 'papel de regalo', buscar: ['papel regalo'] },
      { que: 'cajitas de regalo', buscar: ['caja regalo'] },
    ],
    pistas: { rubros: ['regaleria'], palabras: ['tarjeta', 'bolsa regalo', 'bolsa organza', 'organza', 'mono regalo', 'papel regalo', 'souvenir', 'flor', 'celofan', 'peluche', 'portaretrato', 'portarretrato', 'arito', 'acero quirurgico', 'collar', 'dije', 'pulsera', 'reloj', 'billetera', 'portacosmetico', 'pashmina', 'agenda', 'vaso termico', 'termo', 'mate', 'fibra facil', 'vela aromatica'], colores: [], excluir: [...NO_ES_REGALO, ...DE_OTRA_FECHA] },
    nota: 'De las más fuertes del año para el regalo y el envoltorio.',
  },
  {
    id: 'halloween', nombre: 'Halloween', cuando: { mes: 10, dia: 31 },
    previa: 18, post: 0, aviso: 45,
    ideas: [
      { que: 'telaranas y aranas de plastico', buscar: ['telarana'] },
      { que: 'calabazas de plastico', buscar: ['calabaza'] },
      { que: 'antifaces', buscar: ['antifaz'] },
      { que: 'maquillaje artistico y sangre falsa', buscar: ['pintafan'] },
      { que: 'globos con forma de fantasma o calabaza', buscar: ['globo', 'halloween'] },
    ],
    pistas: { rubros: [], palabras: ['disfraz', 'calabaza', 'antifaz', 'esqueleto', 'murcielago', 'telarana', 'halloween', 'bruja', 'zombie', 'vampiro', 'sangre', 'maquillaje artistico'], colores: [], combinaciones: [{ palabras: ['anilina', 'ojos moviles', 'goma eva', 'cartulina', 'papel afiche', 'papel crepe', 'crepe', 'celofan', 'globo', 'brillantina', 'barrilete', 'fieltro', 'panolenci', 'tul', 'cinta', 'papel', 'bolsa'], colores: ['naranja', 'negro', 'negra'] }], excluir: [...DE_OTRA_FECHA] },
  },
  {
    id: 'egresados', nombre: 'Egresados y fin de cursado', grupo: 'fin_de_anio', cuando: { mes: 11, dia: 25 },
    previa: 30, post: 15, aviso: 60,
    ideas: [
      { que: 'birretes de egresado', buscar: ['birrete'] },
      { que: 'medallas', buscar: ['medalla'] },
      { que: 'portadiplomas', buscar: ['portadiploma'] },
      { que: 'cintas de egresados', buscar: ['cinta', 'egresado'] },
      { que: 'laminas para plastificar', buscar: ['plastificar'] },
    ],
    pistas: { rubros: [], palabras: ['egresado', 'egresados', 'diploma', 'souvenir', 'birrete', 'portada', 'aplique', 'medalla', 'guirnalda', 'banderin', 'plastificar', 'plastificado', 'anillado'], colores: [], excluir: [...DE_OTRA_FECHA] },
    nota: 'Diplomas, souvenirs y actos de fin de año: arranca a mediados de noviembre.',
  },
  {
    id: 'navidad', nombre: 'Navidad', grupo: 'fin_de_anio', cuando: { mes: 12, dia: 25 },
    previa: 28, post: 0, aviso: 60,
    ideas: [
      { que: 'papel de regalo navideno', buscar: ['papel regalo', 'navid'] },
      { que: 'luces LED de arbolito', buscar: ['luces'] },
      { que: 'adornos de arbolito', buscar: ['adorno'] },
      { que: 'monos navidenos', buscar: ['mono', 'navid'] },
      { que: 'bolsas navidenas', buscar: ['bolsa', 'navid'] },
      { que: 'tarjetas de Navidad', buscar: ['tarjeta', 'navid'] },
    ],
    pistas: { rubros: ['navidad'], palabras: ['navidad', 'navideno', 'arbolito', 'guirnalda', 'papel regalo', 'mono regalo', 'bolsa regalo', 'celofan', 'metalizado', 'tarjeta', 'adorno', 'luces', 'pesebre', 'bota'], colores: ['rojo', 'verde', 'dorado', 'plateado'], combinaciones: [{ palabras: ['goma eva', 'cartulina', 'papel afiche', 'papel crepe', 'crepe', 'celofan', 'globo', 'brillantina', 'barrilete', 'fieltro', 'panolenci', 'tul', 'cinta', 'papel', 'bolsa'], colores: ['rojo', 'verde', 'dorado', 'plateado'] }], excluir: [...DE_OTRA_FECHA] },
  },
  {
    id: 'fin_anio', nombre: 'Fin de año', grupo: 'fin_de_anio', cuando: { mes: 12, dia: 31 },
    previa: 12, post: 1, aviso: 45,
    ideas: [
      { que: 'velas de numero para el 2027', buscar: ['vela', 'numero'] },
      { que: 'cornetas', buscar: ['corneta'] },
      { que: 'serpentina y papel picado', buscar: ['serpentina'] },
      { que: 'gorros de fin de ano', buscar: ['gorro', 'ano'] },
    ],
    pistas: { rubros: ['cotillon'], palabras: ['globo', 'gorro', 'guirnalda', 'serpentina', 'papel picado', 'bengala', 'vela', 'corneta', 'matasuegra', 'peluca', 'confeti'], colores: [], excluir: [...DE_OTRA_FECHA] },
  },
];

const POR_ID = new Map(TEMPORADAS.map(t => [t.id, t]));

/** Una temporada por su id (o null). */
export function temporadaPorId(id) { return POR_ID.get(String(id || '')) || null; }

// ── Cuándo cae cada una ──────────────────────────────────────────────────────

/** El día de la temporada en un año dado, como "YYYY-MM-DD". */
export function fechaDeTemporada(temp, anio) {
  const c = temp?.cuando;
  const y = Number(anio);
  if (!c || !y) return '';
  if (c.pascua != null) return ymd(addDays(pascua(y), Number(c.pascua) || 0));
  if (c.domingo != null) return ymd(domingoN(y, Number(c.mes) - 1, Number(c.domingo)));
  return ymd(new Date(y, Number(c.mes) - 1, Number(c.dia)));
}

/**
 * La ventana de venta de una temporada en un año: desde `previa` días antes
 * hasta `post` días después. Es donde hay que tener la mercadería.
 */
export function ventanaDeTemporada(temp, anio) {
  const fecha = fechaDeTemporada(temp, anio);
  if (!fecha) return null;
  return {
    fecha,
    desde: sumarDiasYmd(fecha, -Math.max(0, Number(temp.previa) || 0)),
    hasta: sumarDiasYmd(fecha, Math.max(0, Number(temp.post) || 0)),
  };
}

/**
 * Las temporadas que hay que empezar a comprar, ordenadas por la más cercana.
 *
 * Entra la que está a menos de su plazo de aviso (dos meses por defecto) y
 * cuya ventana todavía no terminó: una vez pasada la fecha ya no hay nada que
 * encargar. Mira también el año que viene, porque en noviembre lo que se
 * aproxima es el Reyes de enero.
 */
export function temporadasProximas(hoyYmd, { avisoDias = null, temporadas = TEMPORADAS } = {}) {
  const hoy = String(hoyYmd || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(hoy)) return [];
  const anio = Number(hoy.slice(0, 4));
  const out = [];
  for (const t of temporadas) {
    for (const y of [anio, anio + 1]) {
      const v = ventanaDeTemporada(t, y);
      if (!v) continue;
      if (v.hasta < hoy) continue;               // ya pasó: no hay nada que comprar
      const faltan = diasEntre(hoy, v.fecha);
      // El plazo de aviso es de la FECHA: cuántos días antes hay que empezar a
      // comprarla. `avisoDias` sólo estira hasta dónde se mira para listar (el
      // panel "Próximas fechas" pide el año entero) y no lo reemplaza: si lo
      // pisara, todas las fechas parecerían urgentes y la cercanía con la que
      // se calcula la urgencia saldría medida contra un año.
      const plazo = Number(t.aviso) || AVISO_DEFAULT_DIAS;
      const hastaDonde = avisoDias != null ? Number(avisoDias) : plazo;
      if (faltan > hastaDonde) continue;          // todavía falta demasiado
      out.push({
        id: t.id, grupo: grupoDe(t), nombre: t.nombre, nota: t.nota || '',
        anio: y, fecha: v.fecha, desde: v.desde, hasta: v.hasta,
        diasFaltan: faltan,
        // Ya arrancó la venta: la ventana empezó y la fecha no pasó.
        enVenta: hoy >= v.desde && hoy <= v.hasta,
        plazoAviso: plazo,
      });
      break;   // la ocurrencia más cercana alcanza
    }
  }
  out.sort((a, b) => a.diasFaltan - b.diasFaltan || a.nombre.localeCompare(b.nombre, 'es'));
  return out;
}

// ── Normalización ────────────────────────────────────────────────────────────

/** Texto comparable: sin tildes, en minúscula y con un solo espacio. */
export function normTxt(s) {
  return String(s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Clave de un producto vendido: nombre pelado + variedad, como en las ventas. */
export function claveProducto(nombre, color) {
  const n = normTxt(nombre);
  const c = normTxt(color);
  return c ? `${n}||${c}` : n;
}

// ── El estudio de las ventas viejas ──────────────────────────────────────────

/**
 * Índice fecha → LA temporada a la que pertenece ese día, o nada.
 *
 * Un día puede caer en la ventana de dos fechas: el 3 de septiembre está a 3
 * días del 6 y a 8 del Día del Maestro. Se lo queda la más cercana. Si se lo
 * quedaran las dos, cada una terminaría con la lista de productos de la otra y
 * el sistema diría que el limpia pipa amarillo es cosa del Día del Maestro.
 *
 * El desempate es por distancia a la fecha; a igual distancia, por la ventana
 * más corta (la más específica) y después por id, para que el resultado no
 * dependa del orden del almanaque.
 */
function _indiceDeVentanas(temporadas, anios) {
  const por = new Map();   // 'YYYY-MM-DD' → { id, dist, ancho }
  for (const t of temporadas) {
    const ancho = (Number(t.previa) || 0) + (Number(t.post) || 0);
    const id = grupoDe(t);
    for (const y of anios) {
      const v = ventanaDeTemporada(t, y);
      if (!v) continue;
      for (let d = v.desde; d <= v.hasta; d = sumarDiasYmd(d, 1)) {
        const dist = Math.abs(diasEntre(v.fecha, d));
        const actual = por.get(d);
        if (!actual
            || dist < actual.dist
            || (dist === actual.dist && ancho < actual.ancho)
            || (dist === actual.dist && ancho === actual.ancho && id < actual.id)) {
          por.set(d, { id, dist, ancho });
        }
      }
    }
  }
  return por;
}

/**
 * Bajo qué nombre se estudia una fecha.
 *
 * Hay fechas que se compran juntas y por separado no se pueden medir. Las tres
 * patrias (25 de Mayo, Bandera, 9 de Julio) venden la MISMA escarapela: medidas
 * de a una hay un puñado de ventas, y juntas ya son un patrón. Septiembre es al
 * revés: el 6, el Día del Maestro y la Primavera están tan encimados que la
 * ventana de uno se come la del otro, y lo que vuela —el amarillo— quedaba
 * partido en tres pedazos que no llegaban a nada.
 *
 * El AVISO sigue siendo por fecha, que es lo que el dueño mira; lo que se
 * comparte es lo aprendido, que es lo que se compra en un solo viaje.
 */
export function grupoDe(temp) {
  return String(temp?.grupo || temp?.id || '');
}

/** Qué colores de esta fecha valen la pena medir: los que ella misma declara.
 *  Sin esto, la columna de variedad mete "N5 dorado" y "6B" como si fueran
 *  colores de temporada, y el ruido tapa al amarillo. */
function _coloresDeclarados(temporadas, grupo) {
  const out = [];
  for (const t of temporadas) {
    if (grupoDe(t) !== grupo) continue;
    for (const c of (t.pistas?.colores || [])) out.push(normTxt(c));
  }
  return [...new Set(out.filter(Boolean))];
}

/**
 * Recorre todas las ventas una vez y arma, para cada temporada, qué se vendió
 * en su ventana y cuánto vende ese mismo producto el resto del año.
 *
 * La línea de base se mide SOLO con los días que no caen en ninguna ventana de
 * ninguna temporada: si se contaran los días de fiesta, el empuje se mediría
 * contra sí mismo y saldría siempre más chico de lo que es.
 *
 * `aYmd` traduce la fecha del renglón ("dd/mm/yyyy") a "YYYY-MM-DD", igual que
 * en `urgencia_compra.js`, para no arrastrar nada de afuera.
 */
export function estudiarTemporadas(items, {
  aYmd,
  catalogoPorNombre = null,
  temporadas = TEMPORADAS,
  topeProductos = TOPE_PRODUCTOS,
} = {}) {
  const lista = Array.isArray(items) ? items : [];
  const diasVistos = new Set();
  const filas = [];

  // Primera pasada: leer los renglones y quedarse con lo mínimo.
  for (const it of lista) {
    if (!it || it.deleted === true) continue;
    const dia = aYmd(it.fecha);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dia || ''))) continue;
    const crudo = it.producto || it.product_name || '';
    const parsed = parseNombreItem(crudo);
    const nombre = normTxt(parsed.base || crudo);
    if (!nombre) continue;
    const color = normTxt(it.conjunto_color || parsed.color || '');
    const uds = unidadesDelRenglon(
      { producto: crudo, cantidad: it.cantidad ?? it.quantity ?? 0 },
      (catalogoPorNombre && catalogoPorNombre.get(nombre)) || null,
    );
    if (!(uds > 0)) continue;   // las devoluciones no arman temporada
    diasVistos.add(dia);
    filas.push({ dia, nombre, color, uds });
  }

  if (!filas.length) {
    return { desde: '', hasta: '', dias: 0, anios: [], temporadas: {} };
  }

  const dias = [...diasVistos].sort();
  const desde = dias[0], hasta = dias[dias.length - 1];
  const anios = [...new Set(dias.map(d => Number(d.slice(0, 4))))].sort();
  const ventanas = _indiceDeVentanas(temporadas, anios);

  // Días de cada grupo y años en los que se lo pudo medir.
  const diasDeTemp = new Map();      // grupo → Set de días
  const aniosDeTemp = new Map();     // grupo → Set de años
  for (const d of dias) {
    const due = ventanas.get(d);
    if (!due) continue;
    let s = diasDeTemp.get(due.id);
    if (!s) { s = new Set(); diasDeTemp.set(due.id, s); }
    s.add(d);
    let a = aniosDeTemp.get(due.id);
    if (!a) { a = new Set(); aniosDeTemp.set(due.id, a); }
    a.add(Number(d.slice(0, 4)));
  }

  // Cuántas veces se pudo medir cada grupo: una por fecha y por año con venta
  // adentro. Las patrias son tres por año; lo que se espera para UNA es lo
  // medido dividido por eso, no por la cantidad de años.
  const ocurrencias = new Map();
  for (const t of temporadas) {
    const g = grupoDe(t);
    const suyos = diasDeTemp.get(g);
    if (!suyos) continue;
    for (const y of anios) {
      const v = ventanaDeTemporada(t, y);
      if (!v) continue;
      let tiene = false;
      for (const d of suyos) { if (d >= v.desde && d <= v.hasta) { tiene = true; break; } }
      if (tiene) ocurrencias.set(g, (ocurrencias.get(g) || 0) + 1);
    }
  }

  // Segunda pasada: unidades totales de cada producto, y cuántas cayeron en
  // cada temporada.
  //
  // La línea de base de una temporada es TODO lo demás: lo que el producto
  // vende el resto del año, incluidos los días de las otras fechas. Es la
  // comparación que importa —"¿vende más para el 6 de septiembre que en un día
  // cualquiera?"— y es la única que se puede medir con cinco meses de
  // historia: descontar de la base los días de las veintidós fechas dejaba
  // cuarenta días sueltos contra los que todo parecía un pico.
  const total = new Map();           // clave → unidades en todo el período
  const totalColor = new Map();      // color → unidades en todo el período
  const porTemp = new Map();         // id → Map(clave → {n, c, u, d:Map})
  const porTempColor = new Map();    // id → Map(color → {u, d:Map})
  for (const f of filas) {
    const clave = claveProducto(f.nombre, f.color);
    total.set(clave, (total.get(clave) || 0) + f.uds);
    if (f.color) totalColor.set(f.color, (totalColor.get(f.color) || 0) + f.uds);
    const due = ventanas.get(f.dia);
    if (!due) continue;
    let m = porTemp.get(due.id);
    if (!m) { m = new Map(); porTemp.set(due.id, m); }
    const e = m.get(clave);
    if (e) { e.u += f.uds; e.d.set(f.dia, (e.d.get(f.dia) || 0) + f.uds); }
    else m.set(clave, { n: f.nombre, c: f.color, u: f.uds, d: new Map([[f.dia, f.uds]]) });
    if (!f.color) continue;
    let mc = porTempColor.get(due.id);
    if (!mc) { mc = new Map(); porTempColor.set(due.id, mc); }
    const ec = mc.get(f.color);
    if (ec) { ec.u += f.uds; ec.d.set(f.dia, (ec.d.get(f.dia) || 0) + f.uds); }
    else mc.set(f.color, { u: f.uds, d: new Map([[f.dia, f.uds]]) });
  }

  const diasTotales = dias.length;

  // Armado del resultado: por cada grupo de fechas, los productos que más se
  // despegaron de su propio ritmo del resto del año.
  const out = {};
  const grupos = [...new Set(temporadas.map(grupoDe))];
  for (const grupo of grupos) {
    const m = porTemp.get(grupo);
    const diasVentana = (diasDeTemp.get(grupo) || new Set()).size;
    if (!m || !diasVentana) continue;
    const diasBase = Math.max(1, diasTotales - diasVentana);
    const minDias = diasVentana >= 12 ? MIN_DIAS_VENTANA : MIN_DIAS_VENTANA_CORTA;

    // ── Primero los COLORES ──────────────────────────────────────────────
    // El 6 de septiembre no vuela "el limpia pipa": vuela TODO lO amarillo,
    // repartido entre la cinta, la cartulina, el hilo y las flores. Medido de
    // a un producto por vez, ninguno llega solo al umbral y la fecha entera
    // pasa desapercibida; medido por color, salta a la vista.
    const mc = porTempColor.get(grupo) || new Map();
    const declarados = _coloresDeclarados(temporadas, grupo);
    const colores = [];
    const calientes = new Set();
    for (const [color, e] of mc) {
      // Solo los colores que la fecha declara como suyos. "Amarillo limón" y
      // "amarillo patito" cuentan para el 6 de septiembre; "N5 dorado", que es
      // un número de broche, no cuenta para nada.
      if (!declarados.some(d => color.includes(d))) continue;
      if (e.d.size < minDias) continue;
      const udsEf = _sinElDiaDominante(e.u, e.d);
      if (!(udsEf >= UNIDADES_MINIMAS * 2)) continue;   // un color junta muchos productos
      const base = Math.max(0, (totalColor.get(color) || 0) - e.u) / diasBase;
      const empuje = (udsEf / diasVentana) / (base + SUAVIZADO_BASE / diasBase);
      if (!(empuje >= EMPUJE_MINIMO)) continue;
      colores.push({
        c: color,
        u: Math.round(udsEf * 100) / 100,
        b: Math.round(base * 1000) / 1000,
        e: Math.round(Math.min(empuje, EMPUJE_TOPE) * 10) / 10,
        d: e.d.size,
      });
      calientes.add(color);
    }
    colores.sort((a, b) => (b.u * b.e) - (a.u * a.e) || b.u - a.u);

    // ── Después los productos ────────────────────────────────────────────
    // Un producto de un color caliente entra con la vara más baja: ya sabemos
    // que esa fecha mueve ese color, así que alcanza con que este producto
    // haya acompañado. Sin esa excepción, el limpia pipa amarillo —que vendió
    // 76 unidades en un solo día de la previa— quedaba afuera del 6 de
    // septiembre, que es justo el caso que hay que resolver.
    const productos = [];
    for (const [clave, e] of m) {
      const deColorCaliente = !!e.c && calientes.has(e.c);
      // Un solo mostrador no arma una época. Se pide venta repartida en varios
      // días y, además, se descuenta lo que un día suelto tenga de más: los
      // dos filtros juntos son los que sacan de la lista al cliente que se
      // llevó la caja entera.
      if (e.d.size < (deColorCaliente ? 1 : minDias)) continue;
      const udsEfectivas = deColorCaliente ? e.u : _sinElDiaDominante(e.u, e.d);
      if (!(udsEfectivas >= UNIDADES_MINIMAS)) continue;
      const udsBase = Math.max(0, (total.get(clave) || 0) - e.u);
      const porDiaBase = udsBase / diasBase;
      const porDiaVentana = udsEfectivas / diasVentana;
      // Suavizado: el que fuera de la fecha vende cero no da infinito, y entre
      // dos que venden cero gana el que vendió más unidades en la ventana.
      const empuje = porDiaVentana / (porDiaBase + SUAVIZADO_BASE / diasBase);
      if (!(empuje >= EMPUJE_MINIMO)) continue;
      productos.push({
        n: e.n,
        c: e.c || '',
        u: Math.round(udsEfectivas * 100) / 100,
        b: Math.round(porDiaBase * 1000) / 1000,
        e: Math.round(Math.min(empuje, EMPUJE_TOPE) * 10) / 10,
        d: e.d.size,
        ...(deColorCaliente ? { k: 'color' } : {}),
      });
    }
    // El orden con el que se compra: volumen pesado por cuánto se despega.
    productos.sort((a, b) => (b.u * b.e) - (a.u * a.e) || b.u - a.u);
    if (!productos.length && !colores.length) continue;
    out[grupo] = {
      anios: [...(aniosDeTemp.get(grupo) || [])].sort(),
      veces: Math.max(1, ocurrencias.get(grupo) || 1),
      dias: diasVentana,
      productos: productos.slice(0, topeProductos),
      ...(colores.length ? { colores: colores.slice(0, 12) } : {}),
    };
  }

  return { desde, hasta, dias: diasTotales, anios, temporadas: out };
}

/**
 * Las unidades de la ventana, sin lo que un día suelto tenga de más.
 *
 * Si el día más grande se lleva más de `TOPE_UN_DIA` de todo lo vendido, se
 * recorta hasta esa proporción. Una venta sola de doscientos broches queda en
 * nada; una venta repartida en cinco días pasa entera. Es lo que separa "en
 * esta fecha se vende más" de "un cliente se llevó la caja".
 */
function _sinElDiaDominante(uds, porDia) {
  let mayor = 0;
  for (const v of porDia.values()) if (v > mayor) mayor = v;
  const resto = uds - mayor;
  return Math.max(0, Math.min(uds, resto / (1 - TOPE_UN_DIA)));
}

// ── Lo que se recomienda comprar ─────────────────────────────────────────────

/**
 * ¿El producto pinta para esta temporada según las pistas? Es el camino de la
 * corazonada, para las fechas de las que todavía no hay historia.
 */
export function coincidePorPista(temp, { nombre = '', color = '', rubro = '', subRubro = '' } = {}) {
  const pistas = temp?.pistas || {};
  const texto = normTxt([nombre, subRubro].filter(Boolean).join(' '));
  const palabras = (pistas.palabras || []).map(normTxt);

  // Lo que se saca aunque el rubro coincida: cosas de OTRA fecha del almanaque
  // y cosas que nadie regala. Sin esto, medido contra el catálogo real, a
  // Halloween le entraban la espada de San Martín y el banderín de primavera
  // (los tres son rubro COTILLON) y al Día de la Madre, los mouses y teclados
  // (rubro REGALERÍA, subrubro INFORMATICA).
  //
  // Lo PROPIO gana: la lista nombra "navidad" y "primavera" para que no se las
  // lleve la fecha de al lado, así que sin esta salvedad la Navidad se
  // excluiría a sí misma.
  for (const x of (pistas.excluir || [])) {
    const ex = normTxt(x);
    if (!ex || palabras.includes(ex)) continue;
    if (_tienePalabra(texto, ex)) return false;
  }

  // El rubro es la pista más limpia que hay: el local ya tiene separadas
  // REGALERÍA, JUGUETERÍA, COTILLON y NAVIDAD, que es justo lo que se vende
  // para estas fechas. No hace falta adivinarlo del nombre.
  const rub = normTxt(rubro);
  if (rub && (pistas.rubros || []).some(r => rub === normTxt(r))) return true;

  // MATERIAL + COLOR. Para Halloween el local no tiene "cosas de Halloween":
  // tiene goma eva naranja, cartulina negra, papel afiche negro y globos
  // naranjas, que es con lo que los chicos arman el disfraz y la decoración.
  // Buscado de a una pista suelta no aparece nada —"goma eva" sola trae los
  // doce colores y "negro" solo trae todos los bolígrafos—, pero cruzando las
  // dos sale exactamente lo que se usa. Medido contra el catálogo real
  // (21/09/2026): 88 productos con variedad naranja o negra.
  const col = normTxt(color);
  for (const combo of (pistas.combinaciones || [])) {
    if (!col || !(combo.colores || []).some(c => col.includes(normTxt(c)))) continue;
    if ((combo.palabras || []).some(pal => _tienePalabra(texto, normTxt(pal)))) return true;
  }

  // Los COLORES no entran acá a propósito. Para medir sirven —el amarillo de
  // septiembre salió limpio de las ventas—, pero para adivinar no: pedir
  // "negro" para Halloween devolvía todos los bolígrafos negros del catálogo.
  if (!palabras.length) return false;
  // Por palabra entera, no por pedazo: buscando "mono" adentro del texto,
  // MONOPOLY y MONOAMBIENTE entraban como artículos de regalo.
  return palabras.some(p => _tienePalabra(texto, p));
}

/** ¿El texto tiene esta palabra (o frase) ENTERA? Buscando por pedazo,
 *  "fantasia" contenía "antifaz" y el sistema daba por cubierto un antifaz que
 *  el local no tiene. */
export function tienePalabra(texto, frase) { return _tienePalabra(texto, frase); }

function _tienePalabra(texto, frase) {
  if (!frase) return false;
  let desde = 0;
  for (;;) {
    const i = texto.indexOf(frase, desde);
    if (i < 0) return false;
    const antes = i === 0 ? ' ' : texto[i - 1];
    const fin = i + frase.length;
    const despues = fin >= texto.length ? ' ' : texto[fin];
    if (!/[a-z0-9]/.test(antes) && !/[a-z0-9]/.test(despues)) return true;
    desde = i + 1;
  }
}

/**
 * Lo que conviene mirar para una fecha de la que todavía no hay historia.
 *
 * El local registra ventas desde abril de 2026: el primer Día de la Madre
 * medido va a ser el de 2027. Hasta entonces, lo único que se puede hacer es
 * mirar el tipo de producto —lo que se vende para regalar— y avisar que en esa
 * fecha se vende más de lo normal. Es una corazonada, y como tal se muestra:
 * pesa la mitad que un dato medido y la fila lo dice con todas las letras.
 *
 * Solo entran productos que YA se venden: el catálogo tiene más de ocho mil
 * fichas y proponer a ciegas lo que nunca se vendió es ruido, no ayuda.
 *
 * `candidatos` los arma quien llama, que es el que sabe leer el catálogo:
 * `{ nombre, color, rubro, subRubro, stock, velDia, docId, producto }`.
 */
export function recomendarPorPistas(proxima, {
  candidatos = [],
  empujeSupuesto = EMPUJE_MINIMO,
  minUrgencia = 1,
  tope = 30,
} = {}) {
  const temp = temporadaPorId(proxima?.id);
  if (!temp) return [];
  const dias = Math.max(1, (Number(temp.previa) || 0) + (Number(temp.post) || 0));
  const out = [];
  for (const c of candidatos) {
    const velDia = Math.max(0, Number(c.velDia) || 0);
    if (!(velDia > 0)) continue;                   // si no se vende, no se compra
    if (!coincidePorPista(temp, c)) continue;
    // Lo que se vendería si la fecha lo empuja como empuja a las demás.
    const esperado = velDia * dias * empujeSupuesto;
    const stock = Math.max(0, Number(c.stock) || 0);
    const urgencia = urgenciaDeTemporada({
      empuje: empujeSupuesto,
      esperado, stock,
      diasFaltan: proxima.diasFaltan,
      plazoAviso: proxima.plazoAviso,
      porPista: true,
    });
    if (urgencia < minUrgencia) continue;
    out.push({
      clave: claveProducto(c.nombre, c.color),
      nombre: c.nombre,
      color: c.color || '',
      docId: c.docId,
      producto: c.producto || null,
      stock,
      esperado,
      empuje: empujeSupuesto,
      faltan: Math.max(0, esperado - stock),
      urgencia,
      porPista: true,
      temporada: { id: proxima.id, nombre: proxima.nombre, fecha: proxima.fecha, diasFaltan: proxima.diasFaltan },
    });
  }
  // Primero lo que más se mueve: de una corazonada, lo único sólido es que el
  // producto ya se vende.
  out.sort((a, b) => b.esperado - a.esperado || b.urgencia - a.urgencia);
  return out.slice(0, tope);
}

/**
 * Cuánta urgencia tiene comprar algo por la época: 0–100.
 *
 * Tres cosas la mueven:
 *   · cuánto se despega ese producto en la fecha (el empuje medido);
 *   · qué parte de lo que se va a vender NO está en el stock de hoy;
 *   · qué tan encima está la fecha, con el plazo de aviso como escala.
 *
 * Se multiplican por lo mismo que en `urgencia_compra.js`: tener el triple de
 * lo que se vende no urge aunque la fecha sea mañana, y un producto que vuela
 * en la fecha no urge en enero.
 */
export function urgenciaDeTemporada({
  empuje = 0,
  esperado = 0,
  stock = 0,
  diasFaltan = 0,
  plazoAviso = AVISO_DEFAULT_DIAS,
  porPista = false,
} = {}) {
  const esp = Math.max(0, Number(esperado) || 0);
  if (!(esp > 0)) return 0;
  const falta = Math.max(0, esp - Math.max(0, Number(stock) || 0));
  const descubierto = falta / esp;                       // 0 = está todo, 1 = no hay nada
  if (!(descubierto > 0)) return 0;

  const e = Math.max(0, Number(empuje) || 0);
  // Cuánto se despega, llevado a 0–1. Al doble ya cuenta; a diez veces está al
  // tope: más que eso no cambia la decisión de compra.
  const fuerza = Math.min(1, Math.max(0, (e - 1) / 9));

  // Cuanto más cerca la fecha, más apura. El día de la fecha vale 1; al límite
  // del aviso (dos meses) vale 0,35: figura, pero no le gana a lo que se está
  // quedando sin stock hoy.
  const plazo = Math.max(1, Number(plazoAviso) || AVISO_DEFAULT_DIAS);
  const d = Math.min(plazo, Math.max(0, Number(diasFaltan) || 0));
  const cercania = 1 - 0.65 * (d / plazo);

  // La corazonada por pista pesa la mitad: es una regla escrita a mano, no un
  // dato medido en el mostrador.
  const confianza = porPista ? 0.5 : 1;

  const score = 100 * fuerza * descubierto * cercania * confianza;
  return Math.round(Math.min(100, score) * 10) / 10;
}

/**
 * Las recomendaciones de una temporada, cruzando lo estudiado con el stock.
 *
 * `stockDe(clave, {nombre, color})` lo pone quien llama: solo él sabe leer el
 * catálogo (variedades en packs, conjuntos con total, productos comunes). Tiene
 * que devolver `{ stock, docId, producto }` en UNIDADES, o null si el producto
 * ya no existe en el catálogo.
 */
export function recomendarParaTemporada(proxima, estudio, {
  stockDe,
  minUrgencia = 1,
  tope = 40,
} = {}) {
  if (!proxima || typeof stockDe !== 'function') return [];
  const datos = estudio?.temporadas?.[proxima.grupo || proxima.id];
  if (!datos || !Array.isArray(datos.productos)) return [];
  // Lo medido puede venir de varias pasadas de la misma fecha (dos años) o de
  // fechas hermanas (las tres patrias). Lo que se espera para ESTA vez es el
  // promedio, no la suma de todas.
  const veces = Math.max(1, Number(datos.veces) || (datos.anios || []).length || 1);
  const out = [];
  for (const p of datos.productos) {
    const clave = claveProducto(p.n, p.c);
    const info = stockDe(clave, { nombre: p.n, color: p.c });
    if (!info) continue;
    const esperado = p.u / veces;
    const urgencia = urgenciaDeTemporada({
      empuje: p.e,
      esperado,
      stock: info.stock,
      diasFaltan: proxima.diasFaltan,
      plazoAviso: proxima.plazoAviso,
    });
    if (urgencia < minUrgencia) continue;
    out.push({
      clave,
      nombre: p.n,
      color: p.c || '',
      docId: info.docId,
      producto: info.producto || null,
      stock: Math.max(0, Number(info.stock) || 0),
      esperado,
      empuje: p.e,
      faltan: Math.max(0, esperado - Math.max(0, Number(info.stock) || 0)),
      urgencia,
      porPista: false,
      temporada: { id: proxima.id, nombre: proxima.nombre, fecha: proxima.fecha, diasFaltan: proxima.diasFaltan },
    });
  }
  out.sort((a, b) => b.urgencia - a.urgencia || b.faltan - a.faltan);
  return out.slice(0, tope);
}

/**
 * La frase que explica por qué un producto está en la lista por la época.
 * Corta y en criollo: es lo que el dueño lee para decidir si le cree.
 */
/**
 * `conFecha` en false cuando quien muestra el motivo ya puso la fecha y los
 * días al lado (el chip de la fila del Centro de Compras). Repetirlos convierte
 * cada fila en un párrafo que nadie lee — la misma crítica que ya se llevó la
 * línea de detalle por decir tres veces los mismos números.
 */
export function motivoTemporada(rec, { conFecha = true } = {}) {
  if (!rec?.temporada) return '';
  const t = rec.temporada;
  const cuando = t.diasFaltan <= 0 ? 'es hoy'
    : t.diasFaltan === 1 ? 'es mañana'
    : `faltan ${t.diasFaltan} días`;
  const donde = conFecha ? `${t.nombre} (${cuando})` : 'esta fecha';
  if (rec.porPista) return `suele venderse para ${donde}`;
  const e = Number(rec.empuje) || 0;
  const veces = e >= EMPUJE_TOPE ? 'casi solo se vende en esta fecha'
    : `se vende ${_veces(e)} veces más que el resto del año`;
  return conFecha ? `para ${donde}: ${veces}` : veces;
}

function _veces(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10).replace('.', ',');
}

/** Texto del tooltip: la cuenta abierta, para poder discutirla. */
export function explicarTemporada(rec) {
  if (!rec?.temporada) return '';
  const t = rec.temporada;
  const n = x => {
    const v = Number(x) || 0;
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10).replace('.', ',');
  };
  const lineas = [`${t.nombre} · ${_fechaLinda(t.fecha)}`];
  if (rec.porPista) {
    lineas.push('· Todavía no hay ventas viejas de esta fecha para medir');
    lineas.push(`· Entra por el tipo de producto, no por lo que vendió`);
  } else {
    lineas.push(`· En la fecha se vende ${n(rec.empuje)} veces más que el resto del año`);
    lineas.push(`· La última vez se vendieron ${n(rec.esperado)} unidades`);
  }
  lineas.push(`· Stock de hoy: ${n(rec.stock)}`);
  if (rec.faltan > 0) lineas.push(`· Faltarían ${n(rec.faltan)} para llegar igual que la vez pasada`);
  lineas.push(rec.porPista
    ? 'Es una corazonada por el tipo de producto: revisalo antes de comprar.'
    : 'Sale de tus propias ventas de esa misma fecha.');
  return lineas.join('\n');
}

function _fechaLinda(ymdStr) {
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymdStr || ''));
  if (!m) return String(ymdStr || '');
  return `${Number(m[3])} de ${MESES[Number(m[2]) - 1] || ''}`;
}

// ── Lo que el dueño corrige a mano ───────────────────────────────────────────
// El sistema mide y adivina, pero el que atiende el mostrador sabe cosas que no
// están en ningún dato: que tal producto se vende para Halloween aunque el
// nombre no lo diga, o que tal otro no tiene nada que ver con la fecha aunque
// el ritmo lo haya puesto ahí.
//
// Esas dos decisiones se guardan por fecha y ganan siempre sobre lo calculado:
//
//   { "<id de la fecha>": { suma: { "<clave>": {...} }, saca: { "<clave>": true } } }
//
// La clave es la misma que usa todo lo demás (`claveProducto`), así que sigue
// valiendo cuando se rehace el estudio o cambia el catálogo. Sobrevive a todo:
// es lo único del almanaque que no se recalcula.

/** Los ajustes de UNA fecha, con la forma completa aunque estén vacíos. */
export function ajustesDeFecha(ajustes, idFecha) {
  const a = (ajustes || {})[String(idFecha || '')] || {};
  return { suma: a.suma || {}, saca: a.saca || {} };
}

/** ¿Este producto está sacado a mano de esta fecha? */
export function estaSacado(ajustes, idFecha, clave) {
  return !!ajustesDeFecha(ajustes, idFecha).saca[clave];
}

/** ¿Está agregado a mano? */
export function estaSumado(ajustes, idFecha, clave) {
  return !!ajustesDeFecha(ajustes, idFecha).suma[clave];
}

/**
 * Aplica las correcciones del dueño a lo que calculó el sistema.
 *
 * Lo sacado se va aunque el motor insista; lo agregado entra aunque el motor no
 * lo haya visto, con la urgencia que le corresponda por su stock — y marcado
 * como puesto a mano, para que se distinga de lo que salió de los datos.
 *
 * `stockDe(clave, {nombre, color})` es el mismo de `recomendarParaTemporada`.
 */
export function aplicarAjustes(recomendaciones, ajustes, proxima, { stockDe } = {}) {
  const { suma, saca } = ajustesDeFecha(ajustes, proxima?.id);
  const out = (recomendaciones || []).filter(r => !saca[r.clave]);
  const yaEstan = new Set(out.map(r => r.clave));

  for (const [clave, datos] of Object.entries(suma)) {
    if (yaEstan.has(clave)) {
      // Ya lo trajo el motor: sólo se marca que además está confirmado a mano.
      const r = out.find(x => x.clave === clave);
      if (r) r.aMano = true;
      continue;
    }
    if (typeof stockDe !== 'function') continue;
    const info = stockDe(clave, { nombre: datos?.n || '', color: datos?.c || '' });
    if (!info) continue;   // ya no está en el catálogo
    const stock = Math.max(0, Number(info.stock) || 0);
    // Lo que se espera vender: lo que el dueño anotó, o lo que se vendió la vez
    // pasada si el estudio lo sabe. Sin ninguno de los dos, el stock de hoy
    // alcanza para que figure y él decide la cantidad.
    const esperado = Math.max(0, Number(datos?.u) || 0);
    out.push({
      clave,
      nombre: info.producto?.nombre || datos?.n || '',
      color: datos?.c || info.color || '',
      docId: info.docId,
      producto: info.producto || null,
      stock,
      esperado,
      empuje: 0,
      faltan: Math.max(0, esperado - stock),
      urgencia: urgenciaDeTemporada({
        empuje: EMPUJE_MINIMO,
        esperado: esperado > 0 ? esperado : Math.max(1, stock),
        stock,
        diasFaltan: proxima?.diasFaltan,
        plazoAviso: proxima?.plazoAviso,
      }),
      porPista: false,
      aMano: true,
      temporada: {
        id: proxima?.id, nombre: proxima?.nombre,
        fecha: proxima?.fecha, diasFaltan: proxima?.diasFaltan,
      },
    });
  }
  out.sort((a, b) => b.urgencia - a.urgencia || b.faltan - a.faltan);
  return out;
}

/** ¿El estudio guardado sirve todavía, o conviene rehacerlo? */
export function estudioVigente(estudio, hoyYmd, { vigenciaDias = ESTUDIO_VIGENCIA_DIAS } = {}) {
  if (!estudio || !estudio.hasta) return false;
  const d = diasEntre(String(estudio.hasta), String(hoyYmd || ''));
  return d >= 0 && d <= vigenciaDias;
}
