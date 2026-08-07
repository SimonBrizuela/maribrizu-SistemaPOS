# Tienda online · estado al 6 de agosto de 2026

Tienda pública para Librería Liceo, conectada al catálogo del POS.
Código en `tienda/`, scripts de datos en `scripts/`.

```
cd tienda && npm run dev      → http://localhost:5180
                                desde el celular: http://192.168.0.87:5180
```

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
resolvimos nosotros: de esa coordenada sale cuánto paga. Son mosaicos de
OpenStreetMap posicionados a mano (`tienda/src/mapa.js`), sin librería de mapas
ni clave: la Maps Static API de Google no está habilitada en el proyecto y
habilitarla sería una llamada facturada por cada checkout abierto.

**Permisos cerrados y verificados.** Probado contra la API REST sin sesión:
`tienda_productos` y `tienda_config` se leen; `catalogo`, `ventas`,
`perfiles_facturacion` y el listado de pedidos dan `PERMISSION_DENIED`. El
espejo no expone costo, margen ni proveedor.

**Sistema visual** en `tienda/design/`, con la paleta sacada del logo. Publicado
en claude.ai/design como "Librería Liceo — Tienda Online".

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

### 1. Desplegar la tienda — es lo que sigue

El checkout está escrito y las tres funciones también, pero hasta que no haya un
sitio de Netlify no hay servidor que las ejecute. Sin eso la tienda cotiza el
envío como "a confirmar" y no salen los avisos de WhatsApp. El pedido entra
igual: nada de esto bloquea el checkout, es a propósito.

Sitio de Netlify aparte del de la webapp, con `tienda/netlify.toml` que ya está.
Falta definir el dominio.

Variables de entorno del sitio:

| Variable | Para qué |
|---|---|
| `GOOGLE_ROUTES_KEY` | distancia real hasta el domicilio |
| `GOOGLE_PLACES_KEY` | autocompletado de direcciones (si falta usa la de Routes) |
| `CALLMEBOT_TELEFONO` + `CALLMEBOT_APIKEY` | WhatsApp al local, la vía rápida |
| `WHATSAPP_TOKEN` + `WHATSAPP_PHONE_ID` + `WHATSAPP_DESTINO` | la vía oficial de Meta |

Para CallMeBot el dueño le manda `I allow callmebot to send me messages` al
+34 644 51 95 23 y recibe su apikey. Es lo más rápido para arrancar; la Cloud
API de Meta es el camino formal y necesita cuenta de Business y plantilla
aprobada, porque fuera de la ventana de 24 horas solo deja mandar plantillas.

Las tres funciones leen lo que necesitan de Firestore por la API REST sin
credenciales, aprovechando que `tienda_config` es público y que un pedido se
puede leer sabiendo su id. No hay cuenta de servicio en el servidor de la
tienda.

También falta cargar `pago.alias` y `pago.titular` en `tienda_config/settings`.
Sin eso el checkout dice que los datos de la transferencia se pasan al
confirmar, en vez de mostrar un alias vacío.

### 2. Panel de administración

- Interruptor "Publicar en tienda" por producto
- Marcar destacados. Hasta que haya alguno, la portada dice "Del catálogo" en vez
  de "Lo más pedido", que sería mentira
- Nombre público y descripción, para arreglar los nombres internos del POS
- Subida de fotos desde el panel
- Configuración de la tienda: horarios, tramos de envío, radio

### 3. POS: escuchar pedidos e imprimir el ticket de reparto

**Es lo único que falta del circuito de pedidos.** Listener de `tienda_pedidos`
siguiendo el patrón de `pos_system/ui/remote_terminal_listener.py`, con impresión
automática vía `ticket_printer.py`. Requiere bump de versión, tag y push.

El tablero de pedidos en la webapp ya está hecho (`webapp/src/pages/pedidos_tienda.js`),
y el watcher con sonido y notificación también (`webapp/src/pedidos_watcher.js`).

### 4. Deploy

Sitio de Netlify aparte para la tienda, con `tienda/netlify.toml` que ya está.
Falta definir el dominio.

**Ya no hace falta separar la clave de Google en dos.** Places y Routes se llaman
las dos desde funciones de servidor, así que ninguna necesita restricción por
dominio y alcanza con una sola clave.

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
| `tienda_config/publicacion` | rubros habilitados | a mano |
| `tienda_config/rubros` | conteo por rubro para la portada | `sync_tienda.py` |
| `tienda_pedidos` | pedidos | la tienda (validado en las reglas) |

### Scripts

```
scripts/sync_tienda.py         catálogo → espejo público (--simular para probar)
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
```

El sync está pensado para correr cada 15 minutos desde el Programador de tareas
de Windows en la PC del local. **Todavía no está agendado.**
