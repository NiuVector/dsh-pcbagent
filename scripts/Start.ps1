[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Workspace,
    [string]$Python = 'python',
    [string]$KiCadRoot,
    [string]$Freerouting,
    [string]$Profile = 'web'
)
$ErrorActionPreference = 'Stop'
$workspacePath = (Resolve-Path -LiteralPath $Workspace).Path
if (-not (Test-Path -LiteralPath $workspacePath -PathType Container)) { throw 'Workspace must be an existing directory' }
$env:PCBROUTE_ALLOWED_ROOTS = ConvertTo-Json -InputObject @($workspacePath) -Compress
$env:PCBROUTE_PYTHON = $Python
$env:PCBROUTE_ROUTER = 'freerouting'
if ($KiCadRoot) {
    $kicadBin = Join-Path (Resolve-Path -LiteralPath $KiCadRoot).Path 'bin'
    $env:PCBROUTE_KICAD_PYTHON = Join-Path $kicadBin 'python.exe'
    $env:KICAD_CLI = Join-Path $kicadBin 'kicad-cli.exe'
    foreach ($executable in @($env:PCBROUTE_KICAD_PYTHON, $env:KICAD_CLI)) {
        if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw "Missing KiCad program: $executable" }
    }
}
if ($Freerouting) { $env:PCBROUTE_FREEROUTING_EXE = (Resolve-Path -LiteralPath $Freerouting).Path }
& dsh --profile $Profile
if ($LASTEXITCODE -ne 0) { throw "DSH exited with code $LASTEXITCODE" }
