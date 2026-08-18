$ErrorActionPreference = 'Stop'

function Assert-LauncherTest {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not $Condition) { throw $Message }
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$startScript = Join-Path $repoRoot 'scripts\start-ultron.ps1'
$stopScript = Join-Path $repoRoot 'scripts\stop-ultron.ps1'

$parseErrors = @()
[System.Management.Automation.Language.Parser]::ParseFile($startScript, [ref]$null, [ref]$parseErrors) | Out-Null
Assert-LauncherTest ($parseErrors.Count -eq 0) "start-ultron.ps1 has parser errors: $($parseErrors -join '; ')"
$parseErrors = @()
[System.Management.Automation.Language.Parser]::ParseFile($stopScript, [ref]$null, [ref]$parseErrors) | Out-Null
Assert-LauncherTest ($parseErrors.Count -eq 0) "stop-ultron.ps1 has parser errors: $($parseErrors -join '; ')"

. $startScript
. $stopScript

# Use an ephemeral listener so this test never touches the active Ultron port.
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
try {
    $testPort = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    Assert-LauncherTest (Test-LoopbackPortInUse -Port $testPort -TimeoutMilliseconds 100) `
        'The launcher did not detect an occupied loopback port.'
} finally {
    $listener.Stop()
}

if ([System.Net.Sockets.Socket]::OSSupportsIPv6) {
    $ipv6Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::IPv6Loopback, 0)
    $ipv6Listener.Start()
    try {
        $ipv6TestPort = ([System.Net.IPEndPoint]$ipv6Listener.LocalEndpoint).Port
        Assert-LauncherTest (Test-LoopbackPortInUse -Port $ipv6TestPort -TimeoutMilliseconds 100) `
            'The launcher did not detect an occupied IPv6 loopback port.'
    } finally {
        $ipv6Listener.Stop()
    }
}

# Ensure duplicate environment-key casing is normalized for Start-Process.
# Some automation hosts inject both Path and PATH, which otherwise makes
# Windows PowerShell throw before it can launch a child process.
$effectivePathBefore = [System.Environment]::GetEnvironmentVariable('Path', 'Process')
$environmentSnapshots = @(Remove-DuplicateProcessEnvironmentKeys)
try {
    $child = Start-Process -FilePath (Get-Command cmd.exe).Source `
        -ArgumentList @('/d', '/c', 'exit 0') `
        -WindowStyle Hidden `
        -PassThru
    $child.WaitForExit()
    Assert-LauncherTest ($child.ExitCode -eq 0) 'A normalized child process did not exit cleanly.'
} finally {
    Restore-DuplicateProcessEnvironmentKeys -Snapshots $environmentSnapshots
}
Assert-LauncherTest (
    [System.Environment]::GetEnvironmentVariable('Path', 'Process') -eq $effectivePathBefore
) 'Environment normalization did not restore the effective Path value.'

# Exercise the same inherited process-environment channel used for a private,
# potentially multi-word speaker identity. No command-line quoting is involved.
$speakerOutputPath = Join-Path ([System.IO.Path]::GetTempPath()) ("ultron-speaker-{0}.out" -f [Guid]::NewGuid().ToString('N'))
$speakerErrorPath = Join-Path ([System.IO.Path]::GetTempPath()) ("ultron-speaker-{0}.err" -f [Guid]::NewGuid().ToString('N'))
$hadSpeakerName = Test-Path Env:ULTRON_SPEAKER_NAME
$previousSpeakerName = $env:ULTRON_SPEAKER_NAME
try {
    $env:ULTRON_SPEAKER_NAME = 'Test User'
    $readSpeakerCommand = "[Console]::Out.Write([Environment]::GetEnvironmentVariable('ULTRON_SPEAKER_NAME','Process'))"
    $encodedReadSpeakerCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($readSpeakerCommand))
    $speakerChild = Invoke-UltronChildProcess `
        -FilePath ([System.Diagnostics.Process]::GetCurrentProcess().Path) `
        -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encodedReadSpeakerCommand) `
        -WorkingDirectory $repoRoot `
        -StandardOutputPath $speakerOutputPath `
        -StandardErrorPath $speakerErrorPath
    $speakerChild.WaitForExit()
    $speakerChild.Refresh()
    Assert-LauncherTest $speakerChild.HasExited 'The speaker environment child did not exit cleanly.'
    $speakerRoundTrip = (Get-Content -Raw -LiteralPath $speakerOutputPath).Trim()
    Assert-LauncherTest ($speakerRoundTrip -eq 'Test User') `
        'A multi-word speaker identity did not survive the child-process environment round trip.'
} finally {
    if ($hadSpeakerName) {
        $env:ULTRON_SPEAKER_NAME = $previousSpeakerName
    } else {
        Remove-Item Env:ULTRON_SPEAKER_NAME -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $speakerOutputPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $speakerErrorPath -Force -ErrorAction SilentlyContinue
}

$currentProcess = [System.Diagnostics.Process]::GetCurrentProcess()
$fingerprint = Get-UltronProcessFingerprint -Process $currentProcess -Role 'test_process'
Assert-UltronProcessFingerprint -Process $currentProcess -Fingerprint ([PSCustomObject]$fingerprint)

$forgedFingerprint = [PSCustomObject]@{
    role = 'test_process'
    pid = $currentProcess.Id
    executable_path = (Join-Path $repoRoot 'not-the-current-process.exe')
    started_at_utc = $fingerprint.started_at_utc
}
$rejectedForgedFingerprint = $false
try {
    Assert-UltronProcessFingerprint -Process $currentProcess -Fingerprint $forgedFingerprint
} catch {
    $rejectedForgedFingerprint = $true
}
Assert-LauncherTest $rejectedForgedFingerprint 'The stopper accepted a forged process fingerprint.'

$startText = Get-Content -Raw -LiteralPath $startScript
Assert-LauncherTest ($startText -match 'Invoke-UltronChildProcess\s+`\s*\r?\n\s*-FilePath\s+\$nodeCommand\.Source') `
    'The HUD server must be launched directly through node.exe.'
Assert-LauncherTest ($startText -notmatch '(?mi)^\s*(event_token|token)\s*=') `
    'Launcher state must not persist the local event token.'
Assert-LauncherTest ($startText -notmatch 'New-ScheduledTask|Register-ScheduledTask|CurrentVersion\\Run') `
    'The manual launcher must not register Windows startup persistence.'
Assert-LauncherTest ($startText -notmatch "--speaker-name") `
    'A multi-word speaker identity must not be passed through Start-Process ArgumentList.'
Assert-LauncherTest ($startText -match 'ULTRON_SPEAKER_NAME') `
    'The launcher must hand the private speaker identity to the Python host through its environment.'
Assert-LauncherTest ($startText -match 'ULTRON_ACTIVATION_READY_FILE') `
    'The launcher must provide an activation readiness channel to the Python host.'
Assert-LauncherTest ($startText -match 'did not confirm session and microphone readiness') `
    'The launcher must fail unless the activation host explicitly reports readiness.'

$stopText = Get-Content -Raw -LiteralPath $stopScript
$lockOpenIndex = $stopText.IndexOf('[System.IO.File]::Open(')
$stateCheckIndex = $stopText.IndexOf('Test-Path -LiteralPath $statePath')
Assert-LauncherTest ($lockOpenIndex -ge 0 -and $stateCheckIndex -gt $lockOpenIndex) `
    'The stopper must acquire the launcher lock before checking launcher state.'

Write-Host 'Launcher lifecycle tests passed.'
