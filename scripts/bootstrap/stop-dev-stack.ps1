[CmdletBinding()]
param(
    [switch]$BackendOnly,
    [switch]$FrontendOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($BackendOnly -and $FrontendOnly) {
    throw 'Choose either -BackendOnly or -FrontendOnly, not both.'
}

function Stop-ProcessTreeByPid {
    param(
        [Parameter(Mandatory)]
        [int]$TargetPid
    )

    try {
        & taskkill /PID $TargetPid /T /F | Out-Null
        Write-Host ("Stopped process tree rooted at pid {0}." -f $TargetPid)
    }
    catch {
        Write-Warning ("Failed to stop process tree rooted at pid {0}: {1}" -f $TargetPid, $_.Exception.Message)
    }
}

function Get-ListeningPid {
    param(
        [Parameter(Mandatory)]
        [int]$Port
    )

    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $listener) {
        return $null
    }

    return [int]$listener.OwningProcess
}

function Stop-PortOwner {
    param(
        [Parameter(Mandatory)]
        [int]$Port,
        [Parameter(Mandatory)]
        [string]$Label
    )

    $ownerPid = Get-ListeningPid -Port $Port
    if ($null -eq $ownerPid) {
        Write-Host ("No listener found on port {0} for {1}." -f $Port, $Label)
        return $false
    }

    Write-Host ("Stopping {0} on port {1} (pid {2})." -f $Label, $Port, $ownerPid)
    Stop-ProcessTreeByPid -TargetPid $ownerPid
    return $true
}

$stoppedBackend = $false

if (-not $FrontendOnly) {
    $stoppedBackend = Stop-PortOwner -Port 8000 -Label 'backend'
}

if (-not $BackendOnly) {
    [void](Stop-PortOwner -Port 5173 -Label 'frontend')
}

if (-not $FrontendOnly) {
    $ollamaPid = Get-ListeningPid -Port 11434
    if ($null -ne $ollamaPid) {
        Write-Host ("Stopping Ollama listener on port 11434 (pid {0})." -f $ollamaPid)
        Stop-ProcessTreeByPid -TargetPid $ollamaPid
    }
    elseif ($stoppedBackend) {
        Write-Host 'No orphaned Ollama listener found on port 11434 after backend shutdown.'
    }
}