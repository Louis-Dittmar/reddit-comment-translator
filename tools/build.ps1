<#
    Baut aus dem Quellordner ein installierbares XPI-Paket.
    Aufruf:  powershell -ExecutionPolicy Bypass -File tools\build.ps1
#>

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'

# Nur diese Pfade gehoeren ins Add-on-Paket.
$include = @('manifest.json', 'src', 'icons')

$manifest = Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json
$version = $manifest.version
$name = 'reddit-de-translator'
$xpi = Join-Path $dist "$name-$version.xpi"

Write-Host "Baue $name $version ..." -ForegroundColor Cyan

# Staging-Verzeichnis, damit test/, tools/ und .claude/ garantiert draussen bleiben.
$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("ffaddon_" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging -Force | Out-Null

try {
    foreach ($item in $include) {
        $source = Join-Path $root $item
        if (-not (Test-Path $source)) { throw "Fehlt im Projekt: $item" }
        Copy-Item -Path $source -Destination $staging -Recurse -Force
    }

    New-Item -ItemType Directory -Path $dist -Force | Out-Null
    if (Test-Path $xpi) { Remove-Item $xpi -Force }

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem

    # Eintraege einzeln schreiben: die ZIP-Spezifikation verlangt "/" als
    # Trennzeichen, und Firefox liest Pakete mit "\" nicht korrekt.
    $archive = [System.IO.Compression.ZipFile]::Open($xpi, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        $stagingFull = (Resolve-Path $staging).Path.TrimEnd('\')
        foreach ($file in Get-ChildItem $staging -Recurse -File) {
            $relative = $file.FullName.Substring($stagingFull.Length + 1).Replace('\', '/')
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive, $file.FullName, $relative,
                [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    }
    finally {
        $archive.Dispose()
    }
}
finally {
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
}

$size = [math]::Round((Get-Item $xpi).Length / 1KB, 1)
Write-Host "Fertig: $xpi ($size KB)" -ForegroundColor Green

# Pfad fuer die aufrufenden Skripte zurueckgeben
$xpi
