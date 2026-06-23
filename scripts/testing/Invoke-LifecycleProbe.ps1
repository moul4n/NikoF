<#
.SYNOPSIS
    Heavy lifecycle probe against the LIVE backend (Phase 1D): kill-sidecar ->
    recovery, and full restart -> survivability. Opt-in (not part of the hermetic
    unittest suite) because it boots the real stack with models.

.DESCRIPTION
    Probe A (kill-sidecar recovery): start backend, kill the STT sidecar process
    tree out from under it, confirm the worker reports it unavailable, then drive
    POST /session/stt/control {"action":"restart"} and confirm STT returns to ready.

    Probe B (restart survivability): append speech-lifecycle events, restart the
    backend (POST /system/shutdown + relaunch), and confirm (a) it comes back
    healthy, (b) the SQLite event store preserved the pre-restart stream (cursor
    continuity), and (c) a fresh turn still synthesises.

    Exit code 0 = all selected probes passed, non-zero otherwise.
#>
[CmdletBinding()]
param(
    [switch]$SkipKillRecovery,
    [switch]$SkipRestart,
    [int]$ReadyTimeoutSeconds = 150
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$backendRoot = Join-Path $repoRoot 'backend'
$venvPython = Join-Path $repoRoot '.venv\Scripts\python.exe'
$envHelper = Join-Path $repoRoot '.local\bootstrap\session-env.ps1'
$baseUrl = 'http://127.0.0.1:8000'
$failures = New-Object System.Collections.Generic.List[string]

if (Test-Path -LiteralPath $envHelper) { . $envHelper }
# Force STT onto CPU for the probe: faster to load and no GPU contention on small
# cards; persistence on so the SQLite event store is exercised across the restart.
$probeEnv = [ordered]@{
    NIKOF_TTS_ENGINE = 'kokoro'; NIKOF_STT_ENGINE = 'parakeet'; NIKOF_STT_ALLOW_GPU = '0'
    NIKOF_LLM_MODEL = 'qwen3:4b'; NIKOF_LLM_THINK = 'false'; NIKOF_LLM_STREAMING = '1'
    NIKOF_TTS_SEGMENTATION = '1'; NIKOF_PERSIST_ACTIVE_CHARACTER = '1'
}
foreach ($key in $probeEnv.Keys) { Set-Item -Path "Env:$key" -Value $probeEnv[$key] }

function Write-Step([string]$Message) { Write-Host ("[probe] {0}" -f $Message) }

function Invoke-Json([string]$Method, [string]$Path, $Body, [int]$TimeoutSec = 130) {
    $uri = $baseUrl + $Path
    if ($null -ne $Body) {
        $json = $Body | ConvertTo-Json -Depth 6
        return Invoke-RestMethod -Method $Method -Uri $uri -Body $json -ContentType 'application/json' -TimeoutSec $TimeoutSec
    }
    return Invoke-RestMethod -Method $Method -Uri $uri -TimeoutSec $TimeoutSec
}

function Test-SttReady {
    try {
        $health = Invoke-Json -Method Get -Path '/health' -TimeoutSec 4
        $stt = @($health.subsystems | Where-Object { $_.id -eq 'stt' }) | Select-Object -First 1
        return [bool]($health.status -eq 'ok' -and $stt -and $stt.ready)
    }
    catch { return $false }
}

function Wait-For([scriptblock]$Predicate, [int]$TimeoutSeconds, [string]$What) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (& $Predicate) { return $true }
        Start-Sleep -Milliseconds 750
    }
    Write-Warning ("[probe] timed out waiting for: {0}" -f $What)
    return $false
}

