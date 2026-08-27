<#
    Laesst das Add-on kostenlos von Mozilla signieren (Kanal "unlisted",
    also ohne Veroeffentlichung im Add-on-Verzeichnis). Nur ein signiertes
    Paket laesst sich in Firefox Release dauerhaft installieren.

    Vorbereitung:
      1. Konto auf https://addons.mozilla.org anlegen
      2. Zugangsdaten erzeugen: https://addons.mozilla.org/developers/addon/api/key/
         -> "JWT issuer"  = API-Key    (user:12345678:123)
         -> "JWT secret"  = API-Secret

    Aufruf:
      powershell -ExecutionPolicy Bypass -File tools\sign.ps1
      powershell -ExecutionPolicy Bypass -File tools\sign.ps1 -ApiKey "user:..." -ApiSecret "..."
#>

param(
    [string]$ApiKey,
    [string]$ApiSecret
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'

Write-Host "=== Add-on signieren lassen ===" -ForegroundColor Cyan

# --- Voraussetzungen ------------------------------------------------------
if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
    throw "npx wurde nicht gefunden. Bitte Node.js installieren: https://nodejs.org/"
}

if (-not $ApiKey)    { $ApiKey    = Read-Host "AMO API-Key (JWT issuer)" }
if (-not $ApiSecret) { $ApiSecret = Read-Host "AMO API-Secret (JWT secret)" }

if (-not $ApiKey -or -not $ApiSecret) {
    throw "Ohne API-Key und API-Secret ist keine Signierung moeglich."
}

New-Item -ItemType Directory -Path $dist -Force | Out-Null

Write-Host "`nUebertrage das Paket an Mozilla. Das dauert meist 1-5 Minuten ..." -ForegroundColor Yellow

# web-ext laedt nur die Add-on-Dateien hoch; alles Uebrige wird ausgeschlossen.
$args = @(
    '--yes', 'web-ext@8', 'sign',
    '--source-dir', $root,
    '--artifacts-dir', $dist,
    '--channel', 'unlisted',
    '--api-key', $ApiKey,
    '--api-secret', $ApiSecret,
    '--ignore-files', 'tools/**', 'test/**', 'dist/**', '.claude/**', 'README.md', '*.bat'
)

& npx @args
if ($LASTEXITCODE -ne 0) {
    throw "Signierung fehlgeschlagen (Exit-Code $LASTEXITCODE). Haeufigste Ursachen: falsche Zugangsdaten oder die Version in manifest.json wurde bereits signiert - dann Version erhoehen."
}

$signed = Get-ChildItem $dist -Filter '*.xpi' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host "`nSigniert: $($signed.FullName)" -ForegroundColor Green

Write-Host @"

Dauerhaft installieren:
  1. Firefox oeffnen
  2. Diese Datei per Doppelklick oeffnen oder in ein Firefox-Fenster ziehen:
     $($signed.FullName)
  3. Installation bestaetigen

Bei jeder neuen Version die Versionsnummer in manifest.json erhoehen und
dieses Skript erneut ausfuehren.
"@ -ForegroundColor White

$open = Read-Host "`nJetzt in Firefox oeffnen? (j/n)"
if ($open -match '^[jy]') {
    Start-Process $signed.FullName
}
