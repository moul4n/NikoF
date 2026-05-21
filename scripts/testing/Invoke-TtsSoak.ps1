param(
    [string]$BackendBaseUrl = "http://127.0.0.1:8000",

    [string]$Label = "tts-soak",

    [string]$Locale = "en-US",

    [int]$PollCount = 10,

    [string[]]$Prompts,

    [string]$PromptFile,

    [switch]$SkipGpuSamples
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$outputRoot = Join-Path $repoRoot ".local\monitoring"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$safeLabel = ($Label -replace "[^A-Za-z0-9._-]", "-").Trim("-")
if ([string]::IsNullOrWhiteSpace($safeLabel)) {
    $safeLabel = "tts-soak"
}

function Get-DefaultSoakPrompts {
    return @(
        "Quick status line one.",
        "Give the operator a short calm greeting.",
        "State that the backend queue is healthy.",
        "Say the warm path is active and ready.",
        "Count one two three four five clearly.",
        "Read a brief note about stable preview delivery.",
        "Explain that polling should remain cheap while idle.",
        "Confirm that the backend owns TTS admission and artifacts.",
        "Offer a short reassuring line for the next preview.",
        "Read a slightly longer sentence about steady queue throughput and warm model reuse.",
        "Tell the operator that Maria is standing by for voice testing.",
        "Say that recent synthesis requests completed without hidden retries.",
        "Read a short diagnostic line about canonical speech lifecycle events.",
        "Explain that GPU samples are estimates and not profiler traces.",
        "Deliver a compact sentence about predictable warm start latency.",
        "Count from six to ten with a steady pace.",
        "State that the current voice profile remains responsive under repeated calls.",
        "Read a medium line about keeping the sidecar hot without spinning on idle polls.",
        "Confirm that the resource monitor is still exposing the TTS subsystem cleanly.",
        "Speak a short note that the queue is processing requests in order.",
        "Say that audio artifacts are still being published through the backend route.",
        "Read a medium debug sentence about request accounting and operator visibility.",
        "Tell the operator the synthesis lane remains stable after multiple preview passes.",
        "Explain that the local runtime still uses the current validated checkpoint pair.",
        "Deliver a concise line that the warm idle path appears controlled.",
        "Read a longer line about balancing fast startup, controlled GPU use, and predictable backend-owned behavior during repeated previews.",
        "Confirm that hidden polling churn has not returned during this soak.",
        "Offer a short closing line that the voice lane is still healthy.",
        "Read one more medium sentence about stability, responsiveness, and measured resource use.",
        "Finish with a final operator line noting that the long soak completed successfully."
    )
}

function Get-TtsSubsystem {
    param(
        [Parameter(Mandatory = $true)]
        $Resources
    )

    return @($Resources.subsystems | Where-Object { $_.subsystem -eq "tts" } | Select-Object -First 1)[0]
}

function Get-TtsOwnedProcesses {
    param(
        [Parameter(Mandatory = $true)]
        $Resources
    )

    return @(
        @($Resources.owned_processes) |
            Where-Object {
                ($_.subsystem -eq "tts") -or
                ($_.command -match "9880|gpt-sovits|api_server") -or
                ($_.name -match "tts|gpt|sovits")
            }
    )
}

function Get-GpuSample {
    if ($SkipGpuSamples.IsPresent) {
        return $null
    }

    if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
        return $null
    }

    $line = & nvidia-smi --query-gpu=utilization.gpu,power.draw,memory.used --format=csv,noheader,nounits |
        Select-Object -First 1
    if ([string]::IsNullOrWhiteSpace($line)) {
        return $null
    }

    $parts = $line -split ",\s*"
    if ($parts.Count -lt 3) {
        return $null
    }

    return [pscustomobject]@{
        utilization_gpu_percent = [double]$parts[0]
        power_draw_watts = [double]$parts[1]
        memory_used_mb = [double]$parts[2]
    }
}

function Get-ActiveGpuEngines {
    try {
        return @(
            Get-Counter '\GPU Engine(*)\Utilization Percentage' |
                Select-Object -ExpandProperty CounterSamples |
                Where-Object { $_.CookedValue -gt 5 } |
                Sort-Object CookedValue -Descending |
                Select-Object -First 6 @{ Name = 'instance_name'; Expression = { $_.InstanceName } }, @{ Name = 'utilization_percent'; Expression = { [math]::Round($_.CookedValue, 2) } }
        )
    }
    catch {
        return @()
    }
}

