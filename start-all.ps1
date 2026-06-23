#requires -Version 5.1
<#
.SYNOPSIS
    NikoF single front-door launcher: preflight-gate, then full local bring-up
    (backend 8000 + control frontend 5173 + Tauri stage on 5174).

.DESCRIPTION
    Runs the preflight doctor first (scripts/bootstrap/Invoke-Preflight.ps1) against the
    canonical performance stack (Kokoro / Parakeet / qwen3:4b). If a launch-critical
    prerequisite is missing (the .venv, frontend deps, or the configured engine's model)
    it stops with the exact install command rather than starting a broken stack. Pass
    -Force to start anyway, -SkipPreflight to skip the check, -NoStage to skip the Tauri
    window. Each service runs in its own window so logs stay visible and you can close
    them individually; stop-dev-stack.ps1 is the one-shot cleanup.
#>
[CmdletBinding()]
param(
    [switch]$SkipPreflight,
    [switch]$Force,
    [switch]$NoStage
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$backendRoot = Join-Path $root 'backend'
$frontendRoot = Join-Path $root 'frontend'
$venvPython = Join-Path $root '.venv\Scripts\python.exe'
$preflightScript = Join-Path $root 'scripts\bootstrap\Invoke-Preflight.ps1'

$shell = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $shell) { $shell = (Get-Command powershell -ErrorAction SilentlyContinue).Source }
if (-not $shell) { Write-Error 'No PowerShell (pwsh/powershell) found on PATH.'; exit 1 }

function Test-PortUp([int]$Port) {
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Wait-Port([int]$Port, [int]$TimeoutSec = 90) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-PortUp $Port) { return $true }
        Start-Sleep -Milliseconds 700
    }
    return $false
}

function Start-InWindow([string]$Title, [string]$Command) {
    # -NoExit keeps the window (and its logs) open after the process starts.
    Start-Process -FilePath $shell -ArgumentList @('-NoLogo', '-NoProfile', '-NoExit', '-Command', "`$Host.UI.RawUI.WindowTitle='$Title'; $Command") | Out-Null
}

function Get-TotalVramMb {
    $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if (-not $smi) { return $null }
    try {
        $line = (& $smi.Source --query-gpu=memory.total --format=csv,noheader,nounits 2>$null | Select-Object -First 1)
        if ($line) { return [int]($line.Trim()) }
    }
    catch {}
    return $null
}

# Parakeet STT can run on the GPU (CUDA EP) or CPU. On a ~8GB card the LLM already
# needs most of the VRAM, and Parakeet's CUDA EP only initialises if the CUDA-12 /
# cuDNN-9 runtime DLLs are present (they ship with torch-cu12, not the parakeet
# extra). Default GPU STT on only for cards with comfortable headroom (>=12GB);
# otherwise run Parakeet on CPU by design — it leaves the GPU for the LLM and skips
# a doomed CUDA-init attempt. Override by setting NIKOF_STT_ALLOW_GPU before launch.
$totalVramMb = Get-TotalVramMb
$sttAllowGpuDefault = if ($totalVramMb -and $totalVramMb -ge 11264) { '1' } else { '0' }
if ($totalVramMb) {
    Write-Host ("[start-all] Detected {0} MB VRAM; default NIKOF_STT_ALLOW_GPU={1} (Parakeet on {2})." -f $totalVramMb, $sttAllowGpuDefault, $(if ($sttAllowGpuDefault -eq '1') { 'GPU' } else { 'CPU' }))
}

# Performance runtime profile — keep in sync with scripts/bootstrap/app-manager.ps1
# (see docs/TTS_ENGINE_BENCHMARK.md). This is the canonical stack; without it the
# backend falls back to the legacy GPT-SoVITS / faster-whisper / llama3.1 defaults.
# Each value is applied only if not already set, so any can be overridden from the
# parent environment. These env vars are inherited by the backend window and by the
# preflight check below (so preflight verifies the engines that will actually run).
# REQUIRES the models installed (install-prerequisites.ps1 -AllSafe): qwen3:4b in
# Ollama, the Kokoro model under <NIKOF_TTS_MODELS_ROOT>/kokoro, and the Parakeet
# model under <NIKOF_STT_MODELS_ROOT>/parakeet-tdt-0.6b-v2.
$perfDefaults = [ordered]@{
    NIKOF_TTS_ENGINE        = 'kokoro'      # fast TTS, frees VRAM (preset voice), runs on CPU
    NIKOF_KOKORO_VOICE      = 'jf_gongitsune' # higher-pitched timbre; English stays via NIKOF_KOKORO_LANG=en-us
    NIKOF_KOKORO_LANG       = 'en-us'       # keep English phonemizer regardless of voice timbre
    NIKOF_STT_ENGINE        = 'parakeet'    # Parakeet TDT v2: lower WER than Whisper-medium, fast on CPU too
    NIKOF_STT_ALLOW_GPU     = $sttAllowGpuDefault  # VRAM-aware (see above): GPU only on >=12GB cards, else CPU to leave the GPU for the LLM
    NIKOF_STT_PARTIALS      = '1'           # interim transcripts -> live captions on the avatar surface
    NIKOF_LLM_MODEL         = 'qwen3:4b'    # small, fast local planner model
    NIKOF_LLM_THINK         = 'false'       # qwen3 reasoning off -> fast clean JSON
    NIKOF_LLM_LEAN_PLANNER  = '1'           # slim planner -> ~3x faster generation
    NIKOF_LLM_ASYNC_MEMORY  = '1'           # recover durable memory off the latency path
    NIKOF_TTS_SEGMENTATION  = '1'           # sentence-level TTS overlap
    NIKOF_LLM_STREAMING     = '1'           # stream the reply into TTS
}
foreach ($name in $perfDefaults.Keys) {
    if (-not (Test-Path "Env:$name")) {
        Set-Item -Path "Env:$name" -Value $perfDefaults[$name]
    }
}

