param(
    [ValidateSet("idle", "services-no-tts", "services-with-tts")]
    [string]$Stage,

    [string]$Note = ""
)

$ErrorActionPreference = "Stop"

$labelMap = @{
    "idle" = "idle-before-services"
    "services-no-tts" = "backend-frontend-no-tts"
    "services-with-tts" = "backend-frontend-with-tts"
}

$captureScript = Join-Path $PSScriptRoot "Capture-GpuBaseline.ps1"
$label = $labelMap[$Stage]

if (-not (Test-Path $captureScript)) {
    throw "Capture-GpuBaseline.ps1 was not found next to this script."
}

$outputPath = & $captureScript -Label $label
if (-not $outputPath) {
    throw "Baseline capture script did not return an output path."
}

if (-not [string]::IsNullOrWhiteSpace($Note)) {
    $json = Get-Content $outputPath -Raw | ConvertFrom-Json
    $json | Add-Member -NotePropertyName note -NotePropertyValue $Note -Force
    $json | ConvertTo-Json -Depth 6 | Set-Content -Path $outputPath -Encoding utf8
}

Write-Output $outputPath