function Get-PercentileValue {
    param(
        [double[]]$Values,
        [double]$Percentile
    )

    if (-not $Values -or $Values.Count -eq 0) {
        return $null
    }

    $sorted = @($Values | Sort-Object)
    $targetIndex = [Math]::Ceiling($sorted.Count * $Percentile) - 1
    if ($targetIndex -lt 0) {
        $targetIndex = 0
    }
    if ($targetIndex -ge $sorted.Count) {
        $targetIndex = $sorted.Count - 1
    }

    return [double]$sorted[$targetIndex]
}

function Get-AudioArtifactSequence {
    param(
        [string]$AudioReference
    )

    if ([string]::IsNullOrWhiteSpace($AudioReference)) {
        return $null
    }

    $match = [regex]::Match($AudioReference, 'speech-lifecycle-(\d+)/audio')
    if (-not $match.Success) {
        return $null
    }

    return [int]$match.Groups[1].Value
}

function Get-BackendUri {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BaseUrl,

        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $normalizedBaseUrl = $BaseUrl.Trim()
    if ([string]::IsNullOrWhiteSpace($normalizedBaseUrl)) {
        throw "BackendBaseUrl cannot be empty."
    }

    $normalizedPath = $Path.TrimStart('/')
    return ([uri]("{0}/{1}" -f $normalizedBaseUrl.TrimEnd('/'), $normalizedPath)).AbsoluteUri
}

if ($PollCount -lt 0) {
    throw "PollCount cannot be negative."
}

if (-not [string]::IsNullOrWhiteSpace($PromptFile) -and $Prompts.Count -gt 0) {
    throw "Specify either -Prompts or -PromptFile, not both."
}

