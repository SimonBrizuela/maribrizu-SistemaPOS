# Tienda online · estado al 10 de agosto de 2026

Tienda pública para Librería Liceo, conectada al catálogo del POS.
Código en `tienda/`, panel en `webapp/`, scripts de datos en `scripts/`.

```
cd tienda  && npm run dev     → http://localhost:5180
                                desde el celular: http://192.168.0.87:5180
cd tienda  && npm test        → 55 pruebas: buscador, envío, carrito, espejo
cd webapp  && npm run dev     → http://localhost:5173 · sección "Tienda"
python scripts/probar_tienda.py  → 20 pruebas contra las reglas, sin sesión
```

La tienda está publicada en **https://libreria-liceo.netlify.app**. Lo que hay
en esta carpeta desde el 8 de agosto todavía no se desplegó.

---

## Lo que está funcionando

**Tienda pública navegable.** Portada, catálogo con filtros y paginado, ficha de
producto, carrito. Vite + JavaScript a mano, sin framework. Pesa 17 kB de JS y
8 kB de CSS comprimidos, más Firebase en su propio bundle.

**2.315 productos publicados**, solo los que tienen stock. Se sincronizan del
catálogo del POS con `scripts/sync_tienda.py`.

**Venta por metro con cinta métrica** para los 350 productos que se cortan del
rollo (cintas, cordones, elástico, abrojo). Se arrastra con el dedo, con los
botones o escribiendo el largo exacto.

**Buscador con sugerencias** mientras se escribe, que además sabe en qué rubro
estás parado.

**Checkout andando.** Una sola pantalla con cuatro bloques: datos, retiro o
envío, efectivo o transferencia, y una nota. Revalida precios y stock contra la
base al entrar y otra vez al confirmar, y muestra lo que cambió en vez de
corregirlo en silencio. El pedido queda en `tienda_pedidos`.

**Pedido con código y seguimiento en vivo.** Código corto de cuatro caracteres
para decir por teléfono, sin las letras que se confunden al dictarlas. El estado
se actualiza solo mientras el cliente mira la pantalla. La lista de "mis
pedidos" sale de localStorage: las reglas no dejan listar la colección, y está
bien que no lo dejen, porque listarla sería entregar el teléfono y la dirección
de todos los clientes.

**Aviso automático de pedido nuevo**, por tres caminos porque cada uno falla en
un caso distinto: WhatsApp al local, y en la webapp de gestión sonido, toast que
no se va solo y notificación del navegador. La primera carga no dispara un aviso
por pedido, sale un resumen.

**Cálculo de envío y autocompletado de direcciones**, los dos contra funciones
de servidor. La clave de Google nunca viaja al navegador, así que no hace falta
partirla en dos.

Las sugerencias salen restringidas al área de reparto, no sesgadas hacia ella:
con sesgo, escribir la dirección del propio local traía primero la calle
homónima de Villa Carlos Paz, a 35 km. Y van con token de sesión, así todas las
teclas de un campo se facturan como una búsqueda en vez de una por tecla.

**El que escribe la dirección entera y no toca la lista también recibe su
cotización.** Al salir del campo se resuelve ese texto contra Places, y se
acepta solo si dice la misma altura y las mismas palabras que escribió. Cuando
es ambiguo se deja sin coordenadas y el envío queda a confirmar, en vez de
elegirle una dirección por él.

**Mapa con el local y el domicilio**, abajo del campo. Está para que el cliente
vea que la dirección que quedó cargada es la suya, sobre todo cuando la
resolvimos nosotros: de esa coordenada sale cuánto paga.

El fondo es una imagen de la Maps Static API, servida por
`netlify/functions/mapa.mjs` para que la clave no viaje al navegador. Los
marcadores los dibuja `src/mapa.js` encima, en violeta y rosa de la marca en vez
de los pines rojos de Google: como el centro y el zoom se calculan del lado de la
tienda, se sabe en qué píxel cae cada punto. Se apagan los puntos de interés y el
transporte, que competían con los dos marcadores que importan.

