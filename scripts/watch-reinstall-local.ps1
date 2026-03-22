param(
  [ValidateSet("major", "minor", "patch")]
  [string]$Bump = "patch",
  [switch]$NoBump,
  [int]$DebounceMs = 1500
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$reinstallScript = Join-Path $PSScriptRoot "reinstall-local.ps1"

if (-not (Test-Path $reinstallScript)) {
  throw "Missing reinstall script: $reinstallScript"
}

Set-Location $repoRoot

$targets = @("src", "docs", "test", "package.json", "README.md", "esbuild.mjs")

function Get-TrackedFileStateHash {
  $entries = New-Object System.Collections.Generic.List[string]

  foreach ($target in $targets) {
    $fullPath = Join-Path $repoRoot $target
    if (-not (Test-Path $fullPath)) {
      continue
    }

    $item = Get-Item $fullPath
    if ($item.PSIsContainer) {
      $files = Get-ChildItem -Path $fullPath -Recurse -File | Sort-Object FullName
      foreach ($file in $files) {
        $entries.Add("$($file.FullName)|$($file.LastWriteTimeUtc.Ticks)|$($file.Length)")
      }
      continue
    }

    $entries.Add("$($item.FullName)|$($item.LastWriteTimeUtc.Ticks)|$($item.Length)")
  }

  $content = [string]::Join("`n", $entries)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($content)
    $hashBytes = $sha.ComputeHash($bytes)
    return [Convert]::ToHexString($hashBytes)
  } finally {
    $sha.Dispose()
  }
}

$lastHash = Get-TrackedFileStateHash
Write-Host "Watching for changes. Press Ctrl+C to stop."

while ($true) {
  Start-Sleep -Milliseconds $DebounceMs
  $currentHash = Get-TrackedFileStateHash

  if ($currentHash -eq $lastHash) {
    continue
  }

  $lastHash = $currentHash
  Write-Host "Detected changes. Rebuilding and reinstalling..."

  try {
    if ($NoBump) {
      & $reinstallScript -NoBump
    } else {
      & $reinstallScript -Bump $Bump
    }
  } catch {
    Write-Warning "Auto reinstall failed: $($_.Exception.Message)"
  }
}
