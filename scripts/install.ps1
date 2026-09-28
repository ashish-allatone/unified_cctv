# Windows installer (PowerShell, Docker Desktop). Run from the unzipped folder:  powershell -ExecutionPolicy Bypass -File scripts\install.ps1 [-WithSim]
param([switch]$WithSim, [switch]$WithMonitoring)
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Write-Error "Docker Desktop is required: https://www.docker.com/products/docker-desktop/"; exit 1 }
function Rand { -join ((48..57 + 65..90 + 97..122) | Get-Random -Count 40 | ForEach-Object {[char]$_}) }
if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  $env_ = Get-Content .env
  foreach ($k in "INTERNAL_SECRET","TOKEN_SECRET","RELAY_INTERNAL_PASS","POSTGRES_PASSWORD") {
    $v = Rand
    if ($env_ -match "^$k=") { $env_ = $env_ -replace "^$k=.*", "$k=$v" } else { $env_ += "$k=$v" }
  }
  Set-Content .env $env_
  Write-Host "created .env with generated secrets"
}
$profiles = @(); if ($WithSim) { $profiles += "--profile","sim" }; if ($WithMonitoring) { $profiles += "--profile","monitoring" }
docker compose @profiles build
docker compose @profiles up -d
Write-Host "waiting for the API..." -NoNewline
for ($i = 0; $i -lt 60; $i++) { try { Invoke-RestMethod http://localhost:8000/api/version | Out-Null; break } catch { Write-Host "." -NoNewline; Start-Sleep 3 } }
Write-Host ""
Invoke-RestMethod http://localhost:8000/api/version
Write-Host "Installed. Console: http://localhost:8000 (admin / admin123)  Field app: /m/  API docs: /docs"