Se probó primero con mosaicos de OpenStreetMap por CARTO, que no necesitan clave.
**Se descartó: los basemaps de CARTO piden licencia Enterprise para uso comercial**
y esto es una tienda que vende. Google ya es el proveedor de las direcciones y del
envío, tiene 10.000 mapas por mes sin cargo y esta tienda no se acerca a ese
número. Cada imagen se cachea un día en el navegador y una semana en el CDN.

La función solo genera mapas a menos de 60 km del local. Sin ese cerrojo sería un
generador de mapas de cualquier parte del mundo con la clave de la librería.

**Permisos cerrados y verificados.** Probado contra la API REST sin sesión:
`tienda_productos` y `tienda_config` se leen; `catalogo`, `ventas`,
`perfiles_facturacion` y el listado de pedidos dan `PERMISSION_DENIED`. El
espejo no expone costo, margen ni proveedor.

**Sistema visual** en `tienda/design/`, con la paleta sacada del logo. Publicado
en claude.ai/design como "Librería Liceo — Tienda Online".

**Panel de administración**, en la webapp de gestión, sección "Tienda":

- *Pedidos* — la pantalla de mostrador que ya existía.
- *Catálogo de la tienda* — por producto: publicar, sacar o dejarlo librado al
  rubro; destacarlo en la portada; nombre público y descripción; fotos (subir,
  borrar, elegir la principal); si se vende por unidad o por metro; si se
  ofrece el pack entero y cómo se llama; y qué variedades salen y con qué
  nombre. Cada publicación dice a qué producto del catálogo está vinculada y se
  salta a editarlo allá con un botón para volver.
- *Configuración* — horarios, teléfono, dirección, aviso de portada, abrir y
  cerrar la tienda, tramos de envío por distancia, radio, envío gratis, alias y
  titular para transferir, y qué rubros salen a la web.

Lo que se decide en el panel son campos `tienda_*` dentro del producto del
catálogo: el POS no se entera y el sync los respeta. El precio y el stock
siguen saliendo del catálogo y solo de ahí, que es con lo que se cobra en el
mostrador. Cada cambio se espeja en `tienda_productos` al instante en vez de
esperar los 15 minutos del sync.

**El buscador entiende los conectores.** El índice no los guarda, así que "goma
de borrar" pedía un token `de` que no tiene ningún producto y devolvía cero con
21 gomas en el catálogo. Ahora la consulta se despieza con el mismo criterio que
el índice y se puntúa cuántas palabras coinciden en vez de exigirlas todas.

**Pruebas.** `npm test` en `tienda/` corre 55 casos sobre el buscador, los
tramos de envío, el carrito y el documento del espejo — este último comparando
lo que arma el panel (JavaScript) contra lo que arma el sync (Python) sobre los
mismos casos, porque son dos implementaciones de la misma regla y separarse
sería que la tienda cambie sola. `scripts/probar_tienda.py` pega contra las
reglas desde afuera, sin sesión.

---

## Errores encontrados y corregidos

Vale la pena tenerlos presentes porque varios eran de datos, no de código.

**Los precios estaban mal en 618 productos.** El catálogo guarda dos precios por
producto fraccionado: `precio_venta` es el rollo o la caja entera y
`conjunto_precio_unidad` es lo que sale uno. La tienda mostraba el primero. Un
metro de media perla figuraba a $23.800 cuando vale $1.200.

**El stock salía del campo equivocado.** `conjunto_total` cuenta unidades
vendibles; el campo `stock` cuenta packs cerrados. Un producto que figuraba con
225 tenía 246 unidades reales.

**Siete de cada diez productos no tenían stock.** De 7.648 publicables solo
2.315 tenían. Se publican únicamente esos.

**La coordenada del local estaba a 6,2 km.** Se había deducido suponiendo Villa
Cabrera; el local está en Parque Liceo 1ª Sección. Ya está verificada con Places
API sobre la dirección completa: `-31.3540169, -64.1734488`.

**El encabezado no se pegaba** aunque estaba escrito como `sticky`: el envoltorio
medía lo mismo que su contenido y no le dejaba margen para moverse.

---