function Invoke-PreflightGate {
    if ($SkipPreflight) {
        Write-Host '[start-all] Preflight skipped (-SkipPreflight).'
        return
    }
    if (-not (Test-Path -LiteralPath $preflightScript)) {
        Write-Warning "[start-all] Preflight script not found at $preflightScript; skipping the readiness check."
        return
    }

    Write-Host '[start-all] Running preflight (checking the configured engine stack)...'
    & $shell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $preflightScript

    $reportPath = Join-Path $root '.local\bootstrap\preflight-report.json'
    if (-not (Test-Path -LiteralPath $reportPath)) {
        Write-Warning '[start-all] No preflight report was produced; continuing without a gate.'
        return
    }

    $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
    # Launch-critical checks: without these a service cannot start or its configured
    # engine cannot run. Advisories (VRAM, runtime versions, optional payloads) do not block.
    $criticalIds = @('env-venv', 'env-venv-deps', 'env-venv-version', 'env-frontend', 'engine-tts', 'engine-stt', 'ollama-daemon')
    $blockers = @($report.checks | Where-Object { ($_.id -in $criticalIds) -and ($_.status -eq 'auto-fixable' -or $_.status -eq 'manual-handoff') })
    if ($blockers.Count -eq 0) {
        return
    }

    Write-Host ''
    Write-Warning '[start-all] Launch-blocking prerequisites are not satisfied:'
    foreach ($blocker in $blockers) {
        Write-Host ("  [{0}] {1}" -f $blocker.status, $blocker.title)
        if ($blocker.detail) { Write-Host ("        {0}" -f $blocker.detail) }
        if ($blocker.fix) { Write-Host ("        -> {0}" -f $blocker.fix) }
    }
    Write-Host ''
    Write-Host '[start-all] Install the above, e.g.:'
    Write-Host '  powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap\install-prerequisites.ps1 -AllSafe'
    Write-Host '  (add -HfEndpoint https://hf-mirror.com if huggingface.co is blocked on this machine)'
    Write-Host 'then re-run start-all.bat.'
    Write-Host ''

    if (-not $Force) {
        throw 'Aborting start-all: launch-blocking prerequisites are missing. Pass -Force to start anyway (the affected engine will be unavailable).'
    }
    Write-Warning '[start-all] Continuing despite blockers (-Force); the affected engine(s) will be unavailable.'
}

Invoke-PreflightGate

Write-Host '[start-all] 1/3 Backend (port 8000)...'
if (Test-PortUp 8000) {
    Write-Host '  already running.'
} else {
    Start-InWindow 'NikoF Backend' "Set-Location '$backendRoot'; & '$venvPython' -m app.dev_server"
    if (Wait-Port 8000 120) { Write-Host '  listening on 8000.' } else { Write-Host '  not up yet (models may still be warming) - continuing.' }
}

Write-Host '[start-all] 2/3 Control frontend (port 5173)...'
if (Test-PortUp 5173) {
    Write-Host '  already running.'
} else {
    Start-InWindow 'NikoF Control 5173' "Set-Location '$frontendRoot'; npm run dev"
    if (Wait-Port 5173 60) { Write-Host '  listening on 5173.' } else { Write-Host '  not up yet - continuing.' }
}

if ($NoStage) {
    Write-Host '[start-all] 3/3 Stage desktop window skipped (-NoStage).'
} else {
    Write-Host '[start-all] 3/3 Stage desktop window (Tauri + Vite on 5174)...'
    # launch-display.bat handles the cargo PATH, frees 5174, and runs `tauri dev`.
    Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', "`"$root\launch-display.bat`"") | Out-Null
}

Write-Host ''
Write-Host '[start-all] Launched. Control surface: http://127.0.0.1:5173/control/'
Write-Host '[start-all] Stage opens as a desktop window once the Rust shell finishes building (first run is slow).'
Write-Host '[start-all] Stop everything with: powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap\stop-dev-stack.ps1'