$promptList = @()
if (-not [string]::IsNullOrWhiteSpace($PromptFile)) {
    if (-not (Test-Path -LiteralPath $PromptFile)) {
        throw "PromptFile was not found: $PromptFile"
    }

    $promptList = @(
        Get-Content -LiteralPath $PromptFile |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
}
elseif ($Prompts.Count -gt 0) {
    $promptList = @($Prompts | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}
else {
    $promptList = Get-DefaultSoakPrompts
}

if ($promptList.Count -eq 0) {
    throw "No prompts were provided for the soak run."
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

$healthUri = Get-BackendUri -BaseUrl $BackendBaseUrl -Path "health"
$systemResourcesUri = Get-BackendUri -BaseUrl $BackendBaseUrl -Path "system/resources"
$operatorCommandUri = Get-BackendUri -BaseUrl $BackendBaseUrl -Path "session/operator-command"
$speechLifecycleUri = Get-BackendUri -BaseUrl $BackendBaseUrl -Path "session/speech-lifecycle"

$health = Invoke-RestMethod -Uri $healthUri
if ($health.status -ne "ok") {
    throw "Backend health check failed at $healthUri"
}

$beforeResources = Invoke-RestMethod -Uri $systemResourcesUri
$beforeTts = Get-TtsSubsystem -Resources $beforeResources
if ($null -eq $beforeTts) {
    throw "TTS subsystem was not present in /system/resources."
}

$requestSamples = New-Object System.Collections.Generic.List[object]
$gpuSamples = New-Object System.Collections.Generic.List[object]

$index = 0
foreach ($prompt in $promptList) {
    $index += 1
    $requestBody = @{
        command_type = "tts_preview"
        text = $prompt
        locale = $Locale
    } | ConvertTo-Json

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $response = Invoke-RestMethod -Method Post -Uri $operatorCommandUri -ContentType "application/json" -Body $requestBody
    $stopwatch.Stop()

    $resources = Invoke-RestMethod -Uri $systemResourcesUri
    $tts = Get-TtsSubsystem -Resources $resources
    $gpuSample = Get-GpuSample
    $audioReference = $response.session_event.synthesis.audio_reference
    $audioEventSequence = Get-AudioArtifactSequence -AudioReference $audioReference
    if ($null -ne $gpuSample) {
        $gpuSamples.Add($gpuSample) | Out-Null
    }

    $requestSamples.Add(
        [pscustomobject]@{
            index = $index
            prompt = $prompt
            prompt_characters = $prompt.Length
            status = $response.status
            elapsed_ms = [math]::Round($stopwatch.Elapsed.TotalMilliseconds, 1)
            timing_ms = if ($response.session_event.synthesis.timing.utterance_duration_ms) {
                [double]$response.session_event.synthesis.timing.utterance_duration_ms
            }
            else {
                $null
            }
            audio_reference = $audioReference
            audio_event_sequence = $audioEventSequence
            requests_processed = $tts.requests_processed
            loaded = $tts.loaded
            gpu_utilization_percent = if ($null -ne $gpuSample) { $gpuSample.utilization_gpu_percent } else { $null }
            gpu_power_watts = if ($null -ne $gpuSample) { $gpuSample.power_draw_watts } else { $null }
            gpu_memory_used_mb = if ($null -ne $gpuSample) { $gpuSample.memory_used_mb } else { $null }
        }
    ) | Out-Null
}

$afterSoakResources = Invoke-RestMethod -Uri $systemResourcesUri
$afterSoakTts = Get-TtsSubsystem -Resources $afterSoakResources
$expectedRequestTotal = [int]$beforeTts.requests_processed + $promptList.Count
if ($afterSoakTts.requests_processed -lt $expectedRequestTotal) {
    foreach ($catchUpAttempt in 1..5) {
        $afterSoakResources = Invoke-RestMethod -Uri $systemResourcesUri
        $afterSoakTts = Get-TtsSubsystem -Resources $afterSoakResources
        if ($afterSoakTts.requests_processed -ge $expectedRequestTotal) {
            break
        }
    }
}

$prePollRequests = [int]$afterSoakTts.requests_processed
$prePollLastRequest = $afterSoakTts.last_request_epoch

if ($PollCount -gt 0) {
    foreach ($pollIndex in 1..$PollCount) {
        $null = Invoke-RestMethod -Uri $speechLifecycleUri
    }
}

$afterPollResources = Invoke-RestMethod -Uri $systemResourcesUri
$afterPollTts = Get-TtsSubsystem -Resources $afterPollResources
$tailGpuSample = Get-GpuSample
$tailActiveGpuEngines = Get-ActiveGpuEngines
$tailOwnedProcesses = Get-TtsOwnedProcesses -Resources $afterPollResources

$latencies = @($requestSamples | Select-Object -ExpandProperty elapsed_ms)
$timings = @($requestSamples | Where-Object { $null -ne $_.timing_ms } | Select-Object -ExpandProperty timing_ms)
$audioEventSequences = @($requestSamples | Where-Object { $null -ne $_.audio_event_sequence } | Select-Object -ExpandProperty audio_event_sequence)
$gpuUtilValues = @($gpuSamples | Select-Object -ExpandProperty utilization_gpu_percent)
$gpuPowerValues = @($gpuSamples | Select-Object -ExpandProperty power_draw_watts)
$gpuMemoryValues = @($gpuSamples | Select-Object -ExpandProperty memory_used_mb)

$resourceEndRequests = [int]$afterSoakTts.requests_processed
$maxAudioEventSequence = if ($audioEventSequences.Count -gt 0) {
    [int](($audioEventSequences | Measure-Object -Maximum).Maximum)
}
else {
    $null
}
$estimatedEndRequests = if ($null -ne $maxAudioEventSequence) {
    [Math]::Max($resourceEndRequests, $maxAudioEventSequence)
}
else {
    $resourceEndRequests
}

$summary = [pscustomobject]@{
    prompt_count = $promptList.Count
    ready_count = @($requestSamples | Where-Object { $_.status -eq "ready" }).Count
    all_ready = (@($requestSamples | Where-Object { $_.status -ne "ready" }).Count -eq 0)
    start_requests = [int]$beforeTts.requests_processed
    end_requests_resource = $resourceEndRequests
    end_requests_estimated = $estimatedEndRequests
    expected_end_requests = $expectedRequestTotal
    delta_requests_resource = ($resourceEndRequests - [int]$beforeTts.requests_processed)
    delta_requests_estimated = ($estimatedEndRequests - [int]$beforeTts.requests_processed)
    max_audio_event_sequence = $maxAudioEventSequence
    request_counter_caught_up = ($resourceEndRequests -ge $expectedRequestTotal)
    resource_counter_lagged_estimate = ($resourceEndRequests -lt $estimatedEndRequests)
    loaded_before = [bool]$beforeTts.loaded
    loaded_after = [bool]$afterPollTts.loaded
    min_elapsed_ms = if ($latencies.Count -gt 0) { [math]::Round((($latencies | Measure-Object -Minimum).Minimum), 1) } else { $null }
    avg_elapsed_ms = if ($latencies.Count -gt 0) { [math]::Round((($latencies | Measure-Object -Average).Average), 1) } else { $null }
    p95_elapsed_ms = if ($latencies.Count -gt 0) { [math]::Round((Get-PercentileValue -Values $latencies -Percentile 0.95), 1) } else { $null }
    max_elapsed_ms = if ($latencies.Count -gt 0) { [math]::Round((($latencies | Measure-Object -Maximum).Maximum), 1) } else { $null }
    avg_timing_ms = if ($timings.Count -gt 0) { [math]::Round((($timings | Measure-Object -Average).Average), 1) } else { $null }
    peak_gpu_utilization_percent = if ($gpuUtilValues.Count -gt 0) { [math]::Round((($gpuUtilValues | Measure-Object -Maximum).Maximum), 1) } else { $null }
    avg_gpu_utilization_percent = if ($gpuUtilValues.Count -gt 0) { [math]::Round((($gpuUtilValues | Measure-Object -Average).Average), 1) } else { $null }
    peak_gpu_power_watts = if ($gpuPowerValues.Count -gt 0) { [math]::Round((($gpuPowerValues | Measure-Object -Maximum).Maximum), 2) } else { $null }
    avg_gpu_power_watts = if ($gpuPowerValues.Count -gt 0) { [math]::Round((($gpuPowerValues | Measure-Object -Average).Average), 2) } else { $null }
    min_gpu_memory_used_mb = if ($gpuMemoryValues.Count -gt 0) { [math]::Round((($gpuMemoryValues | Measure-Object -Minimum).Minimum), 1) } else { $null }
    max_gpu_memory_used_mb = if ($gpuMemoryValues.Count -gt 0) { [math]::Round((($gpuMemoryValues | Measure-Object -Maximum).Maximum), 1) } else { $null }
    polling_count = $PollCount
    polling_kept_request_counter_flat = ([int]$afterPollTts.requests_processed -eq $prePollRequests)
    last_request_before_polls = $prePollLastRequest
    last_request_after_polls = $afterPollTts.last_request_epoch
    polling_kept_last_request_flat = ($afterPollTts.last_request_epoch -eq $prePollLastRequest)
    tail_gpu_utilization_percent = if ($null -ne $tailGpuSample) { $tailGpuSample.utilization_gpu_percent } else { $null }
    tail_gpu_power_watts = if ($null -ne $tailGpuSample) { $tailGpuSample.power_draw_watts } else { $null }
    tail_gpu_memory_used_mb = if ($null -ne $tailGpuSample) { $tailGpuSample.memory_used_mb } else { $null }
    tts_owned_pids = @($tailOwnedProcesses | Select-Object -ExpandProperty pid)
}

$payload = [pscustomobject]@{
    captured_at = (Get-Date).ToString("o")
    label = $Label
    machine = $env:COMPUTERNAME
    backend_base_url = $BackendBaseUrl
    locale = $Locale
    prompt_source = if (-not [string]::IsNullOrWhiteSpace($PromptFile)) { "file" } elseif ($Prompts.Count -gt 0) { "inline" } else { "default" }
    prompt_count = $promptList.Count
    prompts = $promptList
    summary = $summary
    request_samples = $requestSamples
    tail = [pscustomobject]@{
        gpu_sample = $tailGpuSample
        active_gpu_engines = $tailActiveGpuEngines
        tts_owned_processes = $tailOwnedProcesses
        tts_resources = $afterPollTts
        tts_last_error = $afterPollResources.tts_worker.last_error
    }
}

$outputPath = Join-Path $outputRoot ("{0}-{1}.json" -f $timestamp, $safeLabel)
$payload | ConvertTo-Json -Depth 8 | Set-Content -Path $outputPath -Encoding utf8

Write-Output $outputPath