## Lo que falta

### 0. Desplegar — es lo que bloquea todo lo demás

Al 10 de agosto el aviso de un pedido nuevo **no le llega a nadie**, por tres
cosas al mismo tiempo:

| Vía | Por qué no avisa |
|---|---|
| Tablero en la webapp | `posmr87.netlify.app` publicó por última vez el 2 de agosto; el tablero y el watcher son del 6. El bundle publicado no menciona `tienda_pedidos`. |
| WhatsApp al local | faltan las variables de CallMeBot en el sitio de la tienda |
| POS | no existe el listener de `tienda_pedidos` (nada en `pos_system/` lo nombra) |

Hay un solo pedido en la base, el `P5HE` del 7 de agosto, de prueba. No se
perdió ninguno real todavía.

También falta desplegar la tienda: el buscador arreglado, el nombre del pack, el
aviso de portada, el cierre y el reintento del chat están en esta carpeta y no
en el aire.

### 1. El aviso de WhatsApp

Las direcciones y el envío andan contra el servidor de verdad: probado con
`Rafael Núñez 4500`, que da $3.500 por 7,46 km, y con `Av Colón 4500` escrita
entera, que la resuelve sola y da fuera de radio con 14,83 km.

Falta el dominio propio, que se engancha desde el panel de Netlify.

Lo que todavía no sale es el aviso de WhatsApp al local, porque le faltan sus
variables. El pedido entra igual y aparece en el tablero de la webapp: nada de
esto bloquea el checkout, es a propósito.

Variables de entorno del sitio:

| Variable | Estado |
|---|---|
| `GOOGLE_ROUTES_KEY` | cargada — distancia real hasta el domicilio |
| `GOOGLE_PLACES_KEY` | cargada — autocompletado de direcciones |
| `GEMINI_API_KEY` | cargada — el asistente del catálogo |
| `CALLMEBOT_TELEFONO` + `CALLMEBOT_APIKEY` | falta — WhatsApp al local, la vía rápida |
| `WHATSAPP_TOKEN` + `WHATSAPP_PHONE_ID` + `WHATSAPP_DESTINO` | falta — la vía oficial de Meta |

Verificado el 10 de agosto con `npx netlify env:list --context production`.

Las dos de Google son la misma clave, la que estaba cargada en
`claves_google.txt` como `GOOGLE_CSE_KEY` de cuando se usaba para Custom Search.
Es "Clave de API 3" en el proyecto `mari-d7c71` y hoy tiene habilitados Places,
Routes, Maps Static y Custom Search.

Cuidado con esto: en Google Cloud **hay dos cosas que habilitar, no una**. La API
en el proyecto (`gcloud services enable static-maps-backend.googleapis.com`) y
además el servicio en las restricciones de la clave. Con la API habilitada pero
la clave restringida a Places y Routes, Static Maps devuelve `403 This API key is
not authorized to use this service`, que no se parece en nada al error de una API
sin habilitar.

Se publica con:

```
cd tienda && npm run build && npx netlify deploy --prod --dir=dist --functions=netlify/functions
```

Para CallMeBot el dueño le manda `I allow callmebot to send me messages` al
+34 644 51 95 23 y recibe su apikey. Es lo más rápido para arrancar; la Cloud
API de Meta es el camino formal y necesita cuenta de Business y plantilla
aprobada, porque fuera de la ventana de 24 horas solo deja mandar plantillas.

Las tres funciones leen lo que necesitan de Firestore por la API REST sin
credenciales, aprovechando que `tienda_config` es público y que un pedido se
puede leer sabiendo su id. No hay cuenta de servicio en el servidor de la
tienda.

También falta cargar el alias y el titular de la transferencia. Ya se cargan
desde el panel (Tienda › Configuración › Transferencia); mientras estén vacíos
el checkout dice que los datos se pasan al confirmar, en vez de mostrar un alias
en blanco.

### 2. Marcar los destacados

El panel ya lo permite, pero no hay ninguno marcado: hasta que lo haya, la
portada dice "Del catálogo" en vez de "Lo más pedido", que sería mentira.

