# Migración del Sistema POS al tema Graphite (PosNew) — Prompt completo

> Este documento es un **prompt autocontenido** para retomar la migración en otra sesión / con otro modelo. Pegalo entero al inicio de la conversación. Asume que tenés acceso al repo `C:\Users\brizu\3D Objects\workana\Mari\` y al backup `backup_ui_2026-04-26\`.

---

## 0. Contexto del proyecto

- **Producto:** Sistema POS de escritorio para Librería Liceo (Córdoba). Stack: **PyQt5 + SQLite + Firebase Firestore + AFIP/ARCA WSFE**.
- **Versión actual:** v2.4.3. Empaqueta con PyInstaller a `dist/SistemaPOS/SistemaPOS.exe`.
- **Estructura clave del repo:**
  - `main.py` — entrada principal, crea `QApplication`, inicia `LoginDialog` y `MainWindow`.
  - `pos_system/ui/` — todas las vistas y diálogos PyQt5.
  - `pos_system/models/` — `Product`, `Sale`, `CashRegister`, `Promotion`, `Observation`, `User`.
  - `pos_system/database/db_manager.py` — schema SQLite + migraciones idempotentes.
  - `pos_system/utils/firebase_sync.py` — sync bidireccional con Firestore.
  - `pos_system/utils/afip_wsfe.py` — facturación electrónica AFIP.
- **Webapp asociada:** `webapp/` (Vite + Firebase JS SDK). NO se toca en esta migración.

---

## 1. Material de origen — la carpeta `PosNew/`

Contiene un rediseño visual completo (tema **Graphite cálido**, paleta crema/grafito/naranja) hecho con PyQt6 (compatible PyQt5):

```
PosNew/
├── theme.py              # tokens (COLORS, FONTS, SIZES) + apply_theme(app) + helpers
├── styles.qss            # 605 líneas — stylesheet global
├── widgets.py            # BaseDialog, Card, Field, FieldLabel, PillRow, KVRow,
│                          # Badge, BigInput, MonoInput, AccentButton, PrimaryButton,
│                          # SecondaryButton, DangerButton, DialogHeader, DialogFooter
├── main_window.py        # SalesView rediseñado (mockup, sin lógica)
├── main.py               # ejemplo de entrada
└── dialogs/              # 14 dialogs, todos heredan BaseDialog
    ├── __init__.py
    ├── login_dialog.py
    ├── factura_dialog.py    # cobrar
    ├── conjunto_dialog.py   # vender de rollo/pack
    ├── cliente_dialog.py
    ├── turno_dialog.py
    ├── caja_dialog.py
    ├── producto_dialog.py
    ├── stock_dialog.py
    ├── promo_dialog.py
    ├── devolucion_dialog.py
    ├── reportes_dialog.py
    ├── config_dialog.py
    ├── sync_dialog.py
    └── buscar_dialog.py
