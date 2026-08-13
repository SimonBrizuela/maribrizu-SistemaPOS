@echo off
setlocal

rem ============================================================================
rem  Sincroniza el catalogo del POS con la tienda online.
rem
rem  Corre cada 6 horas desde el Programador de tareas de Windows en la PC
rem  del local. Para instalarlo:
rem
rem      powershell -ExecutionPolicy Bypass -File scripts\instalar_sync.ps1
rem
rem  Sin esto la tienda muestra el precio y el stock del dia que se corrio el
rem  script por ultima vez. Medido: estuvo cinco dias sin correr y la tienda
rem  seguia ofreciendo productos que ya se habian vendido.
rem
rem  Todo lo que imprime queda en logs\sync_tienda.log, que se recorta solo
rem  cuando pasa de 2 MB: son 96 corridas por dia y sin recorte el archivo
rem  crece para siempre.
rem ============================================================================

cd /d "%~dp0.."

if not exist "logs" mkdir "logs"

set "LOG=logs\sync_tienda.log"

rem Recorte del log: si paso de 2 MB, la corrida anterior pasa a .1 y se arranca
rem uno nuevo. Se conserva una sola vuelta atras, que alcanza para ver que paso.
if exist "%LOG%" (
  for %%A in ("%LOG%") do if %%~zA GTR 2097152 (
    if exist "%LOG%.1" del "%LOG%.1"
    move /y "%LOG%" "%LOG%.1" >nul
  )
)

echo. >> "%LOG%"
echo ======== %date% %time% ======== >> "%LOG%"

python scripts\sync_tienda.py >> "%LOG%" 2>&1
set CODIGO=%ERRORLEVEL%

if not "%CODIGO%"=="0" (
  echo [ERROR] el sync termino con codigo %CODIGO% >> "%LOG%"
)

exit /b %CODIGO%