### 3. POS: escuchar pedidos e imprimir el ticket de reparto

Listener de `tienda_pedidos` siguiendo el patrón de
`pos_system/ui/remote_terminal_listener.py`, con impresión automática vía
`ticket_printer.py`. Requiere bump de versión, tag y push.

El tablero de pedidos en la webapp ya está hecho (`webapp/src/pages/pedidos_tienda.js`),
y el watcher con sonido y notificación también (`webapp/src/pedidos_watcher.js`).
Los dos esperan el despliegue de la webapp.

### 4. El dominio propio

El sitio está publicado en `libreria-liceo.netlify.app`. Falta engancharle el
dominio definitivo desde el panel de Netlify.

### 5. Mercado Libre

Quedó **dentro del alcance comercial** junto con la tienda. Todavía no está
empezado. Son cinco piezas: alta de la cuenta, publicación de hasta 150 productos
con categoría y atributos, sincronización de stock desde el POS, entrada de
pedidos al mismo tablero que ya existe, y un panel en la web de gestión.

La lista de los 110 candidatos reales está en `FOTOS_MERCADOLIBRE.xlsx`, cruzando
precio, margen y rotación, con el precio sugerido de ML que conserva la ganancia
en pesos. No está en el repositorio: tiene datos comerciales del cliente y el
repositorio es público.

**Antes de publicar nada hay que verificar el precio de mercado.** La planilla
dice dónde se gana plata, no dónde se vende. La API pública de Mercado Libre
devuelve `403` sin autenticación, así que esa comparación se hace recién con la
cuenta abierta.

Dos cosas medidas que conviene no olvidar: el punto de equilibrio está en **$4.800**
—abajo de eso cada venta deja pérdida— y **los dos formularios de automotor son el
43% de la facturación de la lista**, con demanda que probablemente sea solo local.

---

## Las fotos

**Cargadas automáticamente.** Al 6 de agosto van unos 2.000 productos con foto
de los 2.315 publicados.

```
python scripts/fotos_auto.py --cantidad 1300
→ abre http://localhost:8770 y va mostrando lo que sube, en vivo
```

Busca, puntúa, elige, achica y sube sola, y al mismo tiempo levanta un servidor
local donde se ve lo que va subiendo. Desde ahí se descarta una foto, se pide la
siguiente candidata, o se bloquea un sitio entero cuando estampa marca de agua
—eso último cambia de una todas las fotos que hayan salido de ese dominio y
guarda el dominio en `scripts/sitios_bloqueados.txt`.

Al arrancar carga también los productos que ya tienen foto, así reiniciar el
script no deja fuera de la pantalla lo subido antes.

Lo que no llega al puntaje mínimo se sube igual en una segunda pasada, marcado
como "revisar". Es preferible una foto floja señalada que un hueco, y quien
revisa decide.

**Falta el repaso a mano.** Las fotos salen de sitios de otras tiendas, buscadas
por el nombre del producto. La mayoría acierta pero algunas no, y ese repaso lo
tiene que hacer alguien que conozca el catálogo.

**Los juguetes que se llaman como un arma tienen su propio filtro.** Decir
"juguete" adelante de la consulta no alcanzaba: "Ametralladora 639" había
quedado con dos fusiles negros y "Pistola Lanza Corcho" con una escopeta sobre
una cama, de un clasificado. Ahora la candidata tiene que decir que es un
juguete —en el título o en el sitio— o se descarta, y quedarse sin foto es
preferible. Están bloqueadas además las armerías, los clasificados de segunda
mano, los bancos de imagen y los sitios de cine: "Arrastre Auto JP0219 Baby
Driver" se había traído un fotograma de la película.

### Por qué no se pueden usar en Mercado Libre

Publicar ahí con fotos de otro vendedor termina en denuncia y publicación dada de
baja. Para Mercado Libre hacen falta fotos propias, fondo blanco y varios
ángulos.

Está medido por qué no se pueden conseguir de forma automática:

- **7 de 2.315 productos tienen código de barras real.** El resto son códigos
  internos del POS (`1000015`, `900420`) que no pasan el dígito verificador. Sin
  identificador global no hay base externa que consultar. Esta es la razón de
  fondo.