```

**Importante:** Los dialogs y el `main_window` del PosNew son **mockups visuales sin lógica de negocio**. Tienen el diseño correcto pero NO conocen la BD, Firebase, AFIP, ni los modelos del POS.

---

## 2. Regla de oro de la migración

**No romper nada en ningún paso.** El POS está en producción facturando con AFIP. Cada cambio se hace en este orden:

1. Aplicar **solo lo nuevo** (tema, widgets, dialogs nuevos) **sin borrar lo viejo**.
2. Probar el cambio en `python main.py` — login, agregar al carrito, cobrar con AFIP, ver historial, sincronizar.
3. Si todo OK, recién ahí migrar al siguiente dialog.
4. **Nunca tocar `*_dialog.py` viejo y nuevo a la vez** sin probar entre medio.

---

## 3. Fases

### Fase 1 — Aplicar el tema (cambia solo el look, sin tocar lógica)

**Objetivo:** que la app se vea Graphite sin reemplazar ningún dialog.

**Pasos:**

1. Copiar a la raíz del proyecto:
   - `PosNew/theme.py` → `pos_system/ui/theme.py`
   - `PosNew/styles.qss` → `pos_system/ui/styles_graphite.qss` (NO pisar `pos_system/ui/styles.qss` original)
   - `PosNew/widgets.py` → `pos_system/ui/graphite_widgets.py`

2. En `theme.py`, ajustar la ruta del .qss:
   ```python
   def apply_theme(app, qss_path=None):
       qss_path = qss_path or Path(__file__).parent / "styles_graphite.qss"
       ...
   ```

3. En `main.py`, después de crear `QApplication`:
   ```python
   from pos_system.ui.theme import apply_theme
   app = QApplication(sys.argv)
   apply_theme(app)
   ```

4. **Validación:** correr `python main.py`. Tiene que arrancar normal, hacer login, ver el dashboard. Los colores cambian (botones nuevos, cards con borde, paleta crema). No debe haber errores en consola.

**Cuidados:**
- Los QSS de Qt son cascadeantes. Si el viejo `styles.qss` también está cargado por algún `setStyleSheet` en `main_window.py`, vas a tener doble estilo. Buscá `setStyleSheet` en `pos_system/ui/main_window.py` y comentá los que pisen colores globales.
- Los widgets que usen `setProperty("variant", ...)` necesitan llamar `repolish(widget)` después.

---

### Fase 2 — Migrar dialogs uno por uno

Para **cada** dialog migrado, el procedimiento es:

1. Leer el original completo (ej. `pos_system/ui/login_dialog.py`).
2. Tomar el del PosNew como **template visual** (estructura, cards, botones, KVRow, PillRow).
3. Crear un archivo **nuevo** con la lógica del original portada al template visual. NO borrar el viejo todavía — usar nombres distintos o renombrar el viejo a `*_legacy.py`.
4. Cambiar el import en el lugar donde se llama (ej. `sales_view.py` o `main_window.py`).
5. **Probar el flujo completo** del dialog (caso feliz + caso de error).
6. Borrar el viejo si todo funciona.

A continuación, el detalle completo de **qué falta** en cada dialog del PosNew para que sea funcional.

---

#### 2.1 `LoginDialog`

**Original:** `pos_system/ui/login_dialog.py`

**PosNew tiene:** dos QLineEdit (usuario, password), botón "Iniciar sesión".

**Falta agregar:**
- Constructor recibe `db_manager: DatabaseManager`.
- Importar `from pos_system.models.user import User`.
- En `_login()`:
  - Validar campos vacíos.
  - Llamar `User(db).authenticate(usuario, password)` (hash bcrypt + chequeo).
  - Si falla, mostrar error inline (label rojo, no QMessageBox bloqueante).
  - Si éxito, guardar `self.user_data = {id, username, full_name, role}` y `self.accept()`.
- Soporte para auto-login admin (flag `--admin`) que ya existe en `main.py`.
- Al cerrar el dialog (botón ×), `sys.exit(0)`.

**Datos requeridos:**
- `db_manager` (instancia activa).
- `argv` para detectar `--admin`.

**Devolver:**
- `self.user_data` con dict completo.

**Probar:**
- Login con usuario/clave válida.
- Login con clave equivocada → mensaje de error.
- Login con usuario inexistente → mensaje de error.
- Auto-login con `python main.py --admin`.

---

#### 2.2 `FacturaDialog` (Cobrar venta — es **el más complejo**)

**Original:** `PaymentDialog` en `sales_view.py` línea 2905.

**PosNew tiene:** PillRow tipo comprobante (Ticket B / Factura A / C / Sin compr.), PillRow medio (Efectivo/Débito/Crédito/Transferencia/QR), input recibido, label vuelto, KVRow subtotal/promo/total, botón Cobrar.

**Falta agregar (mucho — este es el que más esfuerzo lleva):**

**Inputs al constructor:**
```python
def __init__(self, total, items_count, *,
             cart_items: list[dict],
             db_manager,
             firebase_sync,
             pdf_generator,
             current_user: dict,
             current_caja: dict | None,
             turno_nombre: str,
             parent=None):
