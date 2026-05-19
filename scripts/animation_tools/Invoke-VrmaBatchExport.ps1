<#
.SYNOPSIS
    Batch converts all raw .anim files to VRMA format.

.DESCRIPTION
    Iterates through the animation semantic ID mapping and invokes Invoke-VrmaExport.ps1
    for each entry. Stops on first failure unless -ContinueOnError is set.

.PARAMETER UnityEditorPath
    Optional explicit path to Unity.exe or its parent directory.

.PARAMETER ContinueOnError
    If set, continues exporting remaining clips after a failure.

.EXAMPLE
    .\Invoke-VrmaBatchExport.ps1
    .\Invoke-VrmaBatchExport.ps1 -UnityEditorPath "C:\Program Files\Unity\Hub\Editor\2022.3.45f1"
#>
param(
    [string]$UnityEditorPath,
    [switch]$ContinueOnError
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
$exportScript = Join-Path $scriptDir 'Invoke-VrmaExport.ps1'

# ─── Semantic ID mapping ──────────────────────────────────────────────────────
# Format: @{ SemanticId = RelativePathFromRepoRoot }
$clips = [ordered]@{
    'idle.default'       = 'assets/animations/raw/idle.anim'
    'idle.tired'         = 'assets/animations/raw/Tired Idle.anim'
    'idle.combat-ready'  = 'assets/animations/raw/Action Idle To Fight Idle.anim'
}

# ─── Run ──────────────────────────────────────────────────────────────────────

$succeeded = 0
$failed = 0
$total = $clips.Count

Write-Host "╔═══════════════════════════════════════════════════════════╗"
Write-Host "║  VRMA Batch Export: $total clips                            ║"
Write-Host "╚═══════════════════════════════════════════════════════════╝"
Write-Host ""

foreach ($entry in $clips.GetEnumerator()) {
    $semanticId = $entry.Key
    $sourceClip = $entry.Value

    Write-Host "[$($succeeded + $failed + 1)/$total] $semanticId"

    $params = @{
        SemanticId = $semanticId
        SourceClip = $sourceClip
    }
    if ($UnityEditorPath) { $params['UnityEditorPath'] = $UnityEditorPath }

    try {
        & $exportScript @params
        $succeeded++
    } catch {
        $failed++
        Write-Host "  FAILED: $_" -ForegroundColor Red
        if (-not $ContinueOnError) {
            throw "Batch export aborted at $semanticId. Use -ContinueOnError to skip failures."
        }
    }
    Write-Host ""
}

Write-Host "═══════════════════════════════════════════════════════════"
Write-Host "Results: $succeeded succeeded, $failed failed, $total total"
if ($failed -eq 0) {
    Write-Host "All exports completed successfully." -ForegroundColor Green
} else {
    Write-Host "$failed export(s) failed." -ForegroundColor Yellow
}
