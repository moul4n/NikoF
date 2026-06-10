[CmdletBinding()]
param(
    [int]$Port = 8765,
    [switch]$OpenBrowser,
    [switch]$AutoStartFrontend,
    [switch]$AutoStartBackend
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$frontendRoot = Join-Path $repoRoot 'frontend'
$backendRoot = Join-Path $repoRoot 'backend'
$backendPython = Join-Path $repoRoot '.venv\Scripts\python.exe'

$shellCandidates = @()
$resolvedShell = Get-Command pwsh -ErrorAction SilentlyContinue
if ($null -ne $resolvedShell) {
    $shellCandidates += $resolvedShell.Source
}

$resolvedShell = Get-Command powershell -ErrorAction SilentlyContinue
if ($null -ne $resolvedShell) {
    $shellCandidates += $resolvedShell.Source
}

if ($env:ProgramFiles) {
    $shellCandidates += (Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe')
}
if ($env:ProgramW6432) {
    $shellCandidates += (Join-Path $env:ProgramW6432 'PowerShell\7\pwsh.exe')
}
if ($env:LocalAppData) {
    $shellCandidates += (Join-Path $env:LocalAppData 'Microsoft\WindowsApps\pwsh.exe')
}
if ($env:SystemRoot) {
    $shellCandidates += (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
}

$shellExe = $shellCandidates |
    Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
    Select-Object -First 1

if ($null -eq $shellExe) {
    throw 'Could not locate a usable PowerShell executable.'
}

function ConvertTo-ListeningProcessInfo {
    param($Listener)

    if ($null -eq $Listener) {
        return $null
    }

    $process = Get-Process -Id $Listener.OwningProcess -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return [pscustomobject]@{
            pid = [int]$Listener.OwningProcess
            process_name = $null
            path = $null
        }
    }

    return [pscustomobject]@{
        pid = [int]$process.Id
        process_name = $process.ProcessName
        path = $process.Path
    }
}

function Get-ListeningProcessInfo {
    param([Parameter(Mandatory)][int]$PortNumber)

    $listener = Get-NetTCPConnection -LocalPort $PortNumber -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    return ConvertTo-ListeningProcessInfo -Listener $listener
}

function Get-ListeningProcessMap {
    # Resolve several ports from a SINGLE Get-NetTCPConnection enumeration.
    # On a busy machine the per-port CIM query costs ~1.4s each, so probing
    # 3 ports separately dominated the status build (~4s) and — because the
    # listener is single-threaded — let polls pile up. One enumeration is ~1.2s.
    param([Parameter(Mandatory)][int[]]$Ports)

    $map = @{}
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)
    foreach ($port in $Ports) {
        $listener = $listeners | Where-Object { $_.LocalPort -eq $port } | Select-Object -First 1
        $map[$port] = ConvertTo-ListeningProcessInfo -Listener $listener
    }
    return $map
}

function Stop-ProcessTreeByPid {
    param([Parameter(Mandatory)][int]$TargetPid)

    try {
        & taskkill /PID $TargetPid /T /F | Out-Null
        return $true
    }
    catch {
        return $false
    }
}

function Test-ExpectedProcessName {
    param(
        [Parameter()]$ProcessInfo,
        [Parameter(Mandatory)][string[]]$ExpectedNames
    )

    if ($null -eq $ProcessInfo) {
        return $false
    }

    # PID visible but process metadata unavailable (already exited, or access
    # denied) — never treat an unidentifiable process as ours.
    if ([string]::IsNullOrWhiteSpace([string]$ProcessInfo.process_name)) {
        return $false
    }

    foreach ($name in $ExpectedNames) {
        if ($ProcessInfo.process_name -ieq $name) {
            return $true
        }
    }
    return $false
}

function Wait-ForPortFree {
    param(
        [Parameter(Mandatory)][int]$PortNumber,
        [int]$TimeoutSeconds = 10
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($null -eq (Get-ListeningProcessInfo -PortNumber $PortNumber)) {
            return $true
        }
        Start-Sleep -Milliseconds 250
    }
    return ($null -eq (Get-ListeningProcessInfo -PortNumber $PortNumber))
}

function Wait-ForPortListening {
    param(
        [Parameter(Mandatory)][int]$PortNumber,
        [int]$TimeoutSeconds = 12
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($null -ne (Get-ListeningProcessInfo -PortNumber $PortNumber)) {
            return $true
        }
        Start-Sleep -Milliseconds 250
    }
    return ($null -ne (Get-ListeningProcessInfo -PortNumber $PortNumber))
}

function Invoke-JsonGet {
    param([Parameter(Mandatory)][string]$Url)

    try {
        return Invoke-RestMethod -Method Get -Uri $Url -TimeoutSec 2
    }
    catch {
        return $null
    }
}

function Invoke-JsonPost {
    param(
        [Parameter(Mandatory)][string]$Url,
        [Parameter(Mandatory)][hashtable]$Body
    )

    $jsonBody = $Body | ConvertTo-Json -Depth 8
    try {
        return Invoke-RestMethod -Method Post -Uri $Url -TimeoutSec 6 -ContentType 'application/json' -Body $jsonBody
    }
    catch {
        throw $_
    }
}

function Start-Frontend {
    $existing = Get-ListeningProcessInfo -PortNumber 5173
    if ($null -ne $existing) {
        if (Test-ExpectedProcessName -ProcessInfo $existing -ExpectedNames @('node')) {
            return [pscustomobject]@{ ok = $true; message = 'Frontend already running.' }
        }
        return [pscustomobject]@{ ok = $false; message = "Port 5173 is held by '$($existing.process_name)' (pid $($existing.pid)), which is not the frontend dev server. Free the port and retry." }
    }

    if (-not (Test-Path -LiteralPath $frontendRoot -PathType Container)) {
        return [pscustomobject]@{ ok = $false; message = 'Frontend folder is missing.' }
    }

    $command = "Set-Location '$frontendRoot'; npm run dev"
    Start-Process -FilePath $shellExe -ArgumentList @('-NoLogo', '-NoProfile', '-NoExit', '-Command', $command) -WorkingDirectory $frontendRoot | Out-Null

    if (Wait-ForPortListening -PortNumber 5173) {
        return [pscustomobject]@{ ok = $true; message = 'Frontend started and listening on 5173.' }
    }
    return [pscustomobject]@{ ok = $true; message = 'Frontend start requested; not listening on 5173 yet (still warming up).' }
}

function Stop-Frontend {
    $existing = Get-ListeningProcessInfo -PortNumber 5173
    if ($null -eq $existing) {
        return [pscustomobject]@{ ok = $true; message = 'Frontend is already stopped.' }
    }

    if (-not (Test-ExpectedProcessName -ProcessInfo $existing -ExpectedNames @('node'))) {
        return [pscustomobject]@{ ok = $false; message = "Port 5173 is held by '$($existing.process_name)' (pid $($existing.pid)), which is not the frontend dev server. Refusing to kill it." }
    }

    $stopped = Stop-ProcessTreeByPid -TargetPid $existing.pid
    if (-not $stopped) {
        return [pscustomobject]@{ ok = $false; message = "Failed to stop frontend pid $($existing.pid)." }
    }

    if (Wait-ForPortFree -PortNumber 5173) {
        return [pscustomobject]@{ ok = $true; message = "Frontend stopped (pid $($existing.pid))." }
    }
    return [pscustomobject]@{ ok = $false; message = "Frontend pid $($existing.pid) was killed but port 5173 is still busy." }
}

function Start-Backend {
    $existing = Get-ListeningProcessInfo -PortNumber 8000
    if ($null -ne $existing) {
        if (Test-ExpectedProcessName -ProcessInfo $existing -ExpectedNames @('python')) {
            return [pscustomobject]@{ ok = $true; message = 'Backend already running.' }
        }
        return [pscustomobject]@{ ok = $false; message = "Port 8000 is held by '$($existing.process_name)' (pid $($existing.pid)), which is not the backend. Free the port and retry." }
    }

    if (-not (Test-Path -LiteralPath $backendPython -PathType Leaf)) {
        return [pscustomobject]@{ ok = $false; message = "Backend Python not found at $backendPython" }
    }

    $command = "Set-Location '$backendRoot'; & '$backendPython' -m app.dev_server"
    Start-Process -FilePath $shellExe -ArgumentList @('-NoLogo', '-NoProfile', '-NoExit', '-Command', $command) -WorkingDirectory $backendRoot | Out-Null

    if (Wait-ForPortListening -PortNumber 8000) {
        return [pscustomobject]@{ ok = $true; message = 'Backend started and listening on 8000.' }
    }
    return [pscustomobject]@{ ok = $true; message = 'Backend start requested; not listening on 8000 yet (still warming up).' }
}

function Stop-Backend {
    $existing = Get-ListeningProcessInfo -PortNumber 8000
    if ($null -eq $existing) {
        return [pscustomobject]@{ ok = $true; message = 'Backend is already stopped.' }
    }

    if (-not (Test-ExpectedProcessName -ProcessInfo $existing -ExpectedNames @('python'))) {
        return [pscustomobject]@{ ok = $false; message = "Port 8000 is held by '$($existing.process_name)' (pid $($existing.pid)), which is not the backend. Refusing to kill it." }
    }

    # Graceful first: lets the backend's lifespan shutdown stop its STT/TTS/LLM
    # sidecars cleanly instead of orphaning them under a tree-kill.
    $graceful = $false
    try {
        Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8000/system/shutdown' -TimeoutSec 3 | Out-Null
        $graceful = Wait-ForPortFree -PortNumber 8000 -TimeoutSeconds 25
    }
    catch {
        $graceful = $false
    }
    if ($graceful) {
        return [pscustomobject]@{ ok = $true; message = "Backend stopped gracefully (pid $($existing.pid))." }
    }

    $stopped = Stop-ProcessTreeByPid -TargetPid $existing.pid
    if (-not $stopped) {
        return [pscustomobject]@{ ok = $false; message = "Failed to stop backend pid $($existing.pid)." }
    }

    if (Wait-ForPortFree -PortNumber 8000) {
        return [pscustomobject]@{ ok = $true; message = "Backend stopped (pid $($existing.pid))." }
    }
    return [pscustomobject]@{ ok = $false; message = "Backend pid $($existing.pid) was killed but port 8000 is still busy." }
}

function Start-Llm {
    $existing = Get-ListeningProcessInfo -PortNumber 11434
    if ($null -ne $existing) {
        if (Test-ExpectedProcessName -ProcessInfo $existing -ExpectedNames @('ollama', 'ollama app')) {
            return [pscustomobject]@{ ok = $true; message = 'LLM listener already running.' }
        }
        return [pscustomobject]@{ ok = $false; message = "Port 11434 is held by '$($existing.process_name)' (pid $($existing.pid)), which is not Ollama. Free the port and retry." }
    }

    $ollama = Get-Command ollama -ErrorAction SilentlyContinue
    if ($null -eq $ollama) {
        return [pscustomobject]@{ ok = $false; message = 'Ollama command not found. Install or repair PATH.' }
    }

    Start-Process -FilePath $ollama.Source -ArgumentList @('serve') | Out-Null

    if (Wait-ForPortListening -PortNumber 11434) {
        return [pscustomobject]@{ ok = $true; message = 'LLM listener started on 11434.' }
    }
    return [pscustomobject]@{ ok = $true; message = 'LLM start requested via ollama serve; not listening yet.' }
}

function Stop-Llm {
    $existing = Get-ListeningProcessInfo -PortNumber 11434
    if ($null -eq $existing) {
        return [pscustomobject]@{ ok = $true; message = 'LLM listener is already stopped.' }
    }

    if (-not (Test-ExpectedProcessName -ProcessInfo $existing -ExpectedNames @('ollama', 'ollama app'))) {
        return [pscustomobject]@{ ok = $false; message = "Port 11434 is held by '$($existing.process_name)' (pid $($existing.pid)), which is not Ollama. Refusing to kill it." }
    }

    $stopped = Stop-ProcessTreeByPid -TargetPid $existing.pid
    if (-not $stopped) {
        return [pscustomobject]@{ ok = $false; message = "Failed to stop LLM listener pid $($existing.pid)." }
    }

    if (Wait-ForPortFree -PortNumber 11434) {
        return [pscustomobject]@{ ok = $true; message = "LLM listener stopped (pid $($existing.pid))." }
    }
    return [pscustomobject]@{ ok = $false; message = "LLM listener pid $($existing.pid) was killed but port 11434 is still busy." }
}

function Invoke-BackendControl {
    param(
        [Parameter(Mandatory)][ValidateSet('llm', 'stt', 'tts')][string]$Component,
        [Parameter(Mandatory)][ValidateSet('start', 'stop', 'restart')][string]$Action
    )

    $backendHealth = Invoke-JsonGet -Url 'http://127.0.0.1:8000/health'
    if ($null -eq $backendHealth) {
        return [pscustomobject]@{ ok = $false; message = 'Backend is not reachable. Start backend first.' }
    }

    if ($Component -eq 'llm') {
        try {
            [void](Invoke-JsonPost -Url 'http://127.0.0.1:8000/session/llm/control' -Body @{ action = $Action })
            return [pscustomobject]@{ ok = $true; message = "LLM $Action requested through backend control." }
        }
        catch {
            return [pscustomobject]@{ ok = $false; message = "LLM $Action failed: $($_.Exception.Message)" }
        }
    }

    if ($Component -eq 'stt') {
        try {
            [void](Invoke-JsonPost -Url 'http://127.0.0.1:8000/session/stt/control' -Body @{ action = $Action })
            return [pscustomobject]@{ ok = $true; message = "STT $Action requested." }
        }
        catch {
            return [pscustomobject]@{ ok = $false; message = "STT $Action failed: $($_.Exception.Message)" }
        }
    }

    try {
        [void](Invoke-JsonPost -Url 'http://127.0.0.1:8000/session/tts/control' -Body @{ action = $Action })
        return [pscustomobject]@{ ok = $true; message = "TTS $Action requested." }
    }
    catch {
        return [pscustomobject]@{ ok = $false; message = "TTS $Action failed: $($_.Exception.Message)" }
    }
}

function Resolve-HealthColor {
    param([Parameter(Mandatory)][string]$State)

    switch ($State) {
        'green' { return 'green' }
        'yellow' { return 'yellow' }
        default { return 'red' }
    }
}

function Resolve-OptionalString {
    param(
        [Parameter()]
        $Value,
        [Parameter(Mandatory)][string]$Fallback
    )

    if ($null -eq $Value) {
        return $Fallback
    }

    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) {
        return $Fallback
    }

    return $text
}

