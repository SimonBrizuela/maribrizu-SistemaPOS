@echo off
REM RESET DE DATOS - Sistema POS (Versión .BAT - Sin dependencias externas)
REM =============================
REM Elimina todas las ventas, cajas y dashboard de SQLite.
REM Conserva: inventario, catalogo, cajeros, rubros, promociones.
REM
REM USO:
REM   reset_datos.bat
REM
REM Siempre hace un backup de la base de datos antes de borrar.
REM NO requiere Python ni dependencias externas.

setlocal enabledelayedexpansion

REM ── Rutas ────────────────────────────────────────────────────────────────────
set DATA_DIR=%APPDATA%\SistemaPOS
set DB_PATH=%DATA_DIR%\pos_database.db
set BACKUP_DIR=%DATA_DIR%\backups
set TEMP_SQL=%TEMP%\reset_datos_temp_%RANDOM%.sql

REM ── Verificar si la DB existe ────────────────────────────────────────────────
if not exist "%DB_PATH%" (
    cls
    echo ERROR: No se encontro la base de datos en:
    echo   %DB_PATH%
    echo.
    pause
    exit /b 1
)

REM ── Mostrar menu inicial ─────────────────────────────────────────────────────
cls
echo ============================================================
echo   RESET DE DATOS - Sistema POS
echo ============================================================
echo.
echo Esto ELIMINARA permanentemente:
echo   - Todas las ventas y sus items
echo   - Todos los cierres de caja
echo   - Historial diario y mensual
echo   - Retiros y ajustes de stock
echo.
echo Se CONSERVARA:
echo   - Inventario y catalogo de productos
echo   - Cajeros / usuarios
echo   - Rubros y promociones
echo.

REM ── Primera confirmacion ────────────────────────────────────────────────────
set CONFIRM1=
set /p CONFIRM1="Confirmas el RESET TOTAL de datos? [s/N]: "
if /i not "%CONFIRM1%"=="s" (
    if /i not "%CONFIRM1%"=="si" (
        if /i not "%CONFIRM1%"=="sí" (
            if /i not "%CONFIRM1%"=="y" (
                if /i not "%CONFIRM1%"=="yes" (
                    echo Cancelado.
                    pause
                    exit /b 0
                )
            )
        )
    )
)

REM ── Segunda confirmacion ────────────────────────────────────────────────────
set CONFIRM2=
set /p CONFIRM2="Estas SEGURO? Esta accion no se puede deshacer [s/N]: "
if /i not "%CONFIRM2%"=="s" (
    if /i not "%CONFIRM2%"=="si" (
        if /i not "%CONFIRM2%"=="sí" (
            if /i not "%CONFIRM2%"=="y" (
                if /i not "%CONFIRM2%"=="yes" (
                    echo Cancelado.
                    pause
                    exit /b 0
                )
            )
        )
    )
)

REM ── Backup ──────────────────────────────────────────────────────────────────
echo.
echo [Backup] Creando copia de seguridad...

if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"

REM Generar timestamp
for /f "tokens=2-4 delims=/ " %%a in ('date /t') do (set mydate=%%c%%a%%b)
for /f "tokens=1-2 delims=/:" %%a in ('time /t') do (set mytime=%%a%%b)

REM Usar powershell para segundos exactos
for /f %%x in ('powershell -NoProfile -Command "Get-Date -Format 'ssff'"') do (set myseconds=%%x)

set TIMESTAMP=%mydate%_%mytime%%myseconds%
set BACKUP_PATH=%BACKUP_DIR%\pos_database_PRERRESET_%TIMESTAMP%.db

copy "%DB_PATH%" "%BACKUP_PATH%" >nul 2>&1
if !ERRORLEVEL! equ 0 (
    echo   OK Backup guardado en:
    echo   %BACKUP_PATH%
) else (
    echo   ERROR al crear backup
    set BACKUP_CONTINUE=
    set /p BACKUP_CONTINUE="No se pudo crear el backup. Continuar de todas formas? [s/N]: "
    if /i not "!BACKUP_CONTINUE!"=="s" (
        pause
        exit /b 1
    )
)

REM ── Reset SQLite con PowerShell ────────────────────────────────────────────
echo.
echo [SQLite] Limpiando base de datos...
echo   Archivo: %DB_PATH%

powershell -NoProfile -ExecutionPolicy Bypass -Command "
[System.Reflection.Assembly]::LoadWithPartialName('System.Data.SQLite') | Out-Null

try {
    `$DBPath = '%DB_PATH%'
    `$conn = New-Object System.Data.SQLite.SQLiteConnection(\"Data Source=`$DBPath\")
    `$conn.Open()
    
    `$tables = @('sale_items', 'sales', 'withdrawals', 'cash_register', 'stock_adjustments', 'facturas')
    
    foreach (`$table in `$tables) {
        try {
            `$cmd = `$conn.CreateCommand()
            `$cmd.CommandText = \"DELETE FROM `$table\"
            `$rows = `$cmd.ExecuteNonQuery()
            Write-Host \"  OK `$table`: `$rows filas eliminadas\"
        } catch {
            Write-Host \"  -- `$table`: no existe o error\"
        }
    }
    
    `$conn.Close()
    Write-Host ''
    Write-Host '[SQLite] Reset completado exitosamente'
} catch {
    Write-Host ''
    Write-Host 'ERROR: ' -NoNewline
    Write-Host `$_.Exception.Message -ForegroundColor Red
    Write-Host ''
    Write-Host 'Asegúrate de:'
    Write-Host '  1. La base de datos existe en: %DB_PATH%'
    Write-Host '  2. La aplicacion POS no esta abierta'
    Write-Host '  3. Tienes permiso para modificar la carpeta'
    pause
    exit 1
}
"

if !ERRORLEVEL! neq 0 (
    echo.
    echo ERROR: No se pudo limpiar la base de datos
    echo.
    pause
    exit /b 1
)

REM ── Mensaje final ───────────────────────────────────────────────────────────
echo.
echo ============================================================
echo   RESET COMPLETADO
echo ============================================================
echo   Backup en: %BACKUP_DIR%
echo.
echo IMPORTANTE:
echo   - Los datos locales han sido eliminados
echo   - Firebase NO fue sincronizado (ejecución local)
echo.
pause
