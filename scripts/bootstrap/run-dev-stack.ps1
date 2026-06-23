[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$PassThroughArgs
)

# DEPRECATED: run-dev-stack.ps1 has been retired in favour of the single front door.
# Use start-all.bat (preflight-gated full bring-up) and stop-dev-stack.ps1 (cleanup).
# This shim forwards to start-all.ps1 so existing muscle memory keeps working.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Write-Warning 'run-dev-stack.ps1 is deprecated. Use start-all.bat to launch and stop-dev-stack.ps1 to stop.'
Write-Warning 'Forwarding to start-all.ps1 (note: -BackendOnly/-FrontendOnly/-StopAfterSeconds are no longer supported here).'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$startAll = Join-Path $repoRoot 'start-all.ps1'
if (-not (Test-Path -LiteralPath $startAll)) {
    throw "start-all.ps1 not found at $startAll"
}

# Only forward flags start-all understands; drop the retired ones.
$forward = @()
foreach ($arg in @($PassThroughArgs)) {
    if ($arg -in @('-SkipPreflight', '-Force', '-NoStage')) {
        $forward += $arg
    }
}

& $startAll @forward
exit $LASTEXITCODE
