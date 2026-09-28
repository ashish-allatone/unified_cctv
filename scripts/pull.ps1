# Pull a new unified-cctv-pilot.zip onto this machine without touching the live configuration.
#
#   powershell -ExecutionPolicy Bypass -File D:\unified-cctv\scripts\pull.ps1 -Zip "$env:USERPROFILE\Downloads\unified-cctv-pilot.zip"
#
# Keeps: .env, config\sources.yaml, config\hotlists.yaml, config\analytics.yaml, config\license.json, data\.
# Replaces everything else with the code in the zip, then rebuilds and restarts the containers.
param(
    [string]$Zip = "$env:USERPROFILE\Downloads\unified-cctv-pilot.zip",
    [string]$Dest = "D:\unified-cctv",
    [switch]$NoRestart
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path $Zip)) { throw "zip not found: $Zip" }

$tmp = Join-Path $env:TEMP ("uvp-pull-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
Write-Host "extracting $Zip ..."
Expand-Archive -Path $Zip -DestinationPath $tmp -Force
$src = Join-Path $tmp "unified-cctv"
if (-not (Test-Path $src)) { $src = $tmp }

# never overwrite the live configuration / secrets / data
$keep = @(".env", "config\sources.yaml", "config\hotlists.yaml", "config\analytics.yaml", "config\license.json", "data", "recordings")
foreach ($k in $keep) {
    $p = Join-Path $src $k
    if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}

if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Path $Dest | Out-Null }
$backup = Join-Path $Dest ("_previous_" + (Get-Date -Format "yyyyMMdd_HHmmss"))
New-Item -ItemType Directory -Path $backup | Out-Null
foreach ($d in @("platform", "scripts", "deploy", "docs", "tests", "simulators", "docker-compose.yml", "README.md", "VERSION")) {
    $p = Join-Path $Dest $d
    if (Test-Path $p) { Move-Item $p (Join-Path $backup $d) -Force }
}
Write-Host "copying code into $Dest (previous code kept in $backup) ..."
Copy-Item (Join-Path $src "*") $Dest -Recurse -Force

# first install: create the config files from the examples
if (-not (Test-Path (Join-Path $Dest ".env"))) {
    Copy-Item (Join-Path $Dest ".env.example") (Join-Path $Dest ".env")
    Write-Host "created .env from .env.example - fill in CORP8_USER / CORP8_PASS / S3_* before starting" -ForegroundColor Yellow
}
foreach ($pair in @(@("config\sources.corp8.yaml", "config\sources.yaml"), @("config\analytics.corp8.yaml", "config\analytics.yaml"))) {
    $to = Join-Path $Dest $pair[1]
    if (-not (Test-Path $to) -and (Test-Path (Join-Path $Dest $pair[0]))) { Copy-Item (Join-Path $Dest $pair[0]) $to; Write-Host "created $($pair[1]) from $($pair[0])" -ForegroundColor Yellow }
}
if (-not (Test-Path (Join-Path $Dest "config\hotlists.yaml"))) { Set-Content (Join-Path $Dest "config\hotlists.yaml") "sources: []`n" }
Remove-Item $tmp -Recurse -Force

Write-Host ("version now: " + (Get-Content (Join-Path $Dest "VERSION")))
if ($NoRestart) { Write-Host "done (no restart). Run: docker compose build; docker compose up -d"; exit 0 }
Push-Location $Dest
try {
    docker compose build
    docker compose up -d
    docker compose ps
} finally { Pop-Location }
Write-Host "done. Console: http://localhost:8000  (Ctrl+F5 once if the page looks old)"
