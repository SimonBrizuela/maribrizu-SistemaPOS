@echo off
chcp 65001 >nul
echo ============================================================
echo    SISTEMA POS - Preparar USB
echo ============================================================
echo.

set "SOURCE=dist\SistemaPOS"
set "USB_DRIVE=%1"

if "%USB_DRIVE%"=="" (
    echo Uso: build_usb.bat [letra_usb]
    echo Ejemplo: build_usb.bat E:
    echo.
    echo Letras de unidad detectadas:
    wmic logicaldisk get caption,description 2>nul
    echo.
    set /p USB_DRIVE="Ingrese letra del USB (ej: E:): "
)

if not exist "%SOURCE%" (
    echo ERROR: No se encontro la carpeta dist\SistemaPOS
    echo Ejecute primero: pyinstaller pos_system.spec --clean
    pause
    exit /b 1
)

echo Copiando Sistema POS a %USB_DRIVE%\SistemaPOS ...
if exist "%USB_DRIVE%\SistemaPOS" (
    echo Eliminando version anterior...
    rmdir /s /q "%USB_DRIVE%\SistemaPOS"
)

xcopy /E /I /H /Y "%SOURCE%" "%USB_DRIVE%\SistemaPOS" >nul
if errorlevel 1 (
    echo ERROR al copiar archivos. Verifique que el USB este conectado.
    pause
    exit /b 1
)

echo.
echo Creando acceso directo en el USB...
powershell -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%USB_DRIVE%\Sistema POS.lnk'); $s.TargetPath = '%USB_DRIVE%\SistemaPOS\SistemaPOS.exe'; $s.WorkingDirectory = '%USB_DRIVE%\SistemaPOS'; $s.Description = 'Sistema POS'; $s.Save()"

echo.
echo ============================================================
echo  LISTO! Sistema POS copiado correctamente al USB.
echo  
echo  Para ejecutar: abrir "Sistema POS.lnk" en el USB
echo  o ir a SistemaPOS\SistemaPOS.exe
echo ============================================================
pause
