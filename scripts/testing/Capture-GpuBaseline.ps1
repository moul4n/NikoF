param(
    [string]$Label = "baseline"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$outputRoot = Join-Path $repoRoot ".local\monitoring"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$safeLabel = ($Label -replace "[^A-Za-z0-9._-]", "-").Trim("-")
if ([string]::IsNullOrWhiteSpace($safeLabel)) {
    $safeLabel = "baseline"
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
    throw "nvidia-smi is not available on PATH."
}

$gpuRows = @(
    & nvidia-smi --query-gpu=timestamp,name,utilization.gpu,utilization.memory,memory.total,memory.used,memory.free --format=csv,noheader,nounits |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
)

$processRows = @(
    & nvidia-smi --query-compute-apps=pid,process_name,used_memory,gpu_uuid --format=csv,noheader,nounits |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
)

$gpu = foreach ($row in $gpuRows) {
    $parts = $row -split ",\s*", 7
    if ($parts.Count -lt 7) {
        continue
    }

    [pscustomobject]@{
        timestamp = $parts[0]
        name = $parts[1]
        utilization_gpu_percent = $parts[2]
        utilization_memory_percent = $parts[3]
        memory_total_mb = $parts[4]
        memory_used_mb = $parts[5]
        memory_free_mb = $parts[6]
    }
}

$gpuProcesses = foreach ($row in $processRows) {
    $parts = $row -split ",\s*", 4
    if ($parts.Count -lt 4) {
        continue
    }

    [pscustomobject]@{
        pid = $parts[0]
        process_name = $parts[1]
        used_memory_mb = $parts[2]
        gpu_uuid = $parts[3]
    }
}

$payload = [pscustomobject]@{
    captured_at = (Get-Date).ToString("o")
    label = $Label
    machine = $env:COMPUTERNAME
    gpu = $gpu
    gpu_processes = $gpuProcesses
}

$outputPath = Join-Path $outputRoot ("{0}-{1}.json" -f $timestamp, $safeLabel)
$payload | ConvertTo-Json -Depth 6 | Set-Content -Path $outputPath -Encoding utf8

Write-Output $outputPath