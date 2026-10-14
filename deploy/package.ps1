# Builds deploy\sidekick.zip, the file you upload to S3 for the servers.
# Leaves out secrets (backend\.env), local-only configs, and node_modules.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File deploy\package.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $env:TEMP 'sidekick-package'
$zip = Join-Path $PSScriptRoot 'sidekick.zip'

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

function Copy-Folder($name, [string[]]$excludeDirs, [string[]]$excludeFiles) {
  $source = Join-Path $root $name
  $target = Join-Path $stage $name
  $arguments = @($source, $target, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  if ($excludeDirs.Count) { $arguments += '/XD'; $arguments += $excludeDirs }
  if ($excludeFiles.Count) { $arguments += '/XF'; $arguments += $excludeFiles }
  & robocopy @arguments | Out-Null
  # robocopy exit codes 0-7 mean success.
  if ($LASTEXITCODE -ge 8) { throw "Copying $name failed (robocopy exit $LASTEXITCODE)." }
}

# The server writes its own .env and config files at startup, so local ones are left out.
Copy-Folder 'backend' @('node_modules') @('.env', '*.log')
Copy-Folder 'admin-website' @() @('config.js')
Copy-Folder 'mobile-app' @() @('config.local.js')

# Safety check: no secrets or dependencies in the package.
$leaked = Get-ChildItem $stage -Recurse -Force | Where-Object { $_.Name -eq '.env' -or $_.Name -eq 'node_modules' }
if ($leaked) { throw "Refusing to package: found $($leaked.FullName -join ', ')" }

if (Test-Path $zip) { Remove-Item $zip -Force }
# tar.exe (built into Windows 10+) writes a zip that Linux unzips correctly.
& tar.exe -a -cf $zip -C $stage backend admin-website mobile-app
if ($LASTEXITCODE -ne 0) { throw 'Creating the zip failed.' }

Remove-Item $stage -Recurse -Force
Write-Host "Created $zip"
Write-Host 'Next: upload it to your S3 bucket as sidekick.zip, then start an Instance refresh (see DEPLOY-GUIDE.md).'
