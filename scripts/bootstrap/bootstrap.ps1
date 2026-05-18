[CmdletBinding()]
param(
    [string]$LocalRoot,
    [string]$ConfigPath,
    [string]$RunHook
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $ConfigPath) {
    $ConfigPath = Join-Path $PSScriptRoot "bootstrap.targets.json"
}

. (Join-Path $PSScriptRoot "Test-NikoFPrerequisites.ps1")

$repoRoot = Get-NikoFRepoRoot -ScriptRoot $PSScriptRoot
$config = Get-NikoFBootstrapConfig -ConfigPath $ConfigPath
$storageLayout = Get-NikoFStorageLayout -RepoRoot $repoRoot -Config $config -LocalRootOverride $LocalRoot
$createdPaths = @(Initialize-NikoFStorageLayout -StorageLayout $storageLayout)
$scaffoldedArtifacts = @()

if ($RunHook) {
    Invoke-NikoFRemediationHook -Config $config -StorageLayout $storageLayout -HookId $RunHook | Out-Null
    exit 0
}

$scaffoldedArtifacts = @(Initialize-NikoFBootstrapArtifacts -Config $config -StorageLayout $storageLayout)
$toolResults = @(Test-NikoFTooling -Config $config)
$providerResults = @(Get-NikoFProviderStatus -Config $config -StorageLayout $storageLayout)
$hintFiles = Export-NikoFRemediationHints -StorageLayout $storageLayout -ProviderResults $providerResults
$envFilePath = Export-NikoFSessionEnvFile -StorageLayout $storageLayout -Config $config
$reportPath = Export-NikoFBootstrapReport -StorageLayout $storageLayout -Config $config -CreatedPaths $createdPaths -ToolResults $toolResults -ProviderResults $providerResults -HintFiles $hintFiles -EnvFilePath $envFilePath

Write-NikoFBootstrapSummary -StorageLayout $storageLayout -CreatedPaths $createdPaths -ScaffoldedArtifacts $scaffoldedArtifacts -ToolResults $toolResults -ProviderResults $providerResults -HintFiles $hintFiles -EnvFilePath $envFilePath -ReportPath $reportPath

if ($toolResults.Where({ -not $_.available }).Count -gt 0) {
    exit 1
}

exit 0