- 305 marcas distintas, y el 39% de los productos con stock no tiene marca. Las
  25 marcas más grandes cubren el 29%.
- Buscar por nombre sobre miles de productos va a errar, y una foto equivocada le
  llega al cliente y vuelve como devolución.

### Lo que sí funciona

```
python scripts/lista_fotos.py
```
Genera `FOTOS_PENDIENTES.xlsx` cruzando el catálogo con las ventas reales, para
saber por cuáles empezar. Ordenado por facturación, no por unidades: cien gomas
mueven menos que diez mochilas.

```
python scripts/importar_fotos.py fotos/
```
Carpeta con archivos nombrados por código (`105894.jpg`). Achica a 900 px, pasa a
WebP, corrige la orientación EXIF y sube. Probado: 664 KB → 21 KB, 97% menos.

Los primeros para fotografiar, por lo que facturan:

```
$1.676.600   Formulario Automotor 12
$1.170.700   Formulario Automotor 08
$  214.600   Formulario Moto 12
$  147.900   Cono de Hilo 2000MTS Importado
$  111.800   Legos Chicos
```

Proveedores a los que conviene pedirles: **CBX** ($630k, 86 productos),
**Sabonis** ($563k, 80), **Energizer** ($394k, 11), **Triunfante** ($331k, 21),
**Cisne** ($314k, 5). Energizer y Cisne son marcas grandes con catálogo propio:
esas dos llamadas resuelven 16 productos que facturan $700 mil.

---

## La Custom Search API quedó descartada

Se abandonó después de agotar todas las variables. Siempre el mismo error:

```
403 PERMISSION_DENIED
This project does not have the access to Custom Search JSON API.
```

| Variable | Lo que se probó |
|---|---|
| Proyecto | Mari, uno nuevo (Liceo Fotos) y uno nuevo con cuenta personal |
| Cuenta | `programacion@brizuela.org` y un Gmail personal |
| Organización | Dentro de `brizuela.org` y sin organización |
| Buscador (`cx`) | Dos motores distintos |
| Clave | Cuatro, una de ellas por el asistente "Get a Key" |
| API habilitada | Confirmado en consola, con tráfico contado en las métricas |

Dos hipótesis intermedias resultaron falsas y conviene dejarlas anotadas para no
volver a caer:

- **"Es el proyecto Mari"**: no. Un proyecto nuevo da lo mismo.
- **"Es el buscador"**: no. Parecía serlo porque un `cx` inventado devuelve
  `400 invalid argument` y el nuestro `403`, pero ese 400 es solo validación de
  formato: nunca llega al control de permisos. Un `cx` nuevo da el mismo 403.

Lo único que comparten los tres proyectos es no tener facturación vinculada.
Puede ser eso, pero no se verificó: a esa altura ya no valía la pena. La API de
búsqueda es intercambiable y el cuello de botella real son las fotos, no de
dónde salen las candidatas.

**Se reemplazó por Serper** (`serper.dev`), que devuelve resultados de imágenes
de Google por API, no depende de Google Cloud y trae 2.500 consultas gratis.
`buscar_fotos.py` solo cambió de endpoint: armar la consulta desde el nombre y
la marca, filtrar marketplaces y guardar el avance quedó igual.

```
python scripts/buscar_fotos.py --cantidad 300 --solo-con-marca
→ abrir scripts/revisar_fotos.html y elegir cuál sirve de cada una
python scripts/importar_fotos.py --aprobadas fotos_aprobadas.json
```

La revisión es a mano a propósito. "Cono de Hilo 2000MTS Importado" va a traer
cualquier cosa.

---

## Datos y credenciales

`claves_google.txt` en la raíz (está en `.gitignore`):

```
GOOGLE_CSE_KEY   clave de Places + Routes
SERPER_API_KEY   búsqueda de imágenes para las fotos
```

La misma clave de Google sirve para Places y Routes y no hace falta partirla en
dos: las dos se llaman desde funciones de servidor, así que ninguna necesita
restricción por dominio. Esa era la razón de tener que separarlas.

