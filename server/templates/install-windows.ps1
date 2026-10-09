# BOLZO RMM – Agent-Installation für Windows
# Aufruf in einer PowerShell als Administrator:
#   irm "__SERVER_URL__/install/windows.ps1?key=..." | iex
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

& {
  $Server   = '__SERVER_URL__'
  $Key      = '__ENROLL_KEY__'
  $Dir      = Join-Path $env:ProgramFiles 'BolzoRMMAgent'
  $NodeLine = 'latest-v22.x'
  $TaskName = 'BolzoRMMAgent'

  function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }

  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Bitte PowerShell als Administrator starten.'
  }

  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null

  # Laufenden Agent stoppen (bei Neuinstallation/Update)
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }
  Get-CimInstance Win32_Process |
    Where-Object { ($_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*BolzoRMMAgent\run.cmd*') -or ($_.Name -eq 'node.exe' -and $_.ExecutablePath -like "$Dir*") } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  $nodeExe = Join-Path $Dir 'node\node.exe'
  if (-not (Test-Path $nodeExe)) {
    Info "Lade Node.js ($NodeLine, $arch) ..."
    $sums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$NodeLine/SHASUMS256.txt").Content
    $line = ($sums -split "`n") | Where-Object { $_ -match "node-v[\d.]+-win-$arch\.zip$" } | Select-Object -First 1
    if (-not $line) { throw "Node.js-Paket für $arch nicht gefunden." }
    $hash, $file = $line.Trim() -split '\s+'
    $zip = Join-Path $env:TEMP $file
    Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$NodeLine/$file" -OutFile $zip
    if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $hash.ToLower()) { throw 'Prüfsumme stimmt nicht.' }
    $tmp = Join-Path $env:TEMP "rmm-node-$([guid]::NewGuid())"
    Expand-Archive $zip -DestinationPath $tmp -Force
    $inner = Get-ChildItem $tmp | Select-Object -First 1
    Remove-Item (Join-Path $Dir 'node') -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item $inner.FullName (Join-Path $Dir 'node')
    Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }

  Info "Lade Agent von $Server ..."
  Invoke-WebRequest -UseBasicParsing "$Server/agent/agent.js" -OutFile (Join-Path $Dir 'agent.js')

  $cfgPath = Join-Path $Dir 'config.json'
  if ((Test-Path $cfgPath) -and (Select-String -Path $cfgPath -Pattern '"secret"' -Quiet)) {
    # Neuinstallation: Kennung und Geheimnis behalten, aber die Server-Adresse aktualisieren
    $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
    $cfg.server = $Server
    $cfg | Select-Object * -ExcludeProperty revoked | ConvertTo-Json | Set-Content -Path $cfgPath -Encoding ASCII
    Info "Bestehende Registrierung behalten, Server-Adresse: $Server"
  } else {
    @{ server = $Server; enrollKey = $Key } | ConvertTo-Json | Set-Content -Path $cfgPath -Encoding ASCII
  }
  # Nur SYSTEM und Administratoren dürfen den Ordner (inkl. Geheimnis) lesen
  icacls $Dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null

  # Startskript: startet den Agent neu, falls er sich beendet (z.B. nach einem Update)
  $runner = Join-Path $Dir 'run.cmd'
  @"
@echo off
cd /d "$Dir"
:loop
for %%A in (agent.log) do if %%~zA GTR 5000000 move /y agent.log agent.old.log >nul
"$nodeExe" agent.js >> agent.log 2>&1
ping -n 6 127.0.0.1 >nul
goto loop
"@ | Set-Content -Path $runner -Encoding ASCII

  $action    = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/d /c `"$runner`""
  $trigger   = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName

  Start-Sleep -Seconds 4
  Info "Fertig! $env:COMPUTERNAME erscheint jetzt in BOLZO RMM."
  Info "Log: $Dir\agent.log"
}
