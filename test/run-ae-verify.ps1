<#
  Runs test/ae_verify.jsx inside After Effects and prints the report.

  AE's -r flag mishandles paths containing spaces, and this repo almost certainly
  lives under one. So we write a shim into a space-free temp directory; the shim
  hands the real repo path to the test via LS_REPO and evalFile's it.

  ae_verify.jsx refuses to run unless the project is empty -- it creates comps and
  issues an Undo. Open a new project in AE first (File > New Project).

    .\test\run-ae-verify.ps1
    .\test\run-ae-verify.ps1 -AfterFX "C:\...\AfterFX.exe"
#>
[CmdletBinding()]
param(
    [string]$AfterFX = "",
    [int]$TimeoutSec = 60
)

$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent

if (-not $AfterFX) {
    $AfterFX = Get-ChildItem "C:\Program Files\Adobe" -Filter "AfterFX.exe" -Recurse -ErrorAction SilentlyContinue |
               Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $AfterFX -or -not (Test-Path $AfterFX)) { throw "AfterFX.exe not found; pass -AfterFX <path>" }

$result = Join-Path $repo "test\ae_result.txt"
Remove-Item $result -ErrorAction SilentlyContinue

$shimDir = Join-Path $env:TEMP "ls-ae-verify"      # no spaces
New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
$shim = Join-Path $shimDir "run.jsx"

$repoFwd = $repo -replace '\\', '/'
@"
var LS_REPO = "$repoFwd";
`$.evalFile(new File("$repoFwd/test/ae_verify.jsx"));
"@ | Set-Content $shim -Encoding UTF8

Write-Host "AE:   $AfterFX"
Write-Host "repo: $repo"
Write-Host "Running ae_verify.jsx ..."
& $AfterFX -r $shim | Out-Null

$deadline = (Get-Date).AddSeconds($TimeoutSec)
while (-not (Test-Path $result) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
if (-not (Test-Path $result)) {
    throw "No report after ${TimeoutSec}s. Is After Effects running? (a cold start can exceed the timeout)"
}

Get-Content $result
if ((Get-Content $result -Raw) -notmatch "ALL PASSED") { exit 1 }