function Build-ManagerStatus {
    $listeners = Get-ListeningProcessMap -Ports @(5173, 8000, 11434)
    $frontend = $listeners[5173]
    $backend = $listeners[8000]
    $llmListener = $listeners[11434]

    # Only call the backend HTTP API when something is actually listening on
    # its port. During backend downtime (e.g. a restart) these calls would each
    # block on their timeout; with the browser polling /api/status every few
    # seconds, the single-threaded HttpListener piles up requests faster than it
    # can drain them and wedges (it stops answering anything, even /health).
    # Port-gating keeps a status build instant whenever the backend is down.
    $backendHealth = $null
    $resourceSnapshot = $null
    $llmState = $null
    if ($null -ne $backend) {
        $backendHealth = Invoke-JsonGet -Url 'http://127.0.0.1:8000/health'
        $resourceSnapshot = Invoke-JsonGet -Url 'http://127.0.0.1:8000/system/resources'
        $llmState = Invoke-JsonGet -Url 'http://127.0.0.1:8000/session/llm'
    }

    $sttWorker = $null
    $ttsWorker = $null
    $ownedProcesses = @()
    if ($null -ne $resourceSnapshot) {
        $sttWorker = $resourceSnapshot.stt_worker
        $ttsWorker = $resourceSnapshot.tts_worker
        if ($null -ne $resourceSnapshot.owned_processes) {
            $ownedProcesses = @($resourceSnapshot.owned_processes)
        }
    }

    $sttOwned = $ownedProcesses | Where-Object { $_.label -eq 'stt-sidecar' } | Select-Object -First 1
    $ttsOwned = $ownedProcesses | Where-Object { $_.label -eq 'tts-sidecar' -or $_.label -eq 'tts-entrypoint' } | Select-Object -First 1

    $frontendState = if ($null -ne $frontend) { 'green' } else { 'red' }
    $backendState = if ($null -ne $backend -and $null -ne $backendHealth) { 'green' } elseif ($null -ne $backend) { 'yellow' } else { 'red' }

    $llmRawState = if ($null -ne $llmState) { [string]$llmState.state } else { '' }
    $llmStateColor = if ($llmRawState -in @('ready')) {
        'green'
    } elseif ($null -ne $llmListener -or $llmRawState -in @('starting', 'idle')) {
        'yellow'
    } else {
        'red'
    }

    $sttRawState = if ($null -ne $sttWorker) { [string]$sttWorker.state } else { '' }
    $sttStateColor = if ($sttRawState -in @('ready', 'listening', 'processing', 'detected')) {
        'green'
    } elseif ($sttRawState -in @('starting', 'idle')) {
        'yellow'
    } else {
        'red'
    }

    $ttsRawState = if ($null -ne $ttsWorker) { [string]$ttsWorker.state } else { '' }
    $ttsStateColor = if ($ttsRawState -in @('ready', 'processing')) {
        'green'
    } elseif ($ttsRawState -in @('loading', 'idle')) {
        'yellow'
    } else {
        'red'
    }

    $frontendToBackend = ($null -ne $frontend -and $null -ne $backendHealth)
    $backendToLlm = if ($null -ne $llmState) { [bool]$llmState.process_healthy } else { $false }
    $backendToStt = if ($null -ne $sttWorker) { [bool]$sttWorker.available } else { $false }
    $backendToTts = if ($null -ne $ttsWorker) { [string]$ttsWorker.state -in @('ready', 'processing', 'loading') } else { $false }

    return [ordered]@{
        schema_version = 1
        generated_at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        components = @(
            [ordered]@{
                id = 'frontend'
                name = 'Frontend'
                status = Resolve-HealthColor -State $frontendState
                state = if ($null -ne $frontend) { 'running' } else { 'stopped' }
                pid = if ($null -ne $frontend) { [int]$frontend.pid } else { $null }
                port = 5173
                detail = if ($null -ne $frontend) { $frontend.process_name } else { 'No listener on 5173' }
            },
            [ordered]@{
                id = 'backend'
                name = 'Backend'
                status = Resolve-HealthColor -State $backendState
                state = if ($null -ne $backendHealth) { 'healthy' } elseif ($null -ne $backend) { 'starting' } else { 'stopped' }
                pid = if ($null -ne $backend) { [int]$backend.pid } else { $null }
                port = 8000
                detail = if ($null -ne $backendHealth) { 'Health endpoint responding' } elseif ($null -ne $backend) { 'Listener up but /health is not ready' } else { 'No listener on 8000' }
            },
            [ordered]@{
                id = 'llm'
                name = 'LLM (Ollama)'
                status = Resolve-HealthColor -State $llmStateColor
                state = if ($null -ne $llmState) { [string]$llmState.state } elseif ($null -ne $llmListener) { 'running' } else { 'stopped' }
                pid = if ($null -ne $llmState -and $null -ne $llmState.owner_pid) { [int]$llmState.owner_pid } elseif ($null -ne $llmListener) { [int]$llmListener.pid } else { $null }
                port = 11434
                detail = if ($null -ne $llmState) { (Resolve-OptionalString -Value $llmState.model_name -Fallback 'LLM profile not loaded') } elseif ($null -ne $llmListener) { 'Listener detected on 11434' } else { 'No listener on 11434' }
            },
            [ordered]@{
                id = 'stt'
                name = 'STT Worker'
                status = Resolve-HealthColor -State $sttStateColor
                state = if ($null -ne $sttWorker) { [string]$sttWorker.state } else { 'unknown' }
                pid = if ($null -ne $sttOwned) { [int]$sttOwned.pid } else { $null }
                port = $null
                detail = if ($null -ne $sttWorker) { (Resolve-OptionalString -Value $sttWorker.model_name -Fallback 'No STT model loaded') } else { 'Backend snapshot unavailable' }
            },
            [ordered]@{
                id = 'tts'
                name = 'TTS Worker'
                status = Resolve-HealthColor -State $ttsStateColor
                state = if ($null -ne $ttsWorker) { [string]$ttsWorker.state } else { 'unknown' }
                pid = if ($null -ne $ttsOwned) { [int]$ttsOwned.pid } else { $null }
                port = $null
                detail = if ($null -ne $ttsWorker) { (Resolve-OptionalString -Value $ttsWorker.model_name -Fallback 'No TTS model loaded') } else { 'Backend snapshot unavailable' }
            }
        )
        connectivity = [ordered]@{
            frontend_to_backend = $frontendToBackend
            backend_to_llm = $backendToLlm
            backend_to_stt = $backendToStt
            backend_to_tts = $backendToTts
        }
    }
}

