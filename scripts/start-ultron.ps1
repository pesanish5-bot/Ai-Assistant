param(
    [string]$SpeakerName = '',
    [int]$MicrophoneDevice = -1,
    [int]$OutputDevice = -1,
    [ValidateSet(1, 2)]
    [int]$ClapCount = 1,
    [switch]$OpenOnly
)

function Test-LoopbackPortInUse {
    param(
        [int]$Port = 3000,
        [int]$TimeoutMilliseconds = 300
    )

    $endpoints = @(
        @([System.Net.Sockets.AddressFamily]::InterNetwork, [System.Net.IPAddress]::Loopback),
        @([System.Net.Sockets.AddressFamily]::InterNetworkV6, [System.Net.IPAddress]::IPv6Loopback)
    )
    foreach ($endpoint in $endpoints) {
        $client = [System.Net.Sockets.TcpClient]::new($endpoint[0])
        try {
            $connection = $client.ConnectAsync($endpoint[1], $Port)
            if ($connection.Wait($TimeoutMilliseconds) -and $client.Connected) {
                return $true
            }
        } catch {
            # A refused or unavailable address means this address is free.
        } finally {
            $client.Dispose()
        }
    }
    return $false
}

function Remove-DuplicateProcessEnvironmentKeys {
    # Start-Process rejects inherited environment blocks containing keys that
    # differ only by case (for example Path and PATH). Some hosts create such a
    # block, so normalize it around child launch. Effective values are restored;
    # Windows may canonicalize a duplicated key's casing in this short-lived host.
    $environment = [System.Environment]::GetEnvironmentVariables()
    $groups = @{}
    foreach ($keyObject in $environment.Keys) {
        $key = [string]$keyObject
        $normalized = $key.ToUpperInvariant()
        if (-not $groups.ContainsKey($normalized)) { $groups[$normalized] = @() }
        $groups[$normalized] += @{ name = $key; value = [string]$environment[$keyObject] }
    }

    $snapshots = @()
    foreach ($entries in $groups.Values) {
        if ($entries.Count -le 1) { continue }
        $snapshots += ,@($entries)
        foreach ($entry in $entries | Select-Object -Skip 1) {
            [System.Environment]::SetEnvironmentVariable($entry.name, $null, 'Process')
        }
    }
    return ,$snapshots
}

function Restore-DuplicateProcessEnvironmentKeys {
    param([object[]]$Snapshots)

    foreach ($entries in $Snapshots) {
        foreach ($entry in $entries) {
            [System.Environment]::SetEnvironmentVariable($entry.name, $null, 'Process')
        }
        foreach ($entry in $entries) {
            [System.Environment]::SetEnvironmentVariable($entry.name, $entry.value, 'Process')
        }
    }
}

function Invoke-UltronChildProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][object[]]$ArgumentList,
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string]$StandardOutputPath,
        [Parameter(Mandatory = $true)][string]$StandardErrorPath
    )

    $snapshots = @(Remove-DuplicateProcessEnvironmentKeys)
    try {
        return Start-Process -FilePath $FilePath `
            -ArgumentList $ArgumentList `
            -WorkingDirectory $WorkingDirectory `
            -WindowStyle Hidden `
            -RedirectStandardOutput $StandardOutputPath `
            -RedirectStandardError $StandardErrorPath `
            -PassThru
    } finally {
        Restore-DuplicateProcessEnvironmentKeys -Snapshots $snapshots
    }
}

function Get-UltronProcessFingerprint {
    param(
        [Parameter(Mandatory = $true)]
        [System.Diagnostics.Process]$Process,
        [Parameter(Mandatory = $true)]
        [string]$Role
    )

    $Process.Refresh()
    if ($Process.HasExited) {
        throw "The $Role process exited before launcher state could be recorded."
    }

    try {
        $executablePath = $Process.Path
        $startedAt = $Process.StartTime.ToUniversalTime().ToString('o')
    } catch {
        throw "The $Role process fingerprint could not be read safely."
    }

    return @{
        role = $Role
        pid = $Process.Id
        executable_path = [System.IO.Path]::GetFullPath($executablePath)
        started_at_utc = $startedAt
    }
}

function Stop-NewUltronProcessTree {
    param([System.Diagnostics.Process]$Process)

    if (-not $Process) { return }
    $Process.Refresh()
    if ($Process.HasExited) { return }

    & taskkill.exe /PID $Process.Id /T /F 2>&1 | Out-Null
    try { $Process.WaitForExit(5000) | Out-Null } catch { }
}

