param(
  [ValidateSet("major", "minor", "patch")]
  [string]$Bump = "patch",
  [switch]$NoBump
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

function Get-CodeCliPath {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\\Microsoft VS Code\\bin\\code.cmd"),
    "C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd",
    (Join-Path $env:LOCALAPPDATA "Programs\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd"),
    "C:\\Program Files\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd"
  )

  foreach ($candidate in $candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate)) {
      continue
    }

    if (Test-Path $candidate) {
      return $candidate
    }
  }

  throw "Unable to locate VS Code CLI launcher (code.cmd). Install VS Code or update scripts/reinstall-local.ps1."
}

if (-not $NoBump) {
  Write-Host "Bumping extension version ($Bump)..."
  npm version $Bump --no-git-tag-version | Out-Null
}

Write-Host "Compiling extension..."
npm run compile

Write-Host "Packaging VSIX..."
npm run package

$manifestPath = Join-Path $repoRoot "package.json"
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$vsixPath = Join-Path $repoRoot (Join-Path "versions" ("pulse-agent-{0}.vsix" -f $manifest.version))

if (-not (Test-Path $vsixPath)) {
  throw "Expected VSIX not found: $vsixPath"
}

$codeCli = Get-CodeCliPath
Write-Host "Installing $vsixPath via $codeCli..."
& $codeCli --install-extension $vsixPath --force

Write-Host "Installed local.pulse-agent version $($manifest.version)."
Write-Host "Reload VS Code window to ensure the new extension host is active."