Proyecto de Google Cloud: **Mari** (`mari-d7c71`).
APIs habilitadas: Places API (New) y Routes API. Custom Search quedó descartada.

### Colecciones nuevas en Firestore

| Colección | Qué guarda | Quién escribe |
|---|---|---|
| `tienda_productos` | espejo público del catálogo | `sync_tienda.py` |
| `tienda_config/settings` | horarios, tramos de envío, origen | `seed_tienda_config.py` |
| `tienda_config/publicacion` | rubros habilitados | el panel (Tienda › Configuración) |
| `tienda_config/rubros` | conteo por rubro para la portada | `sync_tienda.py` |
| `tienda_pedidos` | pedidos | la tienda (validado en las reglas) |

### Lo que el panel guarda en el catálogo

Todo vive dentro del documento del producto en `catalogo`, así que el POS no se
entera y el sync lo respeta. Un campo ausente es "automático", que no es lo
mismo que estar en falso.

| Campo | Qué decide |
|---|---|
| `tienda_publicar` | `true` publica siempre, `false` nunca, ausente sigue al rubro |
| `tienda_destacado` | aparece en la portada |
| `tienda_nombre` | nombre público, en vez del del POS prolijado |
| `tienda_descripcion` | el texto abajo del precio |
| `tienda_imagenes` | las fotos, la primera es la principal |
| `tienda_unidad` | `metro` o `unidad`, cuando el POS lo dedujo mal |
| `tienda_ofrecer_pack` | si se ofrece el rollo o la caja entera |
| `tienda_pack_nombre` | cómo se llama ese pack de cara al cliente |
| `tienda_variedades` | por color: si se publica y con qué nombre. La clave es el nombre del catálogo normalizado, porque el visible cambia |

El precio y el stock **no** están en esta lista a propósito: salen del catálogo
y solo de ahí, que es con lo que se cobra en el mostrador.

### Scripts

```
scripts/sync_tienda.py         catálogo → espejo público (--simular para probar)
scripts/sync_tienda.bat        la corrida de la tarea programada, con log
scripts/instalar_sync.ps1      instala la tarea cada 15 min (y la saca con -Quitar)
scripts/probar_tienda.py       20 pruebas contra las reglas, sin sesión
scripts/casos_espejo.py        salida del sync, para compararla con la del panel
scripts/seed_tienda_config.py  configuración inicial de la tienda
scripts/lista_fotos.py         Excel priorizado de fotos pendientes
scripts/buscar_fotos.py        busca candidatas por nombre (Serper)
scripts/revisar_fotos.html     página para elegir cuál sirve
scripts/importar_fotos.py      sube fotos a Storage y las publica
tienda/design/build.mjs        genera las previsualizaciones del design system
tienda/design/contraste.mjs    verifica el contraste de todos los pares de color
```

### Funciones de servidor

```
tienda/netlify/functions/envio.mjs           distancia real con Routes + tramos
tienda/netlify/functions/direcciones.mjs     autocompletado con Places
tienda/netlify/functions/avisar-pedido.mjs   WhatsApp al local
tienda/netlify/functions/mapa.mjs            el mapa del checkout, sin exponer la clave
tienda/netlify/functions/asistente.mjs       el chat del catálogo (Gemini)
```

### La tarea programada del sync

Corre cada 15 minutos desde el Programador de tareas de Windows, en la PC del
local. Se instala **una vez**, con permisos de administrador:

```
powershell -ExecutionPolicy Bypass -File scripts\instalar_sync.ps1
```

Necesita `firebase_key.json` en la raíz y Python en el PATH; el instalador
verifica las dos cosas antes de crear la tarea. El log queda en
`logs/sync_tienda.log` y se recorta solo a los 2 MB.

Quince minutos y no cinco porque el sync reescribe los 2.400 documentos
publicados en cada corrida: son 230 mil escrituras por mes contra 690 mil. El
desfasaje no llega al cliente igual, porque el checkout revalida precio y stock
contra la base antes de confirmar.