$script:StatusCache = $null
$script:StatusCacheAtUtc = [DateTime]::MinValue
$script:StatusCacheMaxAgeMs = 2000

function Set-ManagerStatusCache {
    param([Parameter(Mandatory)]$Status)
    $script:StatusCache = $Status
    $script:StatusCacheAtUtc = [DateTime]::UtcNow
}

function Get-ManagerStatusCached {
    # Serve a recent cached snapshot for rapid polls so the single-threaded
    # listener rebuilds status at most a few times per second even when the
    # browser polls aggressively. Action handlers bypass this and refresh the
    # cache with a fresh build so post-action status is never stale.
    if ($null -ne $script:StatusCache) {
        $ageMs = ([DateTime]::UtcNow - $script:StatusCacheAtUtc).TotalMilliseconds
        if ($ageMs -lt $script:StatusCacheMaxAgeMs) {
            return $script:StatusCache
        }
    }
    $status = Build-ManagerStatus
    Set-ManagerStatusCache -Status $status
    return $status
}

function Invoke-ComponentAction {
    param(
        [Parameter(Mandatory)][string]$Component,
        [Parameter(Mandatory)][string]$Action
    )

    $normalizedComponent = $Component.Trim().ToLowerInvariant()
    $normalizedAction = $Action.Trim().ToLowerInvariant()

    if ($normalizedAction -notin @('start', 'stop', 'restart')) {
        return [pscustomobject]@{ ok = $false; message = "Unsupported action '$Action'." }
    }

    switch ($normalizedComponent) {
        'frontend' {
            if ($normalizedAction -eq 'start') { return Start-Frontend }
            if ($normalizedAction -eq 'stop') { return Stop-Frontend }
            # Restart: Stop-Frontend waits for the port to be released, so the
            # subsequent start cannot race the dying process. If stop failed,
            # surface that instead of a misleading "already running" start.
            $stopResult = Stop-Frontend
            if (-not $stopResult.ok) { return $stopResult }
            return Start-Frontend
        }
        'backend' {
            if ($normalizedAction -eq 'start') { return Start-Backend }
            if ($normalizedAction -eq 'stop') { return Stop-Backend }
            $stopResult = Stop-Backend
            if (-not $stopResult.ok) { return $stopResult }
            return Start-Backend
        }
        'llm' {
            $backendHealth = Invoke-JsonGet -Url 'http://127.0.0.1:8000/health'
            if ($null -ne $backendHealth) {
                return Invoke-BackendControl -Component 'llm' -Action $normalizedAction
            }

            if ($normalizedAction -eq 'start') { return Start-Llm }
            if ($normalizedAction -eq 'stop') { return Stop-Llm }
            $stopResult = Stop-Llm
            if (-not $stopResult.ok) { return $stopResult }
            return Start-Llm
        }
        'stt' {
            return Invoke-BackendControl -Component 'stt' -Action $normalizedAction
        }
        'tts' {
            return Invoke-BackendControl -Component 'tts' -Action $normalizedAction
        }
        default {
            return [pscustomobject]@{ ok = $false; message = "Unsupported component '$Component'." }
        }
    }
}

