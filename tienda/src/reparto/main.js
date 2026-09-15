/**
 * Arranque de la pantalla del repartidor (`reparto.html`, en `/reparto`).
 *
 * Es una página aparte de la tienda: sin encabezado, carrito ni chat, con su
 * propia sesión de Firebase. Acá solo se enchufan las piezas de verdad.
 */
import '../estilos/app.css';
import '../estilos/reparto.css';
import { iniciarReparto } from './app.js';
import * as sesion from './sesion.js';
import { mover, ubicacion } from './servicios.js';
import { montarMapaRuta } from './mapa_ruta.js';
import { achicarFoto } from '../fotos_reclamo.js';

iniciarReparto(document.getElementById('reparto'), {
  sesion,
  mover,
  ubicacion,
  mapa: montarMapaRuta,
  achicar: achicarFoto,
});
