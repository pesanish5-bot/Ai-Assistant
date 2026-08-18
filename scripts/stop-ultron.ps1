function Get-CanonicalUltronPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Assert-UltronProcessFingerprint {
    param(
        [Parameter(Mandatory = $true)]
        [System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)]
        [PSCustomObject]$Fingerprint
    )

    $role = if ($Fingerprint.role) { [string]$Fingerprint.role } else { 'unknown' }
    if (-not $Fingerprint.executable_path -or -not $Fingerprint.started_at_utc) {
        throw "Ultron launcher state has an incomplete $role process fingerprint."
    }

    try {
        $actualPath = Get-CanonicalUltronPath -Path $Process.Path
        $expectedPath = Get-CanonicalUltronPath -Path ([string]$Fingerprint.executable_path)
        $actualStartedAt = $Process.StartTime.ToUniversalTime()
        $expectedStartedAt = [DateTimeOffset]::Parse(
            [string]$Fingerprint.started_at_utc,
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::RoundtripKind
        ).UtcDateTime
    } catch {
        throw "The live $role process could not be verified safely; nothing was stopped."
    }

    if (-not $actualPath.Equals($expectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "PID $($Process.Id) no longer matches the recorded $role executable; nothing was stopped."
    }
    if ([Math]::Abs(($actualStartedAt - $expectedStartedAt).TotalSeconds) -gt 1) {
        throw "PID $($Process.Id) has been reused since the $role was launched; nothing was stopped."
    }
}

function Stop-VerifiedUltronProcessTree {
    param(
        [Parameter(Mandatory = $true)]
        [System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)]
        [string]$Role
    )

    & taskkill.exe /PID $Process.Id /T /F 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Windows could not stop the $Role process tree (PID $($Process.Id)); launcher state was retained."
    }
    try { $Process.WaitForExit(5000) | Out-Null } catch { }
    $Process.Refresh()
    if (-not $Process.HasExited) {
        throw "The $Role process tree (PID $($Process.Id)) did not stop; launcher state was retained."
    }
    Write-Host "Stopped Ultron $Role process tree $($Process.Id)."
}

function Stop-Ultron {
    $ErrorActionPreference = 'Stop'
    $projectRoot = Get-CanonicalUltronPath -Path (Split-Path -Parent $PSScriptRoot)
    $runtimeRoot = Join-Path $projectRoot '.ultron\runtime'
    $statePath = Join-Path $runtimeRoot 'processes.json'
    $lockPath = Join-Path $runtimeRoot 'launcher.lock'

    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    try {
        $launcherLock = [System.IO.File]::Open(
            $lockPath,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
    } catch {
        throw 'Another Ultron start or stop operation is already in progress.'
    }

    try {
        if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
            Write-Host 'No Ultron launcher state was found.'
            return
        }

        try {
            $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
        } catch {
            throw 'Ultron launcher state is malformed; nothing was stopped.'
        }

        if ([int]$state.schema_version -ne 1) {
            throw 'Ultron launcher state uses an unsupported schema; nothing was stopped.'
        }
        if (-not $state.project_root -or -not (Get-CanonicalUltronPath -Path ([string]$state.project_root)).Equals(
            $projectRoot,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            throw 'Ultron launcher state belongs to a different repository; nothing was stopped.'
        }
        if (-not $state.server -or -not $state.activation) {
            throw 'Ultron launcher state is missing process fingerprints; nothing was stopped.'
        }

        $targets = @(
            @{ fingerprint = $state.activation; role = 'activation host' },
            @{ fingerprint = $state.server; role = 'HUD server' }
        )
        $verified = @()
        $seenPids = @{}
        foreach ($target in $targets) {
            $processId = [int]$target.fingerprint.pid
            if ($processId -le 0 -or $seenPids.ContainsKey($processId)) {
                throw 'Ultron launcher state contains an invalid or duplicate process ID; nothing was stopped.'
            }
            $seenPids[$processId] = $true
            $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
            if ($process) {
                Assert-UltronProcessFingerprint -Process $process -Fingerprint $target.fingerprint
                $verified += @{ process = $process; role = $target.role }
            }
        }

        # Validate every live PID before stopping either tree, preventing partial
        # shutdown when a stale state file points at an unrelated reused PID.
        foreach ($target in $verified) {
            Stop-VerifiedUltronProcessTree -Process $target.process -Role $target.role
        }
        Remove-Item -LiteralPath $statePath -Force
        Write-Host 'Ultron launcher state was removed. Runtime logs were retained for diagnostics.'
    } finally {
        if ($launcherLock) { $launcherLock.Dispose() }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    Stop-Ultron
}