function Write-JsonResponse {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)]$Payload,
        [int]$StatusCode = 200
    )

    $json = $Payload | ConvertTo-Json -Depth 8
    $buffer = [System.Text.Encoding]::UTF8.GetBytes($json)
    try {
        $Context.Response.StatusCode = $StatusCode
        $Context.Response.ContentType = 'application/json; charset=utf-8'
        $Context.Response.ContentLength64 = $buffer.Length
        $Context.Response.OutputStream.Write($buffer, 0, $buffer.Length)
    }
    catch {
        if (-not (Test-IsClientDisconnectException -ErrorRecord $_)) {
            throw
        }
    }
    finally {
        try { $Context.Response.OutputStream.Close() } catch {}
        try { $Context.Response.Close() } catch {}
    }
}

function Write-HtmlResponse {
    param(
        [Parameter(Mandatory)]$Context,
        [Parameter(Mandatory)][string]$Html,
        [int]$StatusCode = 200
    )

    $buffer = [System.Text.Encoding]::UTF8.GetBytes($Html)
    try {
        $Context.Response.StatusCode = $StatusCode
        $Context.Response.ContentType = 'text/html; charset=utf-8'
        $Context.Response.ContentLength64 = $buffer.Length
        $Context.Response.OutputStream.Write($buffer, 0, $buffer.Length)
    }
    catch {
        if (-not (Test-IsClientDisconnectException -ErrorRecord $_)) {
            throw
        }
    }
    finally {
        try { $Context.Response.OutputStream.Close() } catch {}
        try { $Context.Response.Close() } catch {}
    }
}

