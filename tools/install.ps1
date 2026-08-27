<#
    Installer fuer das Add-on "Reddit DE - Kommentar-Uebersetzer".

    Baut das XPI, erkennt die installierte Firefox-Variante, legt den Pfad in die
    Zwischenablage und oeffnet die Ladeseite in Firefox.

    Aufruf:  powershell -ExecutionPolicy Bypass -File tools\install.ps1
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Write-Step($text) { Write-Host "`n$text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "  $text" -ForegroundColor Green }
function Write-Warn2($text){ Write-Host "  $text" -ForegroundColor Yellow }

Write-Host "===============================================" -ForegroundColor DarkGray
Write-Host " Reddit DE - Kommentar-Uebersetzer  |  Installer" -ForegroundColor White
Write-Host "===============================================" -ForegroundColor DarkGray

# --- 1. Paket bauen -------------------------------------------------------
Write-Step "1/4  Paket bauen"
$xpi = & (Join-Path $PSScriptRoot 'build.ps1') | Select-Object -Last 1
if (-not (Test-Path $xpi)) { throw "Paket konnte nicht erstellt werden." }

# --- 2. Firefox suchen ----------------------------------------------------
Write-Step "2/4  Firefox suchen"
$candidates = @(
    @{ Path = "$env:ProgramFiles\Firefox Developer Edition\firefox.exe";  Kind = 'dev' },
    @{ Path = "$env:ProgramFiles\Firefox Nightly\firefox.exe";            Kind = 'nightly' },
    @{ Path = "$env:ProgramFiles\Mozilla Firefox\firefox.exe";            Kind = 'release' },
    @{ Path = "${env:ProgramFiles(x86)}\Mozilla Firefox\firefox.exe";     Kind = 'release' },
    @{ Path = "$env:LOCALAPPDATA\Mozilla Firefox\firefox.exe";            Kind = 'release' }
)

$firefox = $null
foreach ($c in $candidates) {
    if (Test-Path $c.Path) {
        $info = (Get-Item $c.Path).VersionInfo
        $kind = $c.Kind
        # ESR und Developer Edition melden sich ueber den Produktnamen
        if ($info.ProductName -match 'Developer|Nightly') { $kind = 'dev' }
        if ($info.ProductVersion -match 'esr')            { $kind = 'esr' }
        $firefox = [pscustomobject]@{ Path = $c.Path; Kind = $kind; Version = $info.ProductVersion; Product = $info.ProductName }
        break
    }
}

if (-not $firefox) {
    Write-Warn2 "Keine Firefox-Installation gefunden."
    Write-Host  "  Bitte Firefox installieren: https://www.mozilla.org/firefox/"
    return
}
Write-Ok "$($firefox.Product) $($firefox.Version)  ->  $($firefox.Path)"

$permanentPossible = $firefox.Kind -in @('dev', 'nightly', 'esr')

# --- 3. Pfad bereitlegen --------------------------------------------------
Write-Step "3/4  Paketpfad in die Zwischenablage legen"
try {
    Set-Clipboard -Value $xpi
    Write-Ok "Kopiert: $xpi"
    Write-Host "  Im Dateidialog einfach Strg+V druecken und Enter." -ForegroundColor DarkGray
}
catch {
    Write-Warn2 "Zwischenablage nicht verfuegbar. Pfad manuell verwenden:"
    Write-Host  "  $xpi"
}

# --- 4. Ladeseite oeffnen -------------------------------------------------
Write-Step "4/4  Firefox oeffnen"
Start-Process -FilePath $firefox.Path -ArgumentList 'about:debugging#/runtime/this-firefox'
Write-Ok "Seite 'Dieser Firefox' geoeffnet."

Write-Host @"

-----------------------------------------------------------------
 Jetzt in Firefox:
   1. Auf "Temporaeres Add-on laden..." klicken
   2. Im Dateidialog Strg+V druecken (Pfad ist in der Zwischenablage)
   3. Enter

 Danach: about:addons -> Reddit DE -> Einstellungen
   - "Zugriff auf api.openai.com erlauben" anklicken
   - OpenAI-API-Key eintragen und speichern
   - offene Reddit-Tabs neu laden
-----------------------------------------------------------------
"@ -ForegroundColor White

if ($permanentPossible) {
    Write-Host @"
 Dauerhafte Installation (diese Firefox-Variante kann das):
   1. about:config -> xpinstall.signatures.required = false
   2. Das XPI per Doppelklick oder ueber about:addons -> Zahnrad ->
      "Add-on aus Datei installieren..." einspielen
"@ -ForegroundColor Green
}
else {
    Write-Host @"
 HINWEIS zur Dauerhaftigkeit:
   Diese Firefox-Ausgabe (Release) akzeptiert nur signierte Add-ons.
   Temporaer geladene Add-ons verschwinden beim Neustart von Firefox.

   Fuer eine dauerhafte Installation gibt es zwei Wege:
     a) Kostenlos bei Mozilla signieren lassen (empfohlen):
          powershell -ExecutionPolicy Bypass -File tools\sign.ps1
        Dafuer wird ein AMO-Zugang benoetigt:
          https://addons.mozilla.org/developers/addon/api/key/
     b) Firefox Developer Edition oder ESR installieren und dort
        die Signaturpruefung deaktivieren.
"@ -ForegroundColor Yellow
}
