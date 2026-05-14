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
        @{
            id = 'backend-stage1-contracts'
            name = 'Backend Stage 1 contract snapshot'
            harness = 'backend-stage1-contracts'
            baseline = 'baselines/backend-stage1-contracts.json'
            tracked_inputs = @(
                'backend/app/api/router.py'
                'backend/app/core/settings.py'
                'backend/app/schemas/session.py'
                'backend/app/schemas/character.py'
                'backend/app/schemas/health.py'
                'backend/app/services/character.py'
                'backend/app/services/session.py'
                'assets/characters/test-vrm-01/manifest.json'
                'assets/characters/test-vrm-02/manifest.json'
                'assets/characters/test-vrm-03/manifest.json'
            )
        }
    )
}