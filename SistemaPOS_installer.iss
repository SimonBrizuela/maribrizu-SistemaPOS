[Setup]
AppName=Sistema POS
AppVersion=APP_VERSION_PLACEHOLDER
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppPublisher=SimonBrizuela
AppPublisherURL=https://github.com/SimonBrizuela/maribrizu-SistemaPOS
AppSupportURL=https://github.com/SimonBrizuela/maribrizu-SistemaPOS
AppUpdatesURL=https://github.com/SimonBrizuela/maribrizu-SistemaPOS
DefaultDirName={autopf}\SistemaPOS
DefaultGroupName=Sistema POS
AllowNoIcons=yes
OutputDir=installer_output
OutputBaseFilename=SistemaPOS_Setup
SetupIconFile=pos_system\assets\images\logo.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\SistemaPOS.exe
UninstallDisplayName=Sistema POS

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "desktopicon"; Description: "Crear acceso directo en el Escritorio"; GroupDescription: "Íconos adicionales:"; Flags: checkedonce
Name: "quicklaunchicon"; Description: "Crear acceso directo en Inicio rápido"; GroupDescription: "Íconos adicionales:"; Flags: unchecked; Check: not IsAdminInstallMode

[InstallDelete]
; Borra la service account que dejaron las versiones <= 3.0.53. Esa clave se
; revoca tras el rollout, pero no tiene por que seguir en disco mientras tanto.
Type: files; Name: "{app}\firebase_key.json"
Type: files; Name: "{app}\_internal\firebase_key.json"

[Files]
; Ejecutable principal
Source: "dist\SistemaPOS\SistemaPOS.exe"; DestDir: "{app}"; Flags: ignoreversion
; Config de provisioning (URL + secreto de bootstrap). Reemplaza al viejo
; firebase_key.json: la service account ya no viaja en el instalador.
Source: "dist\SistemaPOS\provision.json"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
; Carpeta interna con todas las dependencias
Source: "dist\SistemaPOS\_internal\*"; DestDir: "{app}\_internal"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Sistema POS"; Filename: "{app}\SistemaPOS.exe"
Name: "{group}\Desinstalar Sistema POS"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Sistema POS"; Filename: "{app}\SistemaPOS.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\SistemaPOS.exe"; Description: "Iniciar Sistema POS"; Flags: nowait postinstall

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
