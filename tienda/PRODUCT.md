# Producto — Tienda Librería Liceo

Escrito a partir de lo que ya existe: `TIENDA_ESTADO.md`, `design/tokens.css`,
`design/components.css` y el código de `src/`. No son intenciones, es lo que la
tienda hace hoy.

## Register

`product` — la tienda es una herramienta de compra, no una pieza de campaña. El
diseño está al servicio de que alguien encuentre un cuaderno y lo pida. La
excepción es la portada, que sí es marca.

## Qué es

Tienda online de Librería Liceo, una librería de barrio en Parque Liceo 1ª
Sección, Córdoba. Es el espejo público del catálogo del sistema de punto de
venta que usa el local: 2.315 productos con stock real, sincronizados desde el
POS. Vive en `libreria-liceo.netlify.app`.

Vende librería, papelera, mercería, regalería, juguetería y perfumería. Entrega
retirando por el local o con reparto propio en moto hasta 12 km.

## Quién la usa

**Madres y padres comprando útiles**, casi siempre desde el celular, casi
siempre apurados y muchas veces con la lista del colegio en la mano. No son
compradores de tecnología: la mitad de los pedidos entra hoy por WhatsApp
mandando una foto de la lista. La tienda compite contra eso, no contra Amazon.

**Gente del barrio que ya conoce el local.** Vienen sabiendo que la librería
existe y que está a diez cuadras. El sitio les tiene que ahorrar el viaje o
confirmarles que vale la pena hacerlo, no venderles la marca.

Consecuencia directa: nadie se crea una cuenta. No hay registro, no hay
contraseñas. El carrito vive en el navegador y los pedidos se siguen con un
código corto de cuatro caracteres que se puede dictar por teléfono.

## Tono

El del local, no el de un e-commerce. La tienda le habla a alguien que va a
entrar por la puerta la semana que viene.

- **Se dice lo que pasa, no lo que suena bien.** "Nos quedamos sin lo que
  tenías" en vez de "producto no disponible". "Es todo lo que hay" en vez de
  "stock máximo alcanzado".
- **Nada se corrige en silencio.** Si el precio cambió mientras armaba el
  pedido, se le muestra el precio viejo y el nuevo. Enterarse cuando llega el
  ticket es la peor forma de enterarse.
- **Voseo, sin solemnidad y sin chistes.** "Decilo cuando vengas o cuando nos
  escribas."
- **Cero emojis.** Los iconos son SVG del mismo juego, con la misma grilla y el
  mismo grosor de trazo.

## Principios

1. **El checkout no se rompe nunca.** Todo lo que depende de un servicio externo
   degrada solo: si el autocompletado de direcciones no responde, el campo
   queda como texto libre y el pedido entra igual con el envío a confirmar. Un
   pedido que no entra es plata que no entró.
2. **La plata se explica.** Cada número que el cliente paga tiene que poder
   rastrearse hasta algo que él vio. Por eso el mapa del checkout: si la
   coordenada la resolvimos nosotros a partir de lo que escribió, la tiene que
   poder mirar antes de confirmar.
3. **Peso primero.** Se compra desde un celular en la calle. 17 kB de JS propio
   y 8 kB de CSS comprimidos, sin framework. Cada dependencia se justifica o no
   entra.
4. **El local no es un almacén anónimo.** La dirección, los horarios y el
   WhatsApp están a un toque en todas las pantallas. Si algo falla, hay alguien
   del otro lado.

## Anti-referencias

- **El e-commerce plantilla.** Blanco, gris, azul, sombras suaves iguales en
  todo, tarjetas idénticas en grilla. La marca ya tiene identidad propia y
  fuerte; usar una paleta genérica sería tirarla.
- **El seguimiento de courier.** Barras de progreso con porcentajes inventados,
  mapas de camiones moviéndose, tiempos estimados al minuto. Acá reparte una
  moto del local y la verdad es "24 a 48 hs".
- **La celebración desmedida.** Confeti, "¡Felicitaciones por tu compra!",
  ilustraciones de cajas volando. Compró un cuaderno.
- **Los grandes marketplaces.** Densidad extrema, badges de urgencia, contadores
  regresivos, "quedan 2". No es el negocio.

## CORS del bucket de fotos

Las fotos del catálogo se sirven desde Firebase Storage con `<img src>` pelado,
que no pasa por CORS: hoy no hay nada roto. Lo que el bucket no tiene es
`Access-Control-Allow-Origin` en el GET (medido: la respuesta viene sin la
cabecera; el preflight OPTIONS sí contesta `*`, que es por lo que el SDK sube
comprobantes sin problema).

Conviene ponerlo igual, porque el día que algo lea los bytes de una foto —un
canvas, un `fetch`, un service worker— va a fallar sin ninguna pista:

    gcloud storage buckets update gs://mari-d7c71.firebasestorage.app \
      --cors-file=tienda/storage-cors.json

Con la cuenta `programacion@brizuela.org`, que es la que tiene permisos sobre el
proyecto. Los orígenes están en `tienda/storage-cors.json`; si aparece un
dominio nuevo hay que agregarlo ahí y volver a correr el comando, que pisa la
lista entera.
