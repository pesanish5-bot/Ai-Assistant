[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$candidates = @()
if ($env:ULTRON_VOICE_PYTHON) { $candidates += $env:ULTRON_VOICE_PYTHON }
if ($env:USERPROFILE) {
    $candidates += (Join-Path $env:USERPROFILE '.conda\envs\ultron-voice\python.exe')
}
$python = Get-Command python.exe -ErrorAction SilentlyContinue
if ($python) { $candidates += $python.Source }
$voicePython = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $voicePython) {
    throw 'Ultron voice Python was not found. Set ULTRON_VOICE_PYTHON to the reviewed environment executable.'
}

Push-Location $repoRoot
try {
    & $voicePython -m unittest discover -s voice/tests -p 'test_*.py'
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}
