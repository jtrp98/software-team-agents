$ErrorActionPreference = "Stop"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$iso = Join-Path $env:TEMP "clean-machine-$stamp"
New-Item -ItemType Directory -Path $iso -Force | Out-Null

# Isolate machine state completely: fresh LOCALAPPDATA + HOME => no installation config exists.
$env:LOCALAPPDATA = Join-Path $iso "LocalAppData"
$env:USERPROFILE  = Join-Path $iso "Home"
New-Item -ItemType Directory -Path $env:LOCALAPPDATA, $env:USERPROFILE -Force | Out-Null

Write-Host "== [1] npm pack framework =="
Set-Location C:\src\AgentClaude\software-team-agents
$pack = npm pack --silent 2>$null | Select-Object -Last 1
$tgz = Join-Path (Get-Location) $pack
Write-Host "tgz: $tgz"

Write-Host "== [2] fresh project installs the package =="
$proj = Join-Path $iso "my-project"
New-Item -ItemType Directory -Path $proj -Force | Out-Null
Set-Location $proj
npm init -y *> $null
npm install $tgz --no-audit --no-fund --silent
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
$cli = Join-Path $proj "node_modules\software-team-agents\orchestrator\dist\cli.js"
if (-not (Test-Path $cli)) { throw "cli.js missing from installed package" }

Write-Host "== [3] sta init (three-repo) =="
node $cli init --mode three-repo --templates (Join-Path $proj "node_modules\software-team-agents\templates") --project-root $proj

Write-Host "== [4] fresh knowledge clone + configure =="
$kroot = Join-Path $iso "knowledge-schoolbright"
git init -q $kroot
node $cli configure knowledge-root $kroot

Write-Host "== [4b] human registers Target + local mapping (TEAM_SETUP Step 4) =="
Set-Content (Join-Path $kroot "targets.yaml") "schema_version: 1`ntargets:`n  - target_id: sb-web-helper`n    name: SB Web Helper`n    remote_url: https://github.com/Jabjai-Corporation/sb-web-helper.git`n    status: active`n"
New-Item -ItemType Directory -Path (Join-Path $kroot ".workflow") -Force | Out-Null
$t = Join-Path $iso "target-sb"
git init -q $t
Set-Content (Join-Path $kroot ".workflow\targets.local.yaml") "schema_version: 1`ntargets:`n  sb-web-helper:`n    path: $t`n"

Write-Host "== [5] doctor (against the Knowledge root, per TEAM_SETUP Step 5) =="
node $cli doctor --project-root $kroot
$code = $LASTEXITCODE

Write-Host "== [6] upgrade dry sanity (list-backups) =="
node $cli list-backups --project-root $proj

Write-Host ""
Write-Host "SMOKE RESULT: exit=$code  iso=$iso"
exit $code
