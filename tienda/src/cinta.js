/**
 * Cinta métrica para los productos que se venden cortados del rollo.
 *
 * Un contador de "1, 2, 3" no dice nada cuando lo que se compra es una
 * longitud. Acá se ve una cinta de medir desplazándose bajo una marca fija,
 * igual que cuando la vendedora estira el metro sobre el mostrador: el número
 * grande está para leerlo, la cinta está para entenderlo.
 *
 * Se arrastra con el dedo o se ajusta con los botones. El paso es medio metro,
 * que es como se corta en el local.
 */
import { icono } from './iconos.js';

const PX_METRO = 88;
const PASO = 0.5;

/**
 * @param {HTMLElement} caja      dónde se dibuja
 * @param {object} opciones
 * @param {number} opciones.max   metros disponibles
 * @param {number} [opciones.valor=1]
 * @param {(metros:number)=>void} opciones.alCambiar
 */
export function montarCinta(caja, { max, valor = 1, alCambiar }) {
  const tope = Math.max(PASO, Math.floor(max / PASO) * PASO);
  let metros = Math.min(tope, Math.max(PASO, valor));

  // Se dibujan las marcas de metro entero hasta un poco más allá del tope, para
  // que al llegar al final la cinta no termine en el vacío.
  const marcas = [];
  for (let m = 0; m <= Math.ceil(tope) + 1; m++) {
    marcas.push(
      `<span class="cinta__metro" style="left:${m * PX_METRO}px"><span>${m}</span></span>`);
  }

  caja.innerHTML = `
    <div class="cinta cinta--animada" role="slider" tabindex="0"
         aria-label="Cuántos metros llevás"
         aria-valuemin="${PASO}" aria-valuemax="${tope}"
         aria-valuenow="${metros}" aria-valuetext="${texto(metros)}">
      <div class="cinta__regla" style="width:${(Math.ceil(tope) + 2) * PX_METRO}px">
        ${marcas.join('')}
      </div>
      <div class="cinta__cursor"></div>
    </div>

    <div class="cinta-control">
      <button class="contador__boton" data-menos aria-label="Medio metro menos"
              style="border:1.5px solid var(--borde-control);border-radius:var(--r-full);width:44px;height:44px">
        ${icono('menos', { tam: 18, grosor: 2.5 })}
      </button>
      <label class="solo-lectores" for="cinta-metros">Metros que llevás</label>
      <input class="cinta-valor" id="cinta-metros" data-valor
             type="text" inputmode="decimal" autocomplete="off"
             aria-describedby="cinta-ayuda">
      <button class="contador__boton" data-mas aria-label="Medio metro más"
              style="border:1.5px solid var(--borde-control);border-radius:var(--r-full);width:44px;height:44px">
        ${icono('mas', { tam: 18, grosor: 2.5 })}
      </button>
    </div>
    <p class="cinta-ayuda" id="cinta-ayuda">
      Arrastrá la cinta, usá los botones, o escribí el largo exacto.
    </p>`;

  const cinta = caja.querySelector('.cinta');
  const regla = caja.querySelector('.cinta__regla');
  const salida = caja.querySelector('[data-valor]');
  const menos = caja.querySelector('[data-menos]');
  const mas = caja.querySelector('[data-mas]');

  function texto(m) {
    return `${m.toFixed(1).replace('.', ',')} metros`;
  }

  function pintar(avisar = true) {
    regla.style.transform = `translateX(${-metros * PX_METRO}px)`;
    // No se pisa lo que la persona esta escribiendo: si esta con el campo
    // enfocado, el valor se actualiza recien cuando termina.
    if (document.activeElement !== salida) {
      salida.value = metros.toFixed(1).replace('.', ',');
    }
    menos.disabled = metros <= PASO;
    mas.disabled = metros >= tope;
    cinta.setAttribute('aria-valuenow', String(metros));
    cinta.setAttribute('aria-valuetext', texto(metros));
    if (avisar) alCambiar(metros);
  }

  function fijar(nuevo, redondear = true) {
    const bruto = redondear ? Math.round(nuevo / PASO) * PASO : nuevo;
    const acotado = Math.min(tope, Math.max(PASO, bruto));
    // Los flotantes dejan restos tipo 2.4000000000000004; un decimal alcanza
    // para medio metro y evita que el precio salga con centavos fantasma.
    const limpio = Math.round(acotado * 10) / 10;
    if (limpio === metros) return;
    metros = limpio;
    pintar();
  }

  menos.addEventListener('click', () => fijar(metros - PASO));
  mas.addEventListener('click', () => fijar(metros + PASO));

  // ── Escribirlo a mano ──────────────────────────────────────────────────────
  // Los botones y el arrastre van de a medio metro, que es como se corta. Pero
  // si alguien necesita 12,3 m, llegar arrastrando es una tortura. Escrito se
  // acepta hasta el decimo de metro, que es la marca mas chica de la cinta.
  salida.addEventListener('focus', () => salida.select());

  function leerEscrito() {
    // Acepta coma o punto: en el celular el teclado numerico da lo que da, y
    // rechazar la coma en Argentina es rechazar la mitad de lo que se tipea.
    const n = parseFloat(String(salida.value).replace(',', '.').replace(/[^\d.]/g, ''));
    if (!Number.isFinite(n)) {
      salida.value = metros.toFixed(1).replace('.', ',');
      return;
    }
    const acotado = Math.min(tope, Math.max(PASO, Math.round(n * 10) / 10));
    metros = acotado;
    pintar();
    // Si se paso del rollo, se avisa en vez de corregir en silencio: quien
    // pidio 40 m tiene que enterarse de que hay 23.
    if (n > tope) {
      salida.setAttribute('aria-invalid', 'true');
      caja.querySelector('.cinta-ayuda').textContent =
        `En el rollo quedan ${tope.toFixed(1).replace('.', ',')} m. Lo ajustamos a eso.`;
    } else {
      salida.removeAttribute('aria-invalid');
      caja.querySelector('.cinta-ayuda').textContent =
        'Arrastrá la cinta, usá los botones, o escribí el largo exacto.';
    }
  }

  salida.addEventListener('blur', leerEscrito);
  salida.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); leerEscrito(); salida.blur(); }
  });

  // ── Arrastre ───────────────────────────────────────────────────────────────
  // Durante el arrastre la cinta sigue al dedo sin transición: con transición
  // va siempre un paso atrás y se siente pegajosa. Al soltar, se acomoda al
  // medio metro más cercano con la animación puesta.
  let arrastrando = false;
  let xInicial = 0;
  let metrosInicial = 0;

  cinta.addEventListener('pointerdown', ev => {
    arrastrando = true;
    xInicial = ev.clientX;
    metrosInicial = metros;
    cinta.classList.remove('cinta--animada');
    cinta.setPointerCapture(ev.pointerId);
  });

  cinta.addEventListener('pointermove', ev => {
    if (!arrastrando) return;
    // Arrastrar hacia la izquierda estira más cinta, que es como se mueve un
    // metro de verdad.
    fijar(metrosInicial - (ev.clientX - xInicial) / PX_METRO, false);
  });

  function soltar() {
    if (!arrastrando) return;
    arrastrando = false;
    cinta.classList.add('cinta--animada');
    fijar(metros);   // se acomoda al medio metro
    pintar();
  }
  cinta.addEventListener('pointerup', soltar);
  cinta.addEventListener('pointercancel', soltar);

  // ── Teclado ────────────────────────────────────────────────────────────────
  cinta.addEventListener('keydown', ev => {
    const saltos = {
      ArrowRight: PASO, ArrowUp: PASO,
      ArrowLeft: -PASO, ArrowDown: -PASO,
      PageUp: 1, PageDown: -1,
    };
    if (ev.key === 'Home') { ev.preventDefault(); return fijar(PASO); }
    if (ev.key === 'End') { ev.preventDefault(); return fijar(tope); }
    if (!(ev.key in saltos)) return;
    ev.preventDefault();
    fijar(metros + saltos[ev.key]);
  });

  pintar(false);
  alCambiar(metros);

  return { valor: () => metros };
}
