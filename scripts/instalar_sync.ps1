<#
    Instala la tarea programada que sincroniza el catalogo con la tienda.

    Se corre UNA VEZ en la PC del local, con permisos de administrador:

        powershell -ExecutionPolicy Bypass -File scripts\instalar_sync.ps1

    Para sacarla:

        powershell -ExecutionPolicy Bypass -File scripts\instalar_sync.ps1 -Quitar

    Por que cada 15 minutos y no cada 5: el sync reescribe los ~2.400
    documentos publicados en cada corrida. A 15 minutos son unas 230 mil
    escrituras por mes, holgado dentro del plan gratuito de Firestore; a 5
    minutos serian 690 mil y ya se paga. Quince minutos de desfasaje en el
    stock de una libreria no se nota: el checkout revalida contra la base
    antes de confirmar, asi que un pedido nunca sale con el precio viejo.
#>

param(
    [switch]$Quitar,
    [int]$CadaMinutos = 15
)

$ErrorActionPreference = 'Stop'

$NOMBRE = 'Libreria Liceo - Sync Tienda'
$raiz = Split-Path -Parent $PSScriptRoot
$bat = Join-Path $raiz 'scripts\sync_tienda.bat'

if ($Quitar) {
    if (Get-ScheduledTask -TaskName $NOMBRE -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $NOMBRE -Confirm:$false
        Write-Host "Tarea quitada." -ForegroundColor Yellow
    } else {
        Write-Host "No estaba instalada."
    }
    return
}

if (-not (Test-Path $bat)) { throw "No encuentro $bat" }

# La clave del service account tiene que estar al lado del script: sin eso el
# sync no puede escribir y la tarea va a fallar todas las veces en silencio.
$clave = Join-Path $raiz 'firebase_key.json'
if (-not (Test-Path $clave)) {
    throw "Falta firebase_key.json en $raiz. Sin la clave el sync no puede conectarse."
}

try { python --version | Out-Null } catch { throw 'Python no esta en el PATH de esta PC.' }

$accion = New-ScheduledTaskAction -Execute $bat -WorkingDirectory $raiz

# Repite para siempre desde el arranque de sesion. `AtLogOn` y no `AtStartup`
# porque la PC del local se usa con un usuario abierto todo el dia y asi la
# tarea corre con su perfil, que es el que tiene Python instalado.
$disparador = New-ScheduledTaskTrigger -AtLogOn
$disparador.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes $CadaMinutos) `
    -RepetitionDuration ([TimeSpan]::MaxValue)).Repetition

# Sin ventana y sin frenar la PC: es una tarea de fondo que corre todo el dia.
$ajustes = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

if (Get-ScheduledTask -TaskName $NOMBRE -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $NOMBRE -Confirm:$false
}

Register-ScheduledTask -TaskName $NOMBRE -Action $accion -Trigger $disparador `
    -Settings $ajustes -Description 'Copia precios y stock del catalogo a la tienda online.' | Out-Null

Write-Host "Listo. '$NOMBRE' corre cada $CadaMinutos minutos." -ForegroundColor Green
Write-Host "Log: $(Join-Path $raiz 'logs\sync_tienda.log')"
Write-Host ""
Write-Host "Para probarla ahora mismo:" -ForegroundColor Cyan
Write-Host "  Start-ScheduledTask -TaskName '$NOMBRE'"
