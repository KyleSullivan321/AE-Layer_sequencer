<#
  Packages cep/ into a signed .zxp.

  A .zxp is a signed ZIP. Signing needs Adobe's ZXPSignCmd (tools/ZXPSignCmd.exe,
  from github.com/Adobe-CEP/CEP-Resources) and a code-signing certificate. A
  self-signed cert is what indie AE extensions ship with: installers accept it,
  users just see an "unverified publisher" notice.

  Password comes from $env:ZXP_CERT_PASS, falling back to $DefaultPass below.
  dist/ and *.p12 are gitignored -- never commit the certificate.

    .\build-zxp.ps1                       # build with the self-signed cert (created on first run)
    .\build-zxp.ps1 -CertPath my.p12      # sign with your own certificate
#>
[CmdletBinding()]
param(
    [string]$CertPath = "",
    [string]$Tsa      = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"
$Root        = $PSScriptRoot
$Src         = Join-Path $Root "cep"
$Dist        = Join-Path $Root "dist"
$Stage       = Join-Path $Root "dist\_stage"
$Sign        = Join-Path $Root "tools\ZXPSignCmd.exe"
$DefaultPass = "layersequencer"

if (-not (Test-Path $Sign)) {
    throw "ZXPSignCmd not found at $Sign`n" +
          "Download the x64 build from:`n" +
          "  https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD/4.1.3/x64"
}

# Version and bundle id are declared once, in the manifest. Read them, don't restate them.
[xml]$manifest = Get-Content (Join-Path $Src "CSXS\manifest.xml")
$version  = $manifest.ExtensionManifest.ExtensionBundleVersion
$bundleId = $manifest.ExtensionManifest.ExtensionBundleId
if (-not $version) { throw "Could not read ExtensionBundleVersion from manifest.xml" }
Write-Host "Packaging $bundleId $version"

$pass = if ($env:ZXP_CERT_PASS) { $env:ZXP_CERT_PASS } else { $DefaultPass }
if (-not $CertPath) {
    $CertPath = Join-Path $Root "dist\selfsigned.p12"
}

New-Item -ItemType Directory -Force -Path $Dist | Out-Null
if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null

# Ship only what the panel needs. .debug enables remote devtools and must never
# reach users -- it opens a localhost port in their After Effects.
foreach ($dir in @("CSXS", "client", "host")) {
    Copy-Item (Join-Path $Src $dir) $Stage -Recurse -Force
}
Get-ChildItem $Stage -Recurse -Force -Include ".debug", "*.log", ".DS_Store" |
    ForEach-Object { Write-Host "  excluding $($_.Name)"; Remove-Item $_.FullName -Force }

Write-Host "Staged files:"
Get-ChildItem $Stage -Recurse -File | ForEach-Object {
    Write-Host ("  " + $_.FullName.Substring($Stage.Length + 1))
}

if (-not (Test-Path $CertPath)) {
    Write-Host "Creating self-signed certificate -> $CertPath"
    & $Sign -selfSignedCert US CA "Kyle Sullivan" "Kyle Sullivan" $pass $CertPath | Write-Host
    if ($LASTEXITCODE -ne 0) { throw "certificate generation failed ($LASTEXITCODE)" }
}

$zxp = Join-Path $Dist "Layer-Sequencer-$version.zxp"
if (Test-Path $zxp) { Remove-Item $zxp -Force }

Write-Host "Signing -> $zxp"
& $Sign -sign $Stage $zxp $CertPath $pass -tsa $Tsa | Write-Host
if ($LASTEXITCODE -ne 0) {
    Write-Warning "Signing with timestamp failed; retrying without -tsa (signature will expire with the cert)"
    & $Sign -sign $Stage $zxp $CertPath $pass | Write-Host
    if ($LASTEXITCODE -ne 0) { throw "signing failed ($LASTEXITCODE)" }
}

Write-Host "Verifying"
& $Sign -verify $zxp -certInfo | Write-Host
if ($LASTEXITCODE -ne 0) { throw "verification failed ($LASTEXITCODE)" }

Remove-Item $Stage -Recurse -Force
Write-Host ""
Write-Host ("Built {0} ({1:N0} KB)" -f $zxp, ((Get-Item $zxp).Length / 1KB))
