[CmdletBinding()]
param(
    [string]$LocalRoot,
    [string]$ConfigPath = (Join-Path $PSScriptRoot "bootstrap.targets.json")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "Test-NikoFPrerequisites.ps1")

$repoRoot = Get-NikoFRepoRoot -ScriptRoot $PSScriptRoot
$config = Get-NikoFBootstrapConfig -ConfigPath $ConfigPath
$storageLayout = Get-NikoFStorageLayout -RepoRoot $repoRoot -Config $config -LocalRootOverride $LocalRoot
$createdPaths = @(Initialize-NikoFStorageLayout -StorageLayout $storageLayout)
$toolResults = @(Test-NikoFTooling -Config $config)
$providerResults = @(Get-NikoFProviderStatus -Config $config -StorageLayout $storageLayout)
$envFilePath = Export-NikoFSessionEnvFile -StorageLayout $storageLayout -Config $config
$reportPath = Export-NikoFBootstrapReport -StorageLayout $storageLayout -Config $config -CreatedPaths $createdPaths -ToolResults $toolResults -ProviderResults $providerResults -EnvFilePath $envFilePath

Write-NikoFBootstrapSummary -StorageLayout $storageLayout -CreatedPaths $createdPaths -ToolResults $toolResults -ProviderResults $providerResults -EnvFilePath $envFilePath -ReportPath $reportPath

if ($toolResults.Where({ -not $_.available }).Count -gt 0) {
    exit 1
}

exit 0