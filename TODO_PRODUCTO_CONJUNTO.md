# TODO — Conectar Producto Conjunto al POS y a Ventas

## Estado actual (2026-04-25)

Ya implementado en la **webapp** (`webapp/src/pages/catalogo.js`):

- Modal de edición de producto tiene el bloque violeta **PRODUCTO CONJUNTO**
- Al activarlo guarda en Firestore (colección `catalogo`):
  - `es_conjunto: bool`
  - `conjunto_tipo: 'rollo' | 'pack' | 'caja' | 'bobina' | 'bolsa' | 'plancha' | 'otro'`
  - `conjunto_unidad_medida: 'metros' | 'unidades' | 'gramos' | 'kilos' | 'litros' | 'cm'`
  - `conjunto_unidades: number` — cantidad de packs/rollos enteros
  - `conjunto_contenido: number` — cuánto trae cada uno (ej: 100 metros)
  - `conjunto_restante: number | null` — sobrante en el rollo abierto (opcional)
  - `conjunto_precio_unidad: number | null` — precio por metro/unidad fraccionada (opcional)
  - `conjunto_total: number` — calculado: `(unidades_cerradas × contenido) + restante`

Falta conectar todo al POS de escritorio (`pos_system/`) y al flujo de ventas.

---

## PROMPT DE CONTINUACIÓN

> Quiero que conectes la funcionalidad **"Producto Conjunto"** al POS de escritorio
> (`pos_system/`) y al flujo de ventas. Ya está cargada y guardada en Firebase
> (campos `es_conjunto`, `conjunto_tipo`, `conjunto_unidad_medida`,
> `conjunto_unidades`, `conjunto_contenido`, `conjunto_restante`,
> `conjunto_precio_unidad`, `conjunto_total` en la colección `catalogo`).
>
> Necesito que hagas lo siguiente, **respetando la arquitectura existente**:

### 1. Sync POS ← Firebase

- Asegurarte que `pos_system/utils/firebase_sync.py` baje los nuevos campos
  cuando sincroniza el catálogo
- Agregar las columnas en SQLite local (`pos_system/database/db_manager.py`):
  ```sql
  ALTER TABLE productos ADD COLUMN es_conjunto INTEGER DEFAULT 0;
  ALTER TABLE productos ADD COLUMN conjunto_tipo TEXT;
  ALTER TABLE productos ADD COLUMN conjunto_unidad_medida TEXT;
  ALTER TABLE productos ADD COLUMN conjunto_unidades REAL;
  ALTER TABLE productos ADD COLUMN conjunto_contenido REAL;
  ALTER TABLE productos ADD COLUMN conjunto_restante REAL;
  ALTER TABLE productos ADD COLUMN conjunto_precio_unidad REAL;
  ALTER TABLE productos ADD COLUMN conjunto_total REAL;
  ```
- Migración idempotente (verificar columnas antes de crear)

### 2. UI en POS — al agregar producto a la venta

En `pos_system/ui/sales_view.py` (o donde esté el flujo de "agregar al ticket"):

- Cuando el usuario escanea/selecciona un producto con `es_conjunto = 1`,
  abrir un **diálogo modal** que pregunte:
  - **¿Cuánto vas a vender?** (input numérico, paso 0.01)
  - Mostrar al lado: la unidad de medida (`metros`, `unidades`, etc.)
  - Mostrar disponible: `conjunto_total` actual + breakdown
    (ej: "Disponible: 5 rollos × 100m + 35.5m = 535.5 metros")
  - Precio sugerido: `conjunto_precio_unidad × cantidad`
    (si `conjunto_precio_unidad` está vacío, usar `precio_venta` directo)
- Botones: **Agregar** / **Cancelar**
- Al agregar: guardar en el ítem del ticket la cantidad fraccionaria + unidad

### 3. Descuento de stock al confirmar venta

Cuando se confirma la venta (`pos_system/models/sale.py` o similar):

- Si el ítem es de un producto conjunto:
  1. Actualizar `conjunto_restante` y `conjunto_unidades`:
     - Vendido = X metros/unidades
     - Si `conjunto_restante > 0`: restar primero del restante
     - Si vendido > restante: cerrar ese rollo (`conjunto_unidades -= 1`),
       abrir el siguiente (`conjunto_restante = conjunto_contenido - sobrante`)
     - Repetir si vendido cubre varios rollos enteros
  2. Recalcular `conjunto_total = (conjunto_unidades_cerrados × contenido) + restante`
  3. NO modificar `stock` clásico (queda en 0 o ignorado para conjuntos)
- Sincronizar el cambio a Firebase con el resto del flujo de venta

### 4. Visualización en POS

- En la grilla de productos del POS: badge "📦 Pack" / "🧵 Rollo" / "📏 X metros"
  para identificar visualmente productos conjuntos
- Al pasar el mouse: tooltip con el desglose de stock
  (ej: "5 rollos completos + 35.5m sueltos = 535.5m disponibles")

### 5. Reportes / Cierres

Si hay reportes de stock o cierres que muestran inventario:

- Mostrar productos conjuntos con su breakdown
- Alertar cuando `conjunto_total <= conjunto_contenido` (queda menos de 1 unidad)

### 6. Edición rápida desde POS (opcional)

- Desde la vista de inventario del POS, permitir editar el `conjunto_restante`
  manualmente (caso: rollo se cortó o se midió mal)

### Restricciones

- **NO romper** productos que NO son conjuntos (`es_conjunto = 0` o `null`):
  funcionan exactamente igual que antes
- **NO** mockear datos: integrar con el flujo real de Firebase + SQLite
- Mantener compat con build PyInstaller (no agregar deps sin actualizar `.spec`)
- Testear que el setup.exe final incluya los cambios

### Archivos clave a tocar

- `pos_system/database/db_manager.py` — schema + migración
- `pos_system/utils/firebase_sync.py` — sync de los nuevos campos
- `pos_system/models/product.py` — leer/escribir campos conjunto
- `pos_system/models/sale.py` — descuento de stock conjunto al cerrar venta
- `pos_system/ui/sales_view.py` — diálogo "cuánto vendés" + integración ticket
- (opcional) `pos_system/ui/products_view.py` — badge visual + edición rápida

---

## Notas de diseño

- El `conjunto_total` es **derivado** — siempre se recalcula, no es source-of-truth
- La source-of-truth real son `conjunto_unidades` (enteros que quedan) +
  `conjunto_restante` (sobrante del que está abierto)
- Para ventas por unidad simple (ej: vendo 1 pack completo) → restar 1 a
  `conjunto_unidades`, no tocar el restante
- Para ventas fraccionarias (ej: vendo 12.5 metros) → consumir restante y rollos
  enteros según haga falta

## Para iniciar la conversación de continuación

Pegá este prompt en una nueva sesión de Claude Code en este mismo proyecto.
Claude tiene acceso a la memoria del proyecto y a `firebase_key.json`,
así que puede verificar el estado actual antes de empezar.
