# Sistema POS - Point of Sale
## Versión 2.0.0

## Requisitos del Sistema

- Python 3.8+
- PyQt5 (Interfaz gráfica)
- SQLite (Base de datos local)
- Google Sheets API (Sincronización)
- ReportLab (Generación de PDFs)
- Pillow (Procesamiento de imágenes)

## Instalación

`ash
pip install -r requirements.txt
`

## Configuración

1. Configurar credenciales de Google Sheets (opcional)
2. Ejecutar la aplicación: python main.py

## Funcionalidades

- ✅ Dashboard con estadísticas en tiempo real
- ✅ Gestión completa de productos (CRUD, fotos, búsqueda)
- ✅ Sistema de ventas con carrito
- ✅ Gestión de caja (retiros, cierre de caja)
- ✅ Tipos de pago (Efectivo/Transferencia)
- ✅ Generación de tickets y reportes PDF
- ✅ Sincronización con Google Sheets
- ✅ Productos favoritos
- ✅ Estadísticas y reportes detallados

## Estructura del Proyecto

`
pos_system/
├── main.py                 # Punto de entrada
├── database/
│   ├── db_manager.py      # Gestor de base de datos
│   └── google_sync.py     # Sincronización Google Sheets
├── models/
│   ├── product.py         # Modelo de productos
│   ├── sale.py            # Modelo de ventas
│   └── cash_register.py   # Modelo de caja
├── ui/
│   ├── main_window.py     # Ventana principal
│   ├── dashboard.py       # Dashboard de estadísticas
│   ├── products_view.py   # Vista de productos
│   ├── sales_view.py      # Vista de ventas
│   └── cash_view.py       # Vista de caja
├── utils/
│   ├── pdf_generator.py   # Generador de PDFs
│   └── image_handler.py   # Procesador de imágenes
├── assets/
│   └── images/            # Imágenes de productos
└── reports/               # Reportes generados
`

## Mejoras v2.0.0

### 🏗️ Arquitectura
- Context managers para base de datos con auto-commit/rollback
- Sistema de logging profesional con rotación de archivos
- Configuración centralizada en `config.py`
- Validaciones robustas con módulo dedicado
- Manejo de errores exhaustivo

### 🎨 Diseño
- Paleta de colores profesional (Bootstrap-inspired)
- Tipografía y espaciado mejorados
- Componentes UI reutilizables (MessageBox, Toast, Cards)
- Eliminados elementos que parecen generados por IA

### 🎯 Usabilidad
- Atajos de teclado (Ctrl+1/2/3/4, F5)
- Mensajes de feedback consistentes
- High DPI support

Ver `README_IMPROVEMENTS.md` para detalles completos de las mejoras.

## Autor

Sistema POS para gestión profesional de ventas