function Start-Ultron {
    param(
        [string]$SpeakerName = '',
        [int]$MicrophoneDevice = -1,
        [int]$OutputDevice = -1,
        [switch]$OpenOnly
    )

    $ErrorActionPreference = 'Stop'
    $projectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\', '/')
    $runtimeRoot = Join-Path $projectRoot '.ultron\runtime'
    $statePath = Join-Path $runtimeRoot 'processes.json'
    $lockPath = Join-Path $runtimeRoot 'launcher.lock'
    $nextCli = Join-Path $projectRoot 'node_modules\next\dist\bin\next'

    if (-not (Test-Path -LiteralPath $nextCli -PathType Leaf)) {
        throw 'Next.js dependencies are missing. Install the repository dependencies first.'
    }

    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand -or -not (Test-Path -LiteralPath $nodeCommand.Source -PathType Leaf)) {
        throw 'Node.js was not found on PATH.'
    }

    $pythonCandidates = @()
    if ($env:ULTRON_VOICE_PYTHON) { $pythonCandidates += $env:ULTRON_VOICE_PYTHON }
    if ($env:USERPROFILE) {
        $pythonCandidates += (Join-Path $env:USERPROFILE '.conda\envs\ultron-voice\python.exe')
    }
    $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($pythonCommand) { $pythonCandidates += $pythonCommand.Source }
    $voicePython = $pythonCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $voicePython) {
        throw 'Ultron voice Python was not found. Set ULTRON_VOICE_PYTHON to the reviewed environment executable.'
    }
    $voicePython = [System.IO.Path]::GetFullPath($voicePython)

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

    $server = $null
    $activation = $null
    $tokenBytes = $null
    $eventToken = $null
    $stateTemporaryPath = $null
    $activationReadyPath = Join-Path $runtimeRoot ("activation-ready.{0}.signal" -f [Guid]::NewGuid().ToString('N'))
    $normalizedSpeakerName = $SpeakerName.Trim()
    $hadPreviousToken = Test-Path Env:ULTRON_LOCAL_EVENT_TOKEN
    $previousToken = $env:ULTRON_LOCAL_EVENT_TOKEN
    $hadPreviousSpeakerName = Test-Path Env:ULTRON_SPEAKER_NAME
    $previousSpeakerName = $env:ULTRON_SPEAKER_NAME
    $hadPreviousReadyFile = Test-Path Env:ULTRON_ACTIVATION_READY_FILE
    $previousReadyFile = $env:ULTRON_ACTIVATION_READY_FILE

    try {
        if (Test-Path -LiteralPath $statePath -PathType Leaf) {
            try {
                $oldState = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
            } catch {
                throw 'Ultron launcher state is malformed. Inspect it before starting another instance.'
            }

            $recordedPids = @()
            if ($oldState.server -and $oldState.server.pid) { $recordedPids += [int]$oldState.server.pid }
            if ($oldState.activation -and $oldState.activation.pid) { $recordedPids += [int]$oldState.activation.pid }
            if ($oldState.server_pid) { $recordedPids += [int]$oldState.server_pid }
            if ($oldState.activation_pid) { $recordedPids += [int]$oldState.activation_pid }
            $live = @($recordedPids | Select-Object -Unique | Where-Object {
                $_ -gt 0 -and (Get-Process -Id $_ -ErrorAction SilentlyContinue)
            })
            if ($live.Count -gt 0) {
                throw 'Ultron launcher state references a live process. Run scripts\stop-ultron.ps1 first.'
            }
            Remove-Item -LiteralPath $statePath -Force
        }

        if (Test-LoopbackPortInUse -Port 3000) {
            throw 'TCP port 3000 already has a loopback listener. Stop the existing server before starting Ultron.'
        }

        foreach ($logName in @('server.out.log', 'server.err.log', 'activation.out.log', 'activation.err.log')) {
            $logPath = Join-Path $runtimeRoot $logName
            if (Test-Path -LiteralPath $logPath -PathType Leaf) {
                Remove-Item -LiteralPath $logPath -Force
            }
        }

        $tokenBytes = New-Object byte[] 32
        $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $random.GetBytes($tokenBytes) } finally { $random.Dispose() }
        $eventToken = [Convert]::ToBase64String($tokenBytes)
        $env:ULTRON_LOCAL_EVENT_TOKEN = $eventToken

        # Launch Node directly so the stored PID owns the complete Next.js tree,
        # rather than pointing at a short-lived next.cmd wrapper.
        $server = Invoke-UltronChildProcess `
            -FilePath $nodeCommand.Source `
            -ArgumentList @("`"$nextCli`"", 'dev', '--hostname', 'localhost', '--port', '3000') `
            -WorkingDirectory $projectRoot `
            -StandardOutputPath (Join-Path $runtimeRoot 'server.out.log') `
            -StandardErrorPath (Join-Path $runtimeRoot 'server.err.log')

        $ready = $false
        foreach ($attempt in 1..40) {
            $server.Refresh()
            if ($server.HasExited) { throw 'Ultron HUD server exited during startup.' }
            try {
                $readyEvent = @{
                    name = 'voice.listening'
                    timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
                    payload = @{ active = $false }
                } | ConvertTo-Json -Compress
                $response = Invoke-WebRequest `
                    -Uri 'http://localhost:3000/api/interaction' `
                    -Method Post `
                    -Headers @{ Authorization = "Bearer $eventToken" } `
                    -ContentType 'application/json' `
                    -Body $readyEvent `
                    -UseBasicParsing `
                    -TimeoutSec 1
                if ($response.StatusCode -eq 200) { $ready = $true; break }
            } catch {
                Start-Sleep -Milliseconds 250
            }
        }
        if (-not $ready) {
            throw 'Ultron HUD did not become ready with the launcher event token.'
        }

        # Speaker identity and the readiness channel travel in the inherited
        # process environment. Start-Process joins ArgumentList strings, which
        # can split a multi-word identity or a repository path containing spaces.
        if ($normalizedSpeakerName) {
            $env:ULTRON_SPEAKER_NAME = $normalizedSpeakerName
        }
        $env:ULTRON_ACTIVATION_READY_FILE = $activationReadyPath

        $activationArguments = @('-m', 'voice.run_background')
        if ($MicrophoneDevice -ge 0) { $activationArguments += @('--microphone-device', $MicrophoneDevice) }
        if ($OutputDevice -ge 0) { $activationArguments += @('--output-device', $OutputDevice) }
        $activationArguments += @('--clap-count', $ClapCount)
        if ($OpenOnly) { $activationArguments += '--open-only' }
        $activation = Invoke-UltronChildProcess `
            -FilePath $voicePython `
            -ArgumentList $activationArguments `
            -WorkingDirectory $projectRoot `
            -StandardOutputPath (Join-Path $runtimeRoot 'activation.out.log') `
            -StandardErrorPath (Join-Path $runtimeRoot 'activation.err.log')

        $activationReady = $false
        foreach ($attempt in 1..80) {
            $activation.Refresh()
            if ($activation.HasExited) {
                throw 'Ultron activation host exited before session and microphone readiness.'
            }
            if (Test-Path -LiteralPath $activationReadyPath -PathType Leaf) {
                $activationReady = $true
                break
            }
            Start-Sleep -Milliseconds 250
        }
        if (-not $activationReady) {
            throw 'Ultron activation host did not confirm session and microphone readiness.'
        }

        # Catch a detector that fails immediately after opening the device.
        Start-Sleep -Milliseconds 200
        $activation.Refresh()
        if ($activation.HasExited) {
            throw 'Ultron activation host exited immediately after becoming ready.'
        }
        Remove-Item -LiteralPath $activationReadyPath -Force

        $state = @{
            schema_version = 1
            project_root = $projectRoot
            started_at = [DateTimeOffset]::Now.ToString('o')
            server = Get-UltronProcessFingerprint -Process $server -Role 'hud_server'
            activation = Get-UltronProcessFingerprint -Process $activation -Role 'activation_host'
            # Retained for concise status inspection and old tooling compatibility.
            server_pid = $server.Id
            activation_pid = $activation.Id
        }
        $stateTemporaryPath = Join-Path $runtimeRoot ("processes.{0}.tmp" -f [Guid]::NewGuid().ToString('N'))
        $state | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $stateTemporaryPath -Encoding UTF8
        Move-Item -LiteralPath $stateTemporaryPath -Destination $statePath
        $stateTemporaryPath = $null

        Write-Host 'Ultron is running locally at http://localhost:3000'
        Write-Host "HUD server PID: $($server.Id); activation host PID: $($activation.Id)"
        Write-Host 'No Windows startup entry, service, or credential provider was installed.'
        Write-Host 'Run scripts\stop-ultron.ps1 to stop both process trees.'
    } catch {
        Stop-NewUltronProcessTree -Process $activation
        Stop-NewUltronProcessTree -Process $server
        if ($stateTemporaryPath -and (Test-Path -LiteralPath $stateTemporaryPath -PathType Leaf)) {
            Remove-Item -LiteralPath $stateTemporaryPath -Force -ErrorAction SilentlyContinue
        }
        throw
    } finally {
        if ($hadPreviousToken) {
            $env:ULTRON_LOCAL_EVENT_TOKEN = $previousToken
        } else {
            Remove-Item Env:ULTRON_LOCAL_EVENT_TOKEN -ErrorAction SilentlyContinue
        }
        if ($hadPreviousSpeakerName) {
            $env:ULTRON_SPEAKER_NAME = $previousSpeakerName
        } else {
            Remove-Item Env:ULTRON_SPEAKER_NAME -ErrorAction SilentlyContinue
        }
        if ($hadPreviousReadyFile) {
            $env:ULTRON_ACTIVATION_READY_FILE = $previousReadyFile
        } else {
            Remove-Item Env:ULTRON_ACTIVATION_READY_FILE -ErrorAction SilentlyContinue
        }
        if ($activationReadyPath -and (Test-Path -LiteralPath $activationReadyPath -PathType Leaf)) {
            Remove-Item -LiteralPath $activationReadyPath -Force -ErrorAction SilentlyContinue
        }
        if ($tokenBytes) { [Array]::Clear($tokenBytes, 0, $tokenBytes.Length) }
        $eventToken = $null
        $normalizedSpeakerName = $null
        if ($launcherLock) { $launcherLock.Dispose() }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    Start-Ultron @PSBoundParameters
}