function Test-IsClientDisconnectException {
    param([Parameter(Mandatory)]$ErrorRecord)

    $exception = $ErrorRecord.Exception
    while ($null -ne $exception) {
        if ($exception -is [System.Net.HttpListenerException]) {
            # 64: The specified network name is no longer available.
            # 1229: An operation was attempted on a non-existent network connection.
            if ($exception.NativeErrorCode -in @(64, 1229)) {
                return $true
            }
        }

        if ($exception -is [System.IO.IOException]) {
            $message = $exception.Message
            if ($message -match 'network name is no longer available|forcibly closed|broken pipe|aborted') {
                return $true
            }
        }

        $exception = $exception.InnerException
    }

    return $false
}

$managerHtml = @'
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>NikoF App Manager</title>
  <style>
    :root {
      color-scheme: dark;
      --bg0: #0f1320;
      --bg1: #151b2e;
      --ink: #ecf2ff;
      --muted: #9db0d4;
      --line: #2a3352;
      --green: #21c17a;
      --yellow: #e6bc43;
      --red: #ec5f5f;
      --btn: #1f2942;
      --btnHover: #2a385b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Segoe UI, Tahoma, sans-serif;
      background: radial-gradient(circle at top right, #1a2340 0%, var(--bg0) 45%, #090d18 100%);
      color: var(--ink);
      min-height: 100vh;
    }
    .wrap {
      width: min(1100px, 94vw);
      margin: 0 auto;
      padding: 1.25rem 0 2rem;
    }
    .header {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      align-items: end;
      margin-bottom: 1rem;
    }
        .header-actions {
            display: flex;
            gap: 0.6rem;
            align-items: center;
            flex-wrap: wrap;
        }
    h1 { margin: 0; font-size: 1.6rem; }
    .muted { color: var(--muted); }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 0.9rem;
    }
    .card {
      background: linear-gradient(180deg, rgba(28,35,58,.95), rgba(18,24,40,.95));
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 0.9rem;
    }
    .row {
      display: flex;
      justify-content: space-between;
      gap: 0.7rem;
      align-items: center;
    }
    .title { font-weight: 600; }
    .light {
      width: 12px;
      height: 12px;
      border-radius: 999px;
      box-shadow: 0 0 0 2px rgba(0,0,0,.3) inset;
      display: inline-block;
      margin-right: 0.5rem;
    }
    .light.green { background: var(--green); }
    .light.yellow { background: var(--yellow); }
    .light.red { background: var(--red); }
    .state { text-transform: capitalize; font-size: 0.9rem; }
    .small { font-size: 0.86rem; color: var(--muted); margin-top: 0.35rem; }
    .actions {
      margin-top: 0.7rem;
      display: flex;
      gap: 0.45rem;
      flex-wrap: wrap;
    }
    button {
      border: 1px solid var(--line);
      color: var(--ink);
      background: var(--btn);
      border-radius: 10px;
      padding: 0.45rem 0.7rem;
      cursor: pointer;
    }
    button:hover { background: var(--btnHover); }
    .matrix {
      margin-top: 1rem;
      background: rgba(14, 20, 34, 0.9);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 0.9rem;
    }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 0.45rem 0.35rem; border-bottom: 1px solid rgba(61, 76, 118, .55); }
    tr:last-child td { border-bottom: none; }
    .message {
      margin-top: 0.85rem;
      min-height: 1.25rem;
      color: #b6f4d6;
    }
    .message.error { color: #ffb2b2; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div>
        <h1>NikoF App Manager</h1>
        <div class="muted">Simple local process control for Frontend, Backend, LLM, STT, and TTS.</div>
      </div>
            <div class="header-actions">
                <button id="openFrontendBtn">Open Frontend</button>
                <button id="refreshBtn">Refresh</button>
            </div>
    </div>

    <div id="components" class="grid"></div>

    <div class="matrix">
      <h3 style="margin:0 0 .6rem">Interconnectivity</h3>
      <table>
        <thead><tr><th>Link</th><th>Status</th></tr></thead>
        <tbody id="links"></tbody>
      </table>
    </div>

    <div id="message" class="message"></div>
  </div>

  <script>
    const componentsEl = document.getElementById('components');
    const linksEl = document.getElementById('links');
    const messageEl = document.getElementById('message');
    const refreshBtn = document.getElementById('refreshBtn');
    const openFrontendBtn = document.getElementById('openFrontendBtn');
    let latestFrontendUrl = 'http://127.0.0.1:5173/';

    function esc(value) {
      return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    async function fetchStatus() {
      const response = await fetch('/api/status');
      if (!response.ok) throw new Error('Failed to load status');
      return response.json();
    }

    function badge(ok) {
      const cls = ok ? 'green' : 'red';
      return `<span class="light ${cls}"></span>${ok ? 'OK' : 'DOWN'}`;
    }

    function render(status) {
            const frontend = (status.components || []).find((component) => component.id === 'frontend');
            if (frontend && frontend.port) {
                latestFrontendUrl = `http://127.0.0.1:${frontend.port}/`;
            }

      const cards = (status.components || []).map((c) => {
        return `
          <div class="card">
            <div class="row">
              <div class="title">${esc(c.name)}</div>
              <div><span class="light ${esc(c.status)}"></span><span class="state">${esc(c.state)}</span></div>
            </div>
            <div class="small">PID: ${c.pid ?? '—'}${c.port ? ` | Port: ${c.port}` : ''}</div>
            <div class="small">${esc(c.detail || '')}</div>
            <div class="actions">
              <button data-component="${esc(c.id)}" data-action="start">Start</button>
              <button data-component="${esc(c.id)}" data-action="stop">Stop</button>
              <button data-component="${esc(c.id)}" data-action="restart">Restart</button>
            </div>
          </div>
        `;
      }).join('');
      componentsEl.innerHTML = cards;

      const links = status.connectivity || {};
      linksEl.innerHTML = `
        <tr><td>Frontend -> Backend</td><td>${badge(!!links.frontend_to_backend)}</td></tr>
        <tr><td>Backend -> LLM</td><td>${badge(!!links.backend_to_llm)}</td></tr>
        <tr><td>Backend -> STT</td><td>${badge(!!links.backend_to_stt)}</td></tr>
        <tr><td>Backend -> TTS</td><td>${badge(!!links.backend_to_tts)}</td></tr>
      `;
    }

    async function doAction(component, action) {
      messageEl.className = 'message';
      messageEl.textContent = `${component}: ${action}...`;
      try {
        const response = await fetch('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ component, action })
        });
        const result = await response.json();
        if (!response.ok || !result.ok) {
          messageEl.className = 'message error';
          messageEl.textContent = result.message || 'Action failed';
        } else {
          messageEl.className = 'message';
          messageEl.textContent = result.message || 'Action complete';
        }
      } catch (error) {
        messageEl.className = 'message error';
        messageEl.textContent = error instanceof Error ? error.message : String(error);
      }
      await refresh();
    }

    async function refresh() {
      try {
        const status = await fetchStatus();
        render(status);
      } catch (error) {
        messageEl.className = 'message error';
        messageEl.textContent = error instanceof Error ? error.message : String(error);
      }
    }

    componentsEl.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) return;
      const component = target.dataset.component;
      const action = target.dataset.action;
      if (!component || !action) return;
      void doAction(component, action);
    });

    refreshBtn.addEventListener('click', () => { void refresh(); });
        openFrontendBtn.addEventListener('click', () => {
            window.open(latestFrontendUrl, '_blank');
        });

    void refresh();
    setInterval(() => { void refresh(); }, 3000);
  </script>