function Start-Backend {
    $cmd = "Set-Location '$backendRoot'; & '$venvPython' -m app.dev_server"
    $proc = Start-Process -FilePath (Get-Command pwsh -ErrorAction SilentlyContinue).Source `
        -ArgumentList @('-NoLogo', '-NoProfile', '-NoExit', '-Command', $cmd) -PassThru
    return $proc
}

function Stop-Backend {
    try { Invoke-Json -Method Post -Path '/system/shutdown' -Body @{} -TimeoutSec 6 | Out-Null } catch {}
    [void](Wait-For { -not (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue) } 20 'port 8000 to free')
}

function Get-SttSidecarPids {
    try {
        $resources = Invoke-Json -Method Get -Path '/system/resources' -TimeoutSec 6
        return @($resources.owned_processes | Where-Object { $_.label -like 'stt-sidecar*' } | ForEach-Object { [int]$_.pid })
    }
    catch { return @() }
}

function Get-NextSpeechCursorSequence($previewResponse) {
    $cursor = [string]$previewResponse.next_speech_cursor
    if ($cursor -match ':(\d+)$') { return [int]$Matches[1] }
    return -1
}

# --- bring up -------------------------------------------------------------

if (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Port 8000 is already in use; stop the running backend before the probe.'
}

Write-Step 'Starting backend ...'
$backend = Start-Backend
if (-not (Wait-For { Test-SttReady } $ReadyTimeoutSeconds 'backend STT ready')) {
    Stop-Backend
    throw 'Backend did not reach STT-ready; aborting probe.'
}
Write-Step 'Backend is up and STT is ready.'

try {
    # --- Probe A: kill-sidecar -> recovery --------------------------------
    if (-not $SkipKillRecovery) {
        Write-Step 'Probe A: kill STT sidecar, expect unavailable, then restart-recover.'
        $pids = Get-SttSidecarPids
        if ($pids.Count -eq 0) {
            $failures.Add('Probe A: could not find an STT sidecar process to kill.')
        }
        else {
            foreach ($sidecarPid in $pids) { & taskkill /PID $sidecarPid /T /F | Out-Null }
            Write-Step ("Killed STT sidecar pid(s): {0}" -f ($pids -join ', '))

            $detected = Wait-For { -not (Test-SttReady) } 30 'STT to report unavailable after kill'
            if (-not $detected) {
                $failures.Add('Probe A: backend never reported STT unavailable after the sidecar was killed.')
            }

            Write-Step 'Issuing STT restart control ...'
            Invoke-Json -Method Post -Path '/session/stt/control' -Body @{ action = 'restart' } -TimeoutSec 90 | Out-Null
            $recovered = Wait-For { Test-SttReady } 90 'STT to recover after restart control'
            if ($recovered) { Write-Step 'Probe A PASS: STT recovered after restart.' }
            else { $failures.Add('Probe A: STT did not recover after the restart control action.') }
        }
    }

    # --- Probe B: restart survivability -----------------------------------
    if (-not $SkipRestart) {
        Write-Step 'Probe B: append events, restart backend, expect survival + working turn.'
        $p1 = Invoke-Json -Method Post -Path '/session/operator-command' -Body @{ command_type = 'tts_preview'; text = 'Probe line one.'; locale = 'en-US' }
        $p2 = Invoke-Json -Method Post -Path '/session/operator-command' -Body @{ command_type = 'tts_preview'; text = 'Probe line two.'; locale = 'en-US' }
        $seqBefore = Get-NextSpeechCursorSequence $p2
        Write-Step ("Pre-restart next speech cursor sequence: {0}" -f $seqBefore)

        Write-Step 'Restarting backend (shutdown + relaunch) ...'
        Stop-Backend
        $backend = Start-Backend
        if (-not (Wait-For { Test-SttReady } $ReadyTimeoutSeconds 'backend STT ready after restart')) {
            $failures.Add('Probe B: backend did not come back healthy after restart.')
        }
        else {
            $p3 = Invoke-Json -Method Post -Path '/session/operator-command' -Body @{ command_type = 'tts_preview'; text = 'Probe line three after restart.'; locale = 'en-US' }
            $seqAfter = Get-NextSpeechCursorSequence $p3
            Write-Step ("Post-restart next speech cursor sequence: {0}; preview status: {1}" -f $seqAfter, $p3.status)
            # Persisted: the post-restart cursor continues past the pre-restart events.
            # In-memory would have reset, so seqAfter would be <= 2.
            if ($seqAfter -gt $seqBefore) { Write-Step 'Probe B PASS: event stream survived the restart (cursor continuity).' }
            else { $failures.Add("Probe B: speech-lifecycle cursor did not persist across restart (before=$seqBefore after=$seqAfter).") }
            if ($p3.status -ne 'ready') { $failures.Add("Probe B: post-restart turn did not synthesise (status=$($p3.status)).") }
        }
    }
}
finally {
    Write-Step 'Stopping backend ...'
    Stop-Backend
}

Write-Host ''
if ($failures.Count -eq 0) {
    Write-Host '[probe] ALL PROBES PASSED'
    exit 0
}
Write-Host '[probe] FAILURES:'
foreach ($failure in $failures) { Write-Host ("  - {0}" -f $failure) }
exit 1
