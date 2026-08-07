# Sistema visual — Tienda Librería Liceo

Generado desde `design/tokens.css` y `design/components.css`, que son la fuente
de verdad. Si algo de acá y un token no coinciden, gana el token.

Las previsualizaciones se construyen con `npm run disenio` y quedan en
`design/dist/`. El contraste se verifica con `npm run contraste`: los ratios que
aparecen anotados en los tokens están medidos, no estimados.

## Color

**Estrategia: committed.** La paleta sale del logo, cinco fichas de color sobre
negro, y esa tensión es la marca. No se usó una paleta de e-commerce genérica.

| Rol | Token | Valor |
|---|---|---|
| Primario | `--primary` / `--liceo-violeta` | `#7B3FA6` |
| Marca | `--liceo-verde` `--liceo-naranja` `--liceo-cyan` `--liceo-rojo` | del logo |
| Sexto | `--liceo-rosa` | `#B93A78`, punto medio entre el rojo y el violeta |

Los seis colores tienen tres variantes cada uno y **no son intercambiables**:

- `--liceo-X` — superficie. Bloques, fichas, rellenos. Nunca texto sobre claro.
- `--liceo-X-txt` — texto sobre fondo claro. Oscurecido para llegar a 4,5:1.
- `--liceo-X-bg` — tinte suave. Fondo de badge o de estado.
- `--liceo-X-tinta` — qué color va encima cuando el color es relleno. Blanco
  sobre violeta y rosa; `--ink` sobre verde, naranja, cyan y rojo, que son
  luminosos.

Poner texto con `--liceo-verde` sobre fondo claro da 1,9:1 y no se lee. Es el
error que estas variantes existen para prevenir.

**Ningún neutro es gris puro ni blanco puro.** Todos llevan una gota de violeta.
`--surface` es `#FEFDFF`, `--bg` es `#FAF8FB`.

**El marco va sobre negro.** Encabezado, portada y pie usan `--ink-superficie`
(`#0E0D10`). El catálogo queda claro porque los productos necesitan fondo neutro.
Esos tokens no cambian entre modo claro y oscuro.

**Estados** en tres piezas que no se mezclan: `--exito` (texto), `--exito-solido`
(relleno), `--exito-tinta` (encima del relleno). Igual para `--alerta` y
`--error`.

## Modo oscuro

`:root[data-tema="oscuro"]`. No es el claro invertido: los colores de marca se
desaturan para no vibrar sobre fondo oscuro y los textos de color usan versiones
claras. Todo lo nuevo tiene que verse en los dos.

## Tipografía

- **Rubik** (`--font-titulo`) — títulos, precios, códigos. Geométrica y redonda,
  es lo más cercano a la del logo.
- **Nunito Sans** (`--font-texto`) — texto. Legible en pantalla chica y de tono
  cálido, que es lo que separa una librería de barrio de un marketplace.

Escala: `--t-xs` 12 · `--t-sm` 14 · `--t-base` 16 · `--t-md` 18 · `--t-lg` 22 ·
`--t-xl` 28 · `--t-2xl` 36 · `--t-hero` fluido.

En móvil el texto base nunca baja de 16 px: iOS hace zoom solo en los campos.

Pesos 400 / 500 / 600 / 700. Alturas de línea 1,15 títulos · 1,5 texto · 1,7
párrafos largos. Ancho de lectura `--ancho-texto`, 68ch.

## Espaciado, radios, elevación

Rejilla de 4: `--e-1` 4 hasta `--e-9` 96. Radios `--r-sm` 8 · `--r-md` 12 ·
`--r-lg` 16 · `--r-xl` 24 · `--r-full`. Cuatro sombras, `--s-1` a `--s-4`.

## Movimiento

Una sola curva de entrada, `--curva` = `cubic-bezier(.22, 1, .36, 1)`. Lo que
sale va más rápido que lo que entra: `--m-salida` 150ms contra `--m-normal`
220ms. Sin rebote.

## Iconos

SVG inline en `src/iconos.js`. Grilla de 24, trazo de 2, terminaciones
redondeadas, `currentColor`. **Nunca emojis**: dependen de la fuente del sistema
y no se pueden pintar con los tokens.

## Controles

`--borde-control` (`#8C8398`) va aparte del borde decorativo. En un campo el
contorno *es* lo que lo identifica como algo con lo que se puede interactuar, y
WCAG pide 3:1; el borde de una card es decorativo y no tiene ese requisito.

## Reglas propias del proyecto

- El componente vive en `design/components.css`; la composición de pantalla, en
  `src/estilos/app.css`.
- Cada componente nuevo entra también en `design/previews/`, o la
  previsualización queda mintiendo.
- Nada de cards anidadas.
- Nada de emojis, ni en la interfaz ni en el copy.
