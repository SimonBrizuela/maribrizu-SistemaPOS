#!/usr/bin/env python
"""
Script para compilar la aplicación SistemaPOS con PyInstaller.
Genera un ejecutable portable con todos los recursos incluidos.
"""

import os
import sys
import shutil
import subprocess
from pathlib import Path

def run_command(cmd, description=""):
    """Ejecuta un comando y reporta errores."""
    if description:
        print(f"\n{'='*60}")
        print(f"  {description}")
        print(f"{'='*60}")
    print(f"Ejecutando: {cmd}")
    result = subprocess.run(cmd, shell=True, capture_output=False)
    if result.returncode != 0:
        print(f"ERROR: {description} falló")
        return False
    return True

def main():
    # Definir rutas
    project_root = Path(__file__).resolve().parent
    build_dir = project_root / "build_output"
    dist_dir = project_root / "dist"
    firebase_key = project_root / "firebase_key.json"
    
    # Limpiar directorios previos
    print("\n[1/5] Limpiando directorios previos...")
    for directory in [build_dir, dist_dir]:
        if directory.exists():
            shutil.rmtree(directory)
            print(f"  OK Eliminado: {directory}")
    
    # Verificar provision.json (credenciales de sincronización)
    if not (project_root / "provision.json").exists():
        print("\n  ADVERTENCIA: no se encontró provision.json")
        print("   La aplicación va a funcionar pero sin sincronización Firebase.")
        print("   El workflow de release lo genera desde los secrets del repo.")
    else:
        print("  OK provision.json encontrado")

    # La service account nunca debe viajar en un artefacto publico.
    if firebase_key.exists():
        print("  AVISO: hay un firebase_key.json en la raiz; NO se empaqueta.")
    
    # Compilar con PyInstaller directamente
    print("\n[2/5] Compilando aplicación con PyInstaller...")
    assets_path     = project_root / "pos_system/assets"
    styles_path     = project_root / "pos_system/ui/styles.qss"
    styles_graphite = project_root / "pos_system/ui/styles_graphite.qss"
    icon_path       = project_root / "pos_system/assets/images/logo.ico"
    manifest_path   = project_root / "app.manifest"

    # Comando PyInstaller directo
    pyinstaller_cmd = (
        f'pyinstaller '
        f'--onedir '
        f'--manifest "{manifest_path}" '
        f'--windowed '
        f'--name SistemaPOS '
        f'--distpath "{dist_dir}" '
        f'--workpath "{build_dir}" '
        f'--add-data "{assets_path}{os.pathsep}pos_system/assets" '
        f'--add-data "{styles_path}{os.pathsep}pos_system/ui" '
        f'--add-data "{styles_graphite}{os.pathsep}pos_system/ui" '
        f'--icon "{icon_path}" '
        # Se importan dentro de funciones del sync: van explicitos para no
        # depender de que PyInstaller los encuentre solo.
        f'--hidden-import=pos_system.models.tombstones '
        f'--hidden-import=pos_system.models.marcas_de_tiempo '
        f'--hidden-import=firebase_admin '
        f'--hidden-import=firebase_admin.credentials '
        f'--hidden-import=firebase_admin.firestore '
        f'--hidden-import=PyQt5 '
        f'--hidden-import=PyQt5.QtWebEngineWidgets '
        f'--hidden-import=PyQt5.QtWebEngineCore '
        f'--hidden-import=PyQt5.QtWebChannel '
        f'--hidden-import=PyQt5.QtPrintSupport '
        f'--hidden-import=reportlab '
        f'--hidden-import=matplotlib '
        f'--hidden-import=PIL '
        f'--hidden-import=cryptography '
        f'--hidden-import=google '
        f'--hidden-import=google.cloud '
        f'--hidden-import=google.cloud.firestore '
        f'--hidden-import=google.api_core '
        f'--hidden-import=zeep '
        f'--hidden-import=zeep.wsdl '
        f'--hidden-import=zeep.transports '
        f'--hidden-import=zeep.settings '
        f'--hidden-import=zeep.plugins '
        f'--hidden-import=zeep.cache '
        f'--hidden-import=OpenSSL '
        f'--hidden-import=OpenSSL.crypto '
        f'--hidden-import=OpenSSL.SSL '
        f'--hidden-import=lxml '
        f'--hidden-import=lxml.etree '
        f'--hidden-import=qrcode '
        f'--hidden-import=qrcode.image.pil '
        f'--collect-all zeep '
        f'--collect-all OpenSSL '
        f'--collect-all qrcode '
        f'"{project_root / "main.py"}"'
    )
    
    if not run_command(pyinstaller_cmd, "Compilación con PyInstaller"):
        print("ERROR: PyInstaller falló. Verificando instalación de dependencias...")
        sys.exit(1)
    
    # Copiar provision.json (URL + secreto de bootstrap).
    #
    # La service account ya NO se distribuye: el instalador se publica en un
    # Release publico y cualquiera podia extraerla para tener Admin SDK sobre
    # todo el proyecto. En su lugar va provision.json, que solo habilita a
    # pedir tokens de 1 hora, y la Netlify Function ademas exige que el pc_id
    # ya figure en la coleccion `pcs`.
    print("\n[3/5] Incluyendo provision.json...")
    app_dir = dist_dir / "SistemaPOS"
    provision = project_root / "provision.json"
    if provision.exists():
        shutil.copy(provision, app_dir / "provision.json")
        print("  OK provision.json copiado")
    else:
        print("  AVISO: no hay provision.json, la build no va a sincronizar.")
        print("         El workflow de release lo genera desde los secrets.")
    
    # Crear carpetas de datos y certificados AFIP
    print("\n[4/5] Creando directorios de datos...")
    reports_dir = app_dir / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)
    print(f"  OK Carpeta reports creada")

    print(f"  OK Carpeta certs (se puebla automáticamente desde Firebase)")
    
    # Crear ZIP final (sin firebase_key.json para evitar deteccion por Google)
    print("\n[5/5] Creando archivo ZIP...")
    zip_name = "SistemaPOS_Portable"
    zip_path = project_root / f"{zip_name}.zip"

    if zip_path.exists():
        zip_path.unlink()

    import zipfile as _zipfile
    EXCLUDE_FILES = {'firebase_key.json'}
    with _zipfile.ZipFile(str(zip_path), 'w', _zipfile.ZIP_DEFLATED) as zf:
        for root_path, dirs, files in os.walk(str(dist_dir)):
            for fname in files:
                if fname in EXCLUDE_FILES:
                    print(f"  SKIP {fname} (no incluido en ZIP)")
                    continue
                full = os.path.join(root_path, fname)
                arcname = os.path.relpath(full, str(dist_dir))
                zf.write(full, arcname)
    
    print(f"\n{'='*60}")
    print(f"  BUILD COMPLETADO CON EXITO")
    print(f"{'='*60}")
    print(f"\nArchivos generados:")
    print(f"  Ejecutable: {app_dir / 'SistemaPOS.exe'}")
    print(f"  Carpeta: {app_dir}")
    print(f"  ZIP portable: {zip_path}")
    print(f"\nPara usar en otra PC:")
    print(f"  1. Extrae {zip_name}.zip")
    print(f"  2. Ejecuta SistemaPOS/SistemaPOS.exe")
    print(f"  3. (Opcional) Coloca firebase_key.json en la carpeta raiz")

if __name__ == '__main__':
    main()