```

**Lógica:**

1. **Tipo de comprobante real** — el original soporta:
   - "No fiscal" (ticket impreso, no factura electrónica).
   - "Factura B / A / C / X" (AFIP electrónica).
   - Selector de **perfil de facturación** (puede haber varios CUITs configurados, ej. uno por sucursal).
   - Hay que cargar perfiles activos de `perfiles_facturacion` (tabla SQLite + Firebase).

2. **Asignación de cliente** — para Factura A (resp. inscripto) y Factura C (consumidor con CUIT) hay que pedir cliente. Botón secundario "Asignar cliente" que abre `ClienteDialog` y vuelve con CUIT/razón social/condición IVA.

3. **Medio de pago en el modelo `Sale`** — el modelo actual solo guarda `cash` / `transfer`. Si querés los 5 medios (Efectivo/Débito/Crédito/Transferencia/QR), hay que:
   - Agregar columna `payment_subtype` a `sales` (migración idempotente).
   - Mapear: Efectivo → `cash`, todos los demás → `transfer` para mantener compat con `cash_register`.
   - O ampliar `cash_register` para distinguir débito/crédito/QR.

4. **Promos** — el carrito ya viene con `discount_amount` por ítem. Mostrar la suma como "Descuento promo" y el detalle al pasar el mouse (tooltip).

5. **Caja registradora** — validar que `current_caja['status'] == 'open'`. Si no hay caja abierta:
   - Si el usuario es admin, ofrecer abrirla con `OpenCashDialog` (de `cash_view.py:493`).
   - Si es cajero, bloquear con error.

6. **Confirmar venta** — al apretar "Cobrar":
   ```python
   from pos_system.models.sale import Sale
   sale_data = {
       'items': cart_items,
       'payment_type': payment_type,           # cash | transfer
       'payment_subtype': payment_subtype,     # efectivo | debito | credito | transferencia | qr
       'total_amount': self.total,
       'cash_received': recibido,
       'change_given': max(0, recibido - total),
       'user_id': current_user['id'],
       'turno_nombre': turno_nombre,
       'notes': '',
   }
   sale_id = Sale(db_manager).create(sale_data)
   ```

7. **AFIP / ARCA** — si tipo == "Factura A/B/C":
   - Tomar el perfil seleccionado.
   - Si el perfil requiere **certs ARCA**, validar que los archivos existan (descarga automática desde Firebase si faltan).
   - Llamar `FacturaDialog(...)` real (`pos_system/ui/factura_dialog.py:91`) o reutilizar su lógica embebida.
   - Esperar respuesta CAE / vencimiento / nro_factura.
   - Persistir en tabla `facturas_arca` (verificar si existe; si no, crear).

8. **Generación PDF** — usar `PDFGenerator` (en `pdf_generator.py`):
   - Si fiscal → `generate_fiscal_invoice(sale, factura_data)`.
   - Si no fiscal → `generate_non_fiscal_ticket(sale, cajero_name, cliente_name)`.
   - Abrir el PDF con `os.startfile()` o `subprocess`.

9. **Sync a Firebase** — en thread separado:
   - `firebase_sync.sync_sale(sale_dict)`
   - `firebase_sync.sync_sale_detail_by_day(sale_dict, db_manager)`
   - `firebase_sync.sync_stock_after_sale(items, db_manager)` (este ya soporta conjunto).
   - `firebase_sync.sync_monthly_summary(year, month, sales)` (resumen mensual).

10. **Observaciones** — items con `pending_observation` → crear `Observation` con el `sale_id` real.

11. **Hot keys** — F2 = Cobrar, ESC = cancelar.

**Datos requeridos al recibir:**
- Lista de perfiles de facturación activos.
- Lista de clientes (para botón Asignar cliente).
- Caja actual.
- Usuario actual + turno.
- `pdf_generator` instanciado.

**Devolver al `accept()`:**
- `self.result_data = {sale_id, factura_data, pdf_path}`.

**Probar:**
- Cobrar Ticket B en efectivo.
- Cobrar Factura B con débito.
- Cobrar Factura A con cliente CUIT cargado.
- Sin caja abierta → bloquea.
- Recibido < total → bloquea botón Cobrar.
- Vuelto > 0 se calcula bien.
- Cancelar → no graba nada.

---

#### 2.3 `ConjuntoDialog` (Vender de rollo/pack)

**Original:** `pos_system/ui/conjunto_dialog.py` (creado en esta sesión, está completo y funcional).

**PosNew tiene:** versión simplificada — solo cantidad libre, vista previa básica.

**Acción recomendada:** **MANTENER el original** (que ya tiene la lógica completa con `aplicar_venta`, modos fracción/unidad/conjunto, conversión de unidades, validación) y **portar solo el look** (BaseDialog, Card, AccentButton, paleta).

**Falta:**
- Reescribir `_build_ui` usando `BaseDialog` y los widgets del tema Graphite.
- Mantener intactos: `aplicar_venta()`, `total_conjunto()`, `result_data`, integración con `add_to_cart` en `sales_view.py`.

---

#### 2.4 `ClienteDialog`

**Original:** `pos_system/ui/cliente_perfil_dialog.py`.

**PosNew tiene:** búsqueda + tabla + botón "Asignar" / "Crear nuevo".

**Falta agregar:**
- Constructor recibe `db_manager` y `firebase_sync`.
- Cargar lista real de clientes:
  - Tabla `clientes` en SQLite (verificar si existe; si no, crearla con migración).
  - Sync con colección `clientes` de Firebase.
- Filtro por CUIT/DNI/nombre con normalización (sin acentos, mayúsculas).
- Botón "Crear nuevo" abre un sub-dialog con form:
  - Tipo doc (DNI / CUIT / CUIL).
  - Documento (con validación AFIP — checksum CUIT).
  - Razón social.
  - Condición IVA (Resp. Inscripto / Monotributo / Cons. Final / Exento).
  - Domicilio (opcional).
  - Email (opcional).
- Al "Asignar": `self.cliente_seleccionado = {doc, nombre, cond_iva, ...}` y `accept()`.
- Sync Firebase del nuevo cliente en hilo de fondo.

**Probar:**
- Buscar por nombre parcial.
- Crear cliente con CUIT inválido → bloquea.
- Asignar → vuelve al `FacturaDialog` con el cliente cargado.

---

#### 2.5 `TurnoDialog`

**Original:** `pos_system/ui/turno_dialog.py`.

**PosNew tiene:** PillRow con cajeros + Card con info de caja.

**Falta agregar:**
- Constructor recibe `db_manager`, `current_caja`.
- Cargar lista de cajeros:
  - Si tenés tabla `turnos` o `cajeros` → leer activos.
  - Si no, leer usuarios con `role IN ('cajero', 'admin')` desde `users`.
- Persistir el turno seleccionado en algún lado:
  - Opción A: variable de instancia en `MainWindow.turno_nombre`.
  - Opción B: tabla `turnos_activos` con (caja_id, cajero_nombre, started_at).
- Botón "Otro…" abre un QInputDialog para cargar nombre custom.
- Al confirmar: emitir signal o setear `parent.turno_nombre` y `accept()`.

**Probar:**
- Cambiar turno → todas las ventas siguientes registran el nuevo `turno_nombre`.
- Cancelar → mantiene el turno previo.

---

#### 2.6 `CajaDialog` (Cierre de caja)

**Original:** `OpenCashDialog`, `WithdrawalDialog`, `CloseCashDialog` en `cash_view.py` (3 dialogs distintos).

**PosNew tiene:** un único dialog con saldo sistema vs contado, diferencia, observaciones.

**Decisión de scope:** ¿unificás los 3 en uno (PillRow Apertura/Egreso/Cierre) o hacés 3 separados? **Recomendación:** 3 separados (matchea mejor el flujo actual y los permisos).

**Para `CloseCashDialog` (el del PosNew):**
- Constructor recibe `db_manager`, `caja_id`.
- Calcular saldo sistema:
  ```python
  caja = db.execute_query("SELECT * FROM cash_register WHERE id=?", (caja_id,))[0]
  saldo_sistema = caja['initial_amount'] + caja['cash_sales'] - caja['withdrawals']
  ```
- El usuario ingresa el contado real.
- Diferencia = contado - sistema (puede ser positiva o negativa).
- Card de diferencia: verde si 0, naranja si < |1000|, rojo si más.
- Observaciones obligatorias si diferencia ≠ 0.
- Al confirmar:
  - `UPDATE cash_register SET final_amount=?, status='closed', closed_at=?, notes=? WHERE id=?`
  - Generar PDF de cierre con `PDFGenerator.generate_cash_closure(caja, diferencia, notas)`.
  - Sync a Firebase: `firebase_sync.sync_cash_closure(caja_dict)`.

**Probar:**
- Cierre con saldo exacto.
- Cierre con sobrante (diferencia +).
- Cierre con faltante (diferencia −) → exige observación.

---

#### 2.7 `ProductoDialog` (Alta/edición)

**Original:** `ProductDialog` en `products_view.py:816`.

**PosNew tiene:** form completo (código, barras, nombre, categoría, unidad, IVA, costo, margen, precio).

**Falta agregar:**
- Recibir `db_manager`, `firebase_sync`, `producto: dict | None` (None = alta).
- Validaciones (`pos_system/utils/validators.py`):
  - `validate_product_name`, `validate_price`, `validate_barcode`, `validate_category`.
- Cálculo automático margen ↔ precio (al cambiar costo o margen, recalcular precio; al cambiar precio, recalcular margen).
- Botón "Eliminar" (DangerButton) solo en modo edición.
- Soporte para producto conjunto:
  - Toggle "¿Es conjunto?" → muestra/oculta sección con tipo, unidad, contenido, restante, precio_unidad.
  - Mismos campos que la webapp (`webapp/src/pages/catalogo.js` modal).
- Al guardar:
  - Modo alta: `Product(db).create(data)`.
  - Modo edición: `Product(db).update(id, **data)`.
  - Sync Firebase: `firebase_sync.sync_product_to_firebase(producto, db)`.
- Subida de imagen a Firebase Storage (opcional, si lo soporta).

**Probar:**
- Alta con barcode duplicado → bloquea.
- Edición de producto conjunto → cambia campos sin perder otros.
- Eliminar (cajero no tiene permiso, admin sí).

---

#### 2.8 `StockDialog` (Movimiento de stock)

**Original:** `StockAdjustDialog` en `products_view.py:740`.

**PosNew tiene:** 3 KPI cards (actual/min/max) + tipo (Ingreso/Egreso/Ajuste/Merma) + cantidad + resultante.

**Falta agregar:**
- Recibir `db_manager`, `producto` con stock actual.
- Si `producto.es_conjunto`: cambiar UI a la versión de stock conjunto (igual a pestaña Catálogo del HTML V4) — ajustar `conjunto_unidades` y `conjunto_restante` por separado.
- Tipo "Merma" exige observación.
- Persistir movimiento:
  - Tabla `stock_movements` (verificar/crear con migración: `id, product_id, type, quantity, before, after, user_id, notes, created_at`).
  - `UPDATE products SET stock = stock + ? WHERE id = ?` (con signo según tipo).
- Sync Firebase del nuevo stock.

**Probar:**
- Ingreso de 100 → stock sube.
- Egreso > stock disponible → advertencia (permitir o bloquear según política).
- Ajuste a 0 → stock queda en 0.
- Merma con motivo → registra observación.

---

#### 2.9 `PromoDialog`

**Original:** `PromoDialog` en `promotions_view.py:216`.

**PosNew tiene:** lista de promos con cards seleccionables.

**Falta agregar:**
- Recibir `db_manager`, `firebase_sync`.
- Cargar promos activas desde:
  - Tabla `promotions` (BD local).
  - Colección `promociones` (Firebase).
- Mostrar tipo, condiciones, descuento.
- Soporte para CRUD si el usuario es admin (botones Editar/Eliminar/Nueva).
- Al "Aplicar": no aplica directamente, sino que devuelve la lista de IDs seleccionados para que `sales_view` los use al armar el carrito.

**Probar:**
- Aplicar 2x1 → al agregar 2 unidades del producto, se descuenta 1.
- Aplicar 10% efectivo → aparece como descuento en `FacturaDialog`.

---

#### 2.10 `DevolucionDialog`

**Original:** **NO existe** en el POS actual. Es funcionalidad nueva.

**PosNew tiene:** input ticket, tabla con items vendidos, checkbox para devolver, motivo, total a devolver.

**Falta agregar (todo):**
- Crear tabla `devoluciones` con migración:
  ```sql
  CREATE TABLE devoluciones (
      id INTEGER PRIMARY KEY,
      sale_id INTEGER NOT NULL,
      sale_item_id INTEGER NOT NULL,
      quantity REAL NOT NULL,
      amount REAL NOT NULL,
      motivo TEXT,
      user_id INTEGER,
      created_at TIMESTAMP,
      FOREIGN KEY (sale_id) REFERENCES sales(id)
  )
  ```
- Crear modelo `Devolucion` en `pos_system/models/devolucion.py`.
- Buscar venta por número de ticket (id de `sales`).
- Mostrar items con cantidad vendida y permitir devolver una porción.
- Al confirmar:
  - INSERT en `devoluciones` por cada item devuelto.
  - Devolver stock al producto (UPDATE `products SET stock = stock + ?`).
  - Para items conjunto: revertir el descuento (sumar a `conjunto_unidades`/`conjunto_restante`).
  - Generar nota de crédito si la venta original fue factura A/B/C → llamar AFIP `wsfe.crear_nota_credito(...)`.
  - Egreso de caja por el monto devuelto.
  - PDF de la nota de devolución.
  - Sync Firebase.

**Probar:**
- Devolver 1 item de un ticket no fiscal.
- Devolver 1 item de Factura B → emite nota de crédito.
- Devolver fracción de un producto conjunto → vuelve a `conjunto_restante`.

---

#### 2.11 `ReportesDialog`

**Original:** No es un dialog específico — los reportes están repartidos en `sales_history_view.py`, `cash_view.py`, etc.

**PosNew tiene:** filtros de tipo + período + tabla.

**Falta agregar:**
- Tipo "Ventas":
  - Query `Sale.get_sales_by_period(start, end)` (existe en `Sale`).
  - Mostrar tickets, bruto, descuentos, neto por día.
- Tipo "Stock":
  - Movimientos de la tabla `stock_movements`.
- Tipo "Caja":
  - Cierres de la tabla `cash_register WHERE status='closed'`.
- Tipo "Promos":
  - Promos aplicadas (JOIN `sale_items.promo_id` con `promotions`).
- Botón "Exportar CSV":
  - `import csv; csv.writer(...)` con los datos visibles.
  - Diálogo `QFileDialog.getSaveFileName` para elegir destino.
- Botón "Imprimir":
  - `QPrinter` + `QPrintDialog` para imprimir la tabla.

**Probar:**
- Reporte Ventas mes actual → coincide con `historial`.
- Exportar CSV → archivo válido abre en Excel.

---

#### 2.12 `ConfigDialog`

**Original:** Configuración dispersa: `arca_perfil_dialog.py` (AFIP), settings hardcodeadas, sin UI unificada.

**PosNew tiene:** sidebar con secciones (General/Empresa/Impresora/AFIP/Sync/Backup/Avanzado) + stack de paneles.

**Falta agregar:**
- Crear tabla `app_settings` con migración:
  ```sql
  CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP
  )
  ```
- Para cada panel:
  - **General**: nombre del comercio, caja por defecto, idioma, tema.
  - **Empresa**: razón social, domicilio, ing. brutos, inicio actividades.
  - **Impresora**: nombre impresora, tamaño papel, márgenes, copias.
  - **AFIP**: lista de perfiles (tabla `perfiles_facturacion`) con CRUD — ya existe `arca_perfil_dialog.py`, integrarlo acá como sub-panel.
  - **Sincronización**: toggle auto-sync, intervalo, último sync.
  - **Backup**: botón "Hacer backup ahora", "Restaurar".
  - **Avanzado**: limpiar caché, ver logs, modo dev.
- Persistir en `app_settings` con `setValue/getValue` helpers.

**Probar:**
- Cambiar nombre comercio → aparece en tickets.
- Agregar perfil AFIP → aparece en `FacturaDialog`.
- Toggle auto-sync → afecta el listener de `firebase_sync`.

---

#### 2.13 `SyncDialog`

**Original:** `SyncProgressDialog` en `pos_system/ui/sync_progress_dialog.py`.

**PosNew tiene:** lista de items con estado (ok/progress/pending) + barra + ETA.

**Falta agregar:**
- Constructor recibe `firebase_sync`.
- Hook a las callbacks ya existentes:
  - `firebase_sync.on_sync_progress(name, current, total)`.
  - `firebase_sync.on_sync_done(name, status)`.
  - `firebase_sync.on_sync_error(name, error)`.
- ETA real basado en velocidad reciente.
- Botón "Cancelar sync" (interrumpe los listeners).

**Probar:**
- Iniciar sync manual → progreso real, no fake.
- Cancelar a mitad → cierra sin corromper datos.

---

#### 2.14 `BuscarDialog` (Spotlight)

**Original:** `ProductSearchDialog` en `sales_view.py:183`.

**PosNew tiene:** búsqueda Spotlight con input grande y lista debajo.

**Falta agregar:**
- Recibir `db_manager`.
- Búsqueda en tiempo real (debounced ~150ms) con `_build_fuzzy_query` que ya existe en `sales_view.py`.
- Soporte para escaneo de barras (al escanear, agarrar el evento y agregar directo).
- Tecla ↓/↑ navega resultados, Enter agrega al carrito y cierra.
- Tecla Esc cierra sin agregar.
- Al seleccionar:
  - Si es producto conjunto → abrir `ConjuntoDialog`.
  - Si es producto normal → emitir signal `productoSeleccionado` o llamar `parent.add_to_cart(producto)`.
- Atajo de teclado **F1** para abrirlo desde `MainWindow`.

**Probar:**
- F1 abre el dialog.
- Buscar "lapicera" → muestra varios resultados.
- Enter agrega y cierra.
- Escanear código mientras está abierto → agrega y cierra.
- Producto conjunto → abre `ConjuntoDialog`.

---

### Fase 3 — Migrar `MainWindow` (la pantalla principal)

**Original:** `pos_system/ui/main_window.py` + `pos_system/ui/sales_view.py` (este último es 4000+ líneas).

**PosNew tiene:** un `main_window.py` mockup con header + tabs + carrito + panel lateral con teclas F1-F7.

**Estrategia:** **Migrar en dos sub-fases:**

**3a) Header + tabs + atajos** (no toca el carrito):
- Reemplazar el header de `main_window.py` con el del PosNew (logo, título, sub mono, chip cajero, botones Sync/Nueva venta).
- Mantener el sistema de tabs actual (no mocharlo).
- Conectar los atajos F1-F7 a los dialogs reales.

**3b) Carrito + panel de acciones** (rediseño grande):
- El `SalesView` actual tiene 4000 líneas. NO reescribir desde cero.
- Tomar el archivo actual y refactorizar **solo la parte visual**:
  - El layout del carrito (tabla + total + Cobrar) según el PosNew.
  - El panel lateral de acciones (F1-F7 con cards).
  - La barra de búsqueda + agregar.
- Mantener TODA la lógica: `add_to_cart`, `_on_barcode_scanned`, `_resolve_price_for_product`, `complete_sale`, `_upload_sale_to_firebase`, ítems Varios/Varios2, observaciones, promos, etc.

**Datos que el `MainWindow` rediseñado necesita inyectar:**
- A todos los dialogs hijos: `db_manager`, `firebase_sync`, `pdf_generator`, `current_user`, `current_caja`, `turno_nombre`.
- Recargar `current_caja` después de abrir/cerrar caja.
- Recargar `turno_nombre` después de cambiar turno.

---

### Fase 4 — Empaquetado y release

1. **Probar el bundle completo** — `python main.py` con todas las pantallas, no solo dialogs sueltos.
2. **Bumpear versión** a `v3.0.0` (cambio visual mayor) en `pos_system/config.py`.
3. **Build PyInstaller**:
   ```bash
   python build_app.py
   ```
   Verificar que `styles_graphite.qss` se incluye en el bundle (agregar al `.spec` o al `--add-data`):
   ```python
   --add-data "pos_system/ui/styles_graphite.qss{os.pathsep}pos_system/ui"
   ```
4. **Smoke test del exe** — abrir, login, vender, cobrar con AFIP, cerrar caja.
5. **Crear release** en GitHub (tag v3.0.0) con el `SistemaPOS_Setup.exe` resultante.
6. **Actualizar CHANGELOG.md** y `webapp` si hace falta.

---

## 4. Decisiones de diseño que el usuario debe tomar antes de empezar

Estas son cosas que el código del PosNew implica pero no están confirmadas con el negocio:

1. **Medios de pago:** ¿quedan en los 2 actuales (efectivo/transferencia) o expandimos a los 5 del mockup (Efectivo/Débito/Crédito/Transferencia/QR)? Si es lo segundo, hay migración de schema y reportes.

2. **Tipos de comprobante:** ¿agregamos "Factura A" y "Factura X (interno)" a la matriz actual o nos quedamos con B + No fiscal?

3. **Devoluciones:** ¿lo implementamos o sacamos el botón F6 del panel?

4. **Reportes:** ¿es prioritario o se sigue usando la webapp para reporting?

5. **Configuración:** ¿unificamos todo en `ConfigDialog` o seguimos con dialogs sueltos para AFIP?

6. **Spotlight (F1):** reemplaza al buscador del SalesView actual o convive con él?

7. **Persistencia de turno:** ¿cada PC guarda su turno local o se sincroniza por caja?

8. **Tema oscuro:** ¿se incluye? El PosNew solo trae el tema claro.

---

## 5. Checklist final (para auditar la migración cuando se termine)

- [ ] `apply_theme(app)` aplica al iniciar.
- [ ] Todos los dialogs heredan de `BaseDialog` o `QDialog` con stylesheet propio.
- [ ] Login funciona con bcrypt + role.
- [ ] Cobrar genera Sale + AFIP (si aplica) + PDF + sync Firebase.
- [ ] Conjunto descuenta `conjunto_unidades`/`conjunto_restante` y sincroniza.
- [ ] Cliente CRUD persistente y sync.
- [ ] Turno persiste y se registra en `sales.turno_nombre`.
- [ ] Caja: abrir / retirar / cerrar funciona y graba arqueo.
- [ ] Producto: alta + edición + flag conjunto.
- [ ] Stock: ingresos/egresos/ajustes/mermas con histórico.
- [ ] Promos: aplican al carrito y aparecen en FacturaDialog.
- [ ] Devolución (si se incluye): genera nota de crédito + repone stock.
- [ ] Reportes: ventas/stock/caja/promos con exportación CSV.
- [ ] Configuración: persistente en `app_settings`.
- [ ] Sync: hooks reales, no fake.
- [ ] Spotlight (F1): busca + agrega.
- [ ] Atajos F1-F7 funcionan.
- [ ] Build PyInstaller incluye `styles_graphite.qss`.
- [ ] Smoke test del .exe completo.

---

## 6. Archivos críticos que NO modificar sin entender (lista de "no toques")

- `pos_system/utils/afip_wsfe.py` — comunicación AFIP. Frágil.
- `pos_system/utils/firebase_sync.py` — listeners + sync. Romperlo desconecta multi-PC.
- `pos_system/database/db_manager.py` — schema. Cualquier ALTER TABLE debe ser idempotente.
- `pos_system/models/sale.py:create()` — atomicidad de ventas. Si rompés esto, perdés ventas.
- `firebase_key.json` — credencial. Nunca commitear.

---

## 7. Glosario rápido

- **Caja registradora (`cash_register`)** — sesión de trabajo de un cajero. Tiene apertura, ventas, retiros, cierre.
- **Turno** — string con el nombre del cajero. Se guarda en cada `Sale.turno_nombre` para reportes.
- **Perfil de facturación (`perfiles_facturacion`)** — un CUIT con sus certs/keys ARCA. Puede haber varios.
- **Conjunto** — producto vendido por fracción (rollo, pack, caja). Stock = `conjunto_unidades` (cerrados) + `conjunto_restante` (abierto).
- **Varios / Varios 2** — items genéricos sin SKU. "Varios 2" es exclusivo de Factura AFIP.
- **CAE** — Código de Autorización Electrónico que devuelve AFIP por cada factura. Sin CAE no hay factura válida.
- **Tema Graphite** — el rediseño visual de PosNew. Paleta crema/grafito/naranja, BaseDialog, Card.

---

## 8. Cómo retomar esto en otra sesión

Pegá este archivo entero al inicio de una nueva conversación con Claude/Sonnet/Opus. Luego decile algo como:

> Empezamos por la **Fase 1** del documento. Aplicá solo el tema (theme.py + styles_graphite.qss + widgets.py al proyecto). Probá que el POS arranque sin romperse. No toques ningún dialog todavía.

Cuando termine la Fase 1, pasás a la 2 dialog por dialog en el orden: `LoginDialog → ConjuntoDialog → ClienteDialog → TurnoDialog → CajaDialog → ProductoDialog → StockDialog → PromoDialog → BuscarDialog → SyncDialog → ReportesDialog → ConfigDialog → DevolucionDialog → FacturaDialog`.

`FacturaDialog` se deja para el final porque es el más complejo y depende de todos los demás (cliente, perfil AFIP, caja, promos).
