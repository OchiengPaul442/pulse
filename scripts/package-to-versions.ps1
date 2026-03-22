$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

$manifestPath = Join-Path $repoRoot "package.json"
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version

$versionsDir = Join-Path $repoRoot "versions"
if (-not (Test-Path $versionsDir)) {
  New-Item -ItemType Directory -Path $versionsDir | Out-Null
}

$outPath = Join-Path $versionsDir ("pulse-agent-{0}.vsix" -f $version)

Write-Host "Packaging VSIX to $outPath..."
& npx vsce package --allow-missing-repository --out $outPath

if (-not (Test-Path $outPath)) {
  throw "Failed to create VSIX at $outPath"
}

Write-Host "Created $outPath"
