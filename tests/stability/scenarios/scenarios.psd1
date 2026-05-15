@{
    scenarios = @(
        @{
            id = 'animation-contract-boundaries'
            name = 'Animation contract and staged DSL boundary snapshot'
            harness = 'animation-contract-boundaries'
            baseline = 'baselines/animation-contract-boundaries.json'
            tracked_inputs = @(
                'scripts/testing/Invoke-StabilitySuite.ps1'
                'backend/app/schemas/animation.py'
                'backend/app/services/animation.py'
                'assets/animations/dsl/shared/animations.json'
                'assets/animations/dsl/shared/idle.default.json'
            )
        }
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
            id = 'bootstrap-report-surface'
            name = 'Bootstrap report surface snapshot'
            harness = 'bootstrap-report-surface'
            baseline = 'baselines/bootstrap-report-surface.json'
            tracked_inputs = @(
                'scripts/bootstrap/Test-NikoFPrerequisites.ps1'
                'scripts/bootstrap/bootstrap.targets.json'
                'scripts/bootstrap/bootstrap.ps1'
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
                'backend/app/services/speech.py'
                'backend/app/services/session.py'
                'assets/characters/test-vrm-01/manifest.json'
                'assets/characters/test-vrm-02/manifest.json'
                'assets/characters/test-vrm-03/manifest.json'
            )
        }
        @{
            id = 'backend-speech-contracts'
            name = 'Backend speech contract snapshot'
            harness = 'backend-speech-contracts'
            baseline = 'baselines/backend-speech-contracts.json'
            tracked_inputs = @(
                'backend/app/api/router.py'
                'backend/app/schemas/session.py'
                'backend/app/schemas/character.py'
                'backend/app/services/character.py'
                'backend/app/services/speech.py'
                'backend/app/services/session.py'
                'assets/characters/test-vrm-01/manifest.json'
            )
        }
        @{
            id = 'backend-session-animation-live-delivery'
            name = 'Backend session animation live-delivery snapshot'
            harness = 'backend-session-animation-live-delivery'
            baseline = 'baselines/backend-session-animation-live-delivery.json'
            tracked_inputs = @(
                'scripts/testing/Invoke-StabilitySuite.ps1'
                'backend/app/api/router.py'
                'backend/app/schemas/animation.py'
                'backend/app/schemas/session.py'
                'backend/app/services/animation.py'
                'backend/tests/test_event_store.py'
            )
        }
        @{
            id = 'backend-operator-command-surface'
            name = 'Backend operator command surface snapshot'
            harness = 'backend-operator-command-surface'
            baseline = 'baselines/backend-operator-command-surface.json'
            tracked_inputs = @(
                'scripts/testing/Invoke-StabilitySuite.ps1'
                'backend/app/api/router.py'
                'backend/app/schemas/session.py'
                'backend/app/services/speech.py'
            )
        }
        @{
            id = 'backend-stage1-payload-surface'
            name = 'Backend Stage 1 payload surface snapshot'
            harness = 'backend-stage1-payload-surface'
            baseline = 'baselines/backend-stage1-payload-surface.json'
            tracked_inputs = @(
                'backend/app/api/router.py'
                'backend/app/core/settings.py'
                'backend/app/schemas/session.py'
                'backend/app/schemas/character.py'
                'backend/app/schemas/health.py'
                'backend/app/services/character.py'
                'backend/app/services/speech.py'
                'backend/app/services/session.py'
                'assets/characters/test-vrm-01/manifest.json'
                'assets/characters/test-vrm-02/manifest.json'
                'assets/characters/test-vrm-03/manifest.json'
            )
        }
        @{
            id = 'frontend-stage1-bridge-surface'
            name = 'Frontend Stage 1 bridge surface snapshot'
            harness = 'frontend-stage1-bridge-surface'
            baseline = 'baselines/frontend-stage1-bridge-surface.json'
            tracked_inputs = @(
                'frontend/src/app/App.tsx'
                'frontend/src/avatar/loaders/characterCatalog.ts'
                'frontend/src/shared/types/character.ts'
                'tests/stability/baselines/backend-stage1-contracts.json'
                'tests/stability/baselines/backend-stage1-payload-surface.json'
            )
        }
        @{
            id = 'frontend-stage1-character-flow-runtime'
            name = 'Frontend Stage 1 character flow runtime snapshot'
            harness = 'frontend-stage1-character-flow-runtime'
            baseline = 'baselines/frontend-stage1-character-flow-runtime.json'
            tracked_inputs = @(
                'scripts/testing/frontendStage1CharacterFlow.runtime.ts'
                'scripts/testing/Invoke-StabilitySuite.ps1'
                'frontend/src/app/App.tsx'
                'frontend/src/avatar/loaders/backendCharacterFlow.ts'
                'frontend/src/avatar/loaders/characterCatalog.ts'
                'frontend/src/shared/types/character.ts'
                'backend/app/api/router.py'
                'backend/app/core/settings.py'
                'backend/app/schemas/session.py'
                'backend/app/schemas/character.py'
                'backend/app/schemas/health.py'
                'backend/app/services/character.py'
                'backend/app/services/speech.py'
                'backend/app/services/session.py'
                'assets/characters/test-vrm-01/manifest.json'
                'assets/characters/test-vrm-02/manifest.json'
                'assets/characters/test-vrm-03/manifest.json'
            )
        }
        @{
            id = 'frontend-speech-lifecycle-runtime'
            name = 'Frontend speech lifecycle runtime snapshot'
            harness = 'frontend-speech-lifecycle-runtime'
            baseline = 'baselines/frontend-speech-lifecycle-runtime.json'
            tracked_inputs = @(
                'scripts/testing/frontendSpeechLifecycle.runtime.ts'
                'scripts/testing/Invoke-StabilitySuite.ps1'
                'frontend/src/avatar/loaders/speechLifecycle.ts'
                'frontend/src/shared/types/character.ts'
                'backend/app/api/router.py'
                'backend/app/schemas/session.py'
                'backend/app/services/speech.py'
                'tests/stability/baselines/backend-speech-contracts.json'
            )
        }
        @{
            id = 'frontend-avatar-idle-default-runtime'
            name = 'Frontend avatar idle.default runtime seam snapshot'
            harness = 'frontend-avatar-idle-default-runtime'
            baseline = 'baselines/frontend-avatar-idle-default-runtime.json'
            tracked_inputs = @(
                'scripts/testing/frontendAvatarIdleDefault.runtime.ts'
                'scripts/testing/Invoke-StabilitySuite.ps1'
                'backend/app/api/router.py'
                'backend/app/schemas/animation.py'
                'backend/app/services/animation.py'
                'frontend/src/avatar/loaders/sessionAnimation.ts'
                'frontend/src/avatar/runtime/baseAnimationMotionProfile.ts'
                'frontend/src/avatar/runtime/defaultBaseAnimation.ts'
                'frontend/src/avatar/runtime/avatarRuntime.ts'
                'frontend/src/avatar/runtime/humanoidChannelPlayback.ts'
                'frontend/src/app/App.tsx'
                'frontend/src/shared/types/animation.ts'
                'frontend/src/shared/types/character.ts'
                'assets/animations/dsl/shared/animations.json'
                'assets/animations/dsl/shared/idle.default.json'
                'assets/animations/generated/shared/idle.default/idle.default.runtime.json'
                'assets/animations/generated/shared/speak.loop/speak.loop.runtime.json'
                'docs/ANIMATION_DSL_SCHEMA.md'
            )
        }
        @{
            id = 'frontend-semantic-loop-assets-runtime'
            name = 'Frontend semantic loop asset runtime snapshot'
            harness = 'frontend-semantic-loop-assets-runtime'
            baseline = 'baselines/frontend-semantic-loop-assets-runtime.json'
            tracked_inputs = @(
                'scripts/testing/frontendSemanticLoopAssets.runtime.ts'
                'scripts/testing/Invoke-StabilitySuite.ps1'
                'backend/app/services/animation.py'
                'backend/app/schemas/session.py'
                'frontend/src/avatar/runtime/avatarRuntime.ts'
                'frontend/src/avatar/runtime/baseAnimationMotionProfile.ts'
                'frontend/src/avatar/runtime/defaultBaseAnimation.ts'
                'frontend/src/shared/types/animation.ts'
                'frontend/src/vite-env.d.ts'
                'assets/animations/dsl/shared/animations.json'
                'assets/animations/dsl/shared/listen.loop.json'
                'assets/animations/dsl/shared/speak.loop.json'
                'assets/animations/dsl/generated/shared/listen.loop.json'
                'assets/animations/dsl/generated/shared/speak.loop.json'
                'assets/animations/generated/shared/idle.default/idle.default.runtime.json'
                'assets/animations/generated/shared/listen.loop/listen.loop.runtime.json'
                'assets/animations/generated/shared/speak.loop/speak.loop.runtime.json'
            )
        }
    )
}