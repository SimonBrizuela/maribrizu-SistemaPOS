"""
Configuration settings for POS System
"""
import os
import sys
from pathlib import Path

# Base directories
# APP_DIR: donde está el ejecutable (o el script en desarrollo)
# DATA_DIR: donde se guardan datos del usuario (escribible en cualquier PC)
if getattr(sys, 'frozen', False):
    # Corriendo como ejecutable PyInstaller
    APP_DIR = Path(sys.executable).parent
    DATA_DIR = Path(os.environ.get('APPDATA', Path.home())) / "SistemaPOS"
else:
    # Corriendo como script Python (desarrollo)
    APP_DIR = Path(__file__).resolve().parent.parent
    DATA_DIR = APP_DIR

BASE_DIR = APP_DIR
ASSETS_DIR = APP_DIR / "_internal" / "pos_system" / "assets" if getattr(sys, 'frozen', False) else APP_DIR / "pos_system" / "assets"
IMAGES_DIR = ASSETS_DIR / "images"
REPORTS_DIR = DATA_DIR / "reports"

# Database
DATABASE_PATH = DATA_DIR / "pos_database.db"
DATABASE_BACKUP_DIR = DATA_DIR / "backups"

# Application settings
APP_NAME = "Sistema POS"
APP_VERSION = "3.0.4"
ORGANIZATION = "POS System"

# UI Settings
WINDOW_WIDTH = 1280
WINDOW_HEIGHT = 760
WINDOW_MIN_WIDTH = 900
WINDOW_MIN_HEIGHT = 600

# Business logic
LOW_STOCK_THRESHOLD = 5
MAX_CART_ITEMS = 100
CURRENCY_SYMBOL = "$"
CURRENCY_FORMAT = "{:.2f}"

# Logging
LOG_FILE = DATA_DIR / "pos_system.log"
LOG_MAX_BYTES = 10 * 1024 * 1024  # 10MB
LOG_BACKUP_COUNT = 5
LOG_FORMAT = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
LOG_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

# PDF Settings
PDF_TITLE = "Sistema POS"
PDF_COMPANY_NAME = os.getenv("POS_COMPANY_NAME", "Tu Empresa")
PDF_COMPANY_ADDRESS = os.getenv("POS_COMPANY_ADDRESS", "Dirección de tu empresa")
PDF_COMPANY_PHONE = os.getenv("POS_COMPANY_PHONE", "Teléfono")

# Date formats
DATE_FORMAT = "%d/%m/%Y"
TIME_FORMAT = "%H:%M:%S"
DATETIME_FORMAT = f"{DATE_FORMAT} {TIME_FORMAT}"

# ── Google Sheets Integration (via Apps Script Webhook) ───────────────────
# URL del Web App de Google Apps Script.
# Cómo obtenerla:
#   1. Abrí tu Google Sheets → Extensiones → Apps Script
#   2. Pegá el contenido de google_apps_script.js y guardá
#   3. Implementar → Nueva implementación → App web
#      - Ejecutar como: Yo  |  Acceso: Cualquier usuario (Anyone)
#   4. Copiá la URL y pegala aquí abajo (o usá la variable de entorno)
#
# También se puede definir con: set GOOGLE_SHEETS_WEBHOOK_URL=https://...
GOOGLE_SHEETS_WEBHOOK_URL = os.getenv(
    "GOOGLE_SHEETS_WEBHOOK_URL",
    "https://script.google.com/macros/s/AKfycbxRcrtQSTJ1sn7iAlF21lmSCrjfjN8H4qJjrNrIu1ZSu4d3pnnXYR4jhlYZm2Ux_8kV/exec"
)

# ── AFIP / Facturación Electrónica ───────────────────────────────────────────
# Completar con los datos del negocio para emitir facturas electrónicas.
# Estos valores se pueden editar desde la pestaña Fiscal del sistema.
AFIP_CUIT             = os.getenv("AFIP_CUIT", "")               # Ej: "20123456789"
AFIP_RAZON_SOCIAL     = os.getenv("AFIP_RAZON_SOCIAL", "")        # Ej: "Mi Librería SRL"
AFIP_DOMICILIO        = os.getenv("AFIP_DOMICILIO", "")           # Ej: "Av. Colón 123"
AFIP_LOCALIDAD        = os.getenv("AFIP_LOCALIDAD", "")           # Ej: "CÓRDOBA (5000) - CÓRDOBA"
AFIP_TELEFONO         = os.getenv("AFIP_TELEFONO", "")            # Ej: "3511234567"
AFIP_ING_BRUTOS       = os.getenv("AFIP_ING_BRUTOS", "")          # Ej: "123456789"
AFIP_INICIO_ACT       = os.getenv("AFIP_INICIO_ACT", "")          # Ej: "01/01/2020"
AFIP_CONDICION_IVA    = os.getenv("AFIP_CONDICION_IVA", "Resp. Inscripto")
AFIP_PUNTO_VENTA      = int(os.getenv("AFIP_PUNTO_VENTA", "1"))   # Número de punto de venta

# ── Actualizaciones automáticas (GitHub Releases) ────────────────────────────
# Formato: "usuario/repositorio"  Ej: "maribrizu/SistemaPOS"
GITHUB_REPO = os.getenv("GITHUB_REPO", "SimonBrizuela/maribrizu-SistemaPOS")

# Carpeta de certificados AFIP (escritos automáticamente desde Firebase)
CERTS_DIR = DATA_DIR / "certs"

# Create necessary directories
for directory in [REPORTS_DIR, DATABASE_BACKUP_DIR, DATA_DIR, CERTS_DIR]:
    directory.mkdir(parents=True, exist_ok=True)