</body>
</html>
'@

if ($AutoStartBackend) {
    [void](Start-Backend)
}
if ($AutoStartFrontend) {
    [void](Start-Frontend)
}

$listener = New-Object System.Net.HttpListener
$prefix = "http://127.0.0.1:$Port/"
$listener.Prefixes.Add($prefix)
$listener.Start()

Write-Host "NikoF App Manager listening on $prefix"

if ($OpenBrowser) {
    Start-Process "http://127.0.0.1:$Port/" | Out-Null
}

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $path = $request.Url.AbsolutePath

        if ($request.HttpMethod -eq 'GET' -and $path -eq '/') {
            Write-HtmlResponse -Context $context -Html $managerHtml
            continue
        }

        if ($request.HttpMethod -eq 'GET' -and $path -eq '/health') {
            Write-JsonResponse -Context $context -Payload @{ ok = $true; service = 'app-manager' }
            continue
        }

        if ($request.HttpMethod -eq 'GET' -and $path -eq '/api/status') {
            $status = Get-ManagerStatusCached
            Write-JsonResponse -Context $context -Payload $status
            continue
        }

        if ($request.HttpMethod -eq 'POST' -and $path -eq '/api/action') {
            $reader = New-Object System.IO.StreamReader($request.InputStream, $request.ContentEncoding)
            $rawBody = $reader.ReadToEnd()
            $reader.Close()

            try {
                $payload = $rawBody | ConvertFrom-Json -ErrorAction Stop
                $component = [string]$payload.component
                $action = [string]$payload.action
                $result = Invoke-ComponentAction -Component $component -Action $action
                $status = Build-ManagerStatus
                Set-ManagerStatusCache -Status $status
                $response = [ordered]@{
                    ok = [bool]$result.ok
                    message = [string]$result.message
                    status = $status
                }
                $code = if ($result.ok) { 200 } else { 400 }
                Write-JsonResponse -Context $context -Payload $response -StatusCode $code
            }
            catch {
                Write-JsonResponse -Context $context -Payload @{ ok = $false; message = "Invalid request: $($_.Exception.Message)" } -StatusCode 400
            }
            continue
        }

        Write-JsonResponse -Context $context -Payload @{ ok = $false; message = 'Not found' } -StatusCode 404
    }
}
finally {
    if ($listener.IsListening) {
        $listener.Stop()
    }
    $listener.Close()
}
