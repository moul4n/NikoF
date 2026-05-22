[CmdletBinding()]
param(
    [switch]$BackendOnly,
    [switch]$FrontendOnly,
    [switch]$ValidateOnly,
    [int]$StopAfterSeconds = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($BackendOnly -and $FrontendOnly) {
    throw 'Choose either -BackendOnly or -FrontendOnly, not both.'
}
if ($StopAfterSeconds -lt 0) {
    throw '-StopAfterSeconds must be zero or a positive integer.'
}

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$backendRoot = Join-Path $repoRoot 'backend'
$frontendRoot = Join-Path $repoRoot 'frontend'
$backendPython = Join-Path $repoRoot '.venv\Scripts\python.exe'
$pwshCommand = (Get-Command pwsh -ErrorAction Stop).Source

$targets = @()
if (-not $FrontendOnly) {
    $targets += [pscustomobject]@{
        Name = 'backend'
        WorkingDirectory = $backendRoot
        Command = '.\\..\\.venv\\Scripts\\python.exe -m app.dev_server'
        Url = 'http://127.0.0.1:8000/health'
    }
}
if (-not $BackendOnly) {
    $targets += [pscustomobject]@{
        Name = 'frontend'
        WorkingDirectory = $frontendRoot
        Command = 'npm run dev'
        Url = 'http://127.0.0.1:5173/'
    }
}

if (-not (Test-Path -LiteralPath $backendPython -PathType Leaf)) {
    throw "Backend virtualenv Python not found at $backendPython"
}

if ($ValidateOnly) {
    $targets | ConvertTo-Json -Depth 4
    exit 0
}

$managedProcesses = New-Object System.Collections.Generic.List[System.Diagnostics.Process]

function Start-NikoFManagedProcess {
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$Target
    )

    Write-Host ("Starting {0} in a managed child PowerShell window" -f $Target.Name)
    $process = Start-Process -FilePath $pwshCommand -ArgumentList @(
        '-NoLogo',
        '-NoProfile',
        '-NoExit',
        '-Command',
        $Target.Command
    ) -WorkingDirectory $Target.WorkingDirectory -PassThru
    $managedProcesses.Add($process)
    return $process
}

try {
    foreach ($target in $targets) {
        $process = Start-NikoFManagedProcess -Target $target
        Write-Host ("{0} started with pid {1} -> {2}" -f $target.Name, $process.Id, $target.Url)
    }

    if ($managedProcesses.Count -eq 0) {
        throw 'No processes were selected to start.'
    }

    $managedProcessIds = @($managedProcesses | ForEach-Object { $_.Id })
    if ($StopAfterSeconds -gt 0) {
        Write-Host ("Managed dev stack will auto-stop after {0} seconds." -f $StopAfterSeconds)
        Wait-Process -Id $managedProcessIds -Timeout $StopAfterSeconds -ErrorAction SilentlyContinue
        Write-Host 'Managed dev stack stop window reached; shutting down child process trees.'
    }
    else {
        Write-Host 'Press Ctrl+C in this supervisor window to stop the managed dev stack.'
        Wait-Process -Id $managedProcessIds
    }
}
finally {
    foreach ($process in $managedProcesses) {
        try {
            if (-not $process.HasExited) {
                & taskkill /PID $process.Id /T /F | Out-Null
            }
        }
        catch {
        }
    }
}