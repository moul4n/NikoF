@{
    scenarios = @(
        @{
            id = 'contracts-validation'
            name = 'Contract validation snapshot'
            harness = 'contract-validator'
            baseline = 'baselines/contracts-validation.json'
            tracked_inputs = @(
                'assets/characters/test-vrm-01/manifest.json'
                'assets/characters/test-vrm-02/manifest.json'
                'assets/characters/test-vrm-03/manifest.json'
                'tests/contracts/fixtures/'
                'tests/contracts/schemas/'
                'scripts/asset_validation/validate-contracts.ps1'
            )
        }
        @{
            id = 'bootstrap-prerequisites'
            name = 'Bootstrap prerequisite snapshot'
            harness = 'bootstrap-prerequisites'
            baseline = 'baselines/bootstrap-prerequisites.json'
            tracked_inputs = @(
                'scripts/bootstrap/Test-NikoFPrerequisites.ps1'
                'scripts/bootstrap/bootstrap.targets.json'
            )
        }
    )
}