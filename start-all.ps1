#requires -Version 5.1
# Full local bring-up for NikoF: backend (8000) + control frontend (5173) +
# stage desktop window (Tauri on its own Vite, 5174). Each runs in its own
# window so logs stay visible and you can close them individually.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$backendRoot = Join-Path $root 'backend'
$frontendRoot = Join-Path $root 'frontend'
$venvPython = Join-Path $root '.venv\Scripts\python.exe'

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

# Performance runtime profile — keep in sync with scripts/bootstrap/app-manager.ps1
# (see docs/TTS_ENGINE_BENCHMARK.md). Without this the backend falls back to the
# legacy defaults (GPT-SoVITS, faster-whisper, llama3.1-8b). Each is applied only
# if not already set, so any can be overridden from the parent environment. These
# env vars are inherited by the backend window spawned below.
# REQUIRES the models installed: qwen3:4b in Ollama, the Kokoro model under
# <NIKOF_TTS_MODELS_ROOT>/kokoro, and the Parakeet STT engine.
$perfDefaults = [ordered]@{
    NIKOF_TTS_ENGINE        = 'kokoro'      # fast TTS, frees VRAM (preset voice)
    NIKOF_KOKORO_VOICE      = 'jf_gongitsune' # higher-pitched timbre; English stays via NIKOF_KOKORO_LANG=en-us
    NIKOF_KOKORO_LANG       = 'en-us'       # keep English phonemizer regardless of voice timbre
    NIKOF_STT_ENGINE        = 'parakeet'    # Parakeet TDT v2: 0 WER vs Whisper-medium, ~2x faster (GPU)
    NIKOF_STT_ALLOW_GPU     = '1'           # run Parakeet on the RTX 4070 (CUDA EP via torch-bundled cuDNN/CUDA)
    NIKOF_STT_PARTIALS      = '1'           # interim transcripts -> live captions on the avatar surface
    NIKOF_LLM_MODEL         = 'qwen3:4b'    # ~2x faster than llama3.2:3b
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

Write-Host '[start-all] 3/3 Stage desktop window (Tauri + Vite on 5174)...'
# launch-display.bat handles the cargo PATH, frees 5174, and runs `tauri dev`.
Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', "`"$root\launch-display.bat`"") | Out-Null

Write-Host ''
Write-Host '[start-all] Launched. Control surface: http://127.0.0.1:5173/control/'
Write-Host '[start-all] Stage opens as a desktop window once the Rust shell finishes building (first run is slow).'
