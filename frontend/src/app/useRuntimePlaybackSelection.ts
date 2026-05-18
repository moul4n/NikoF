import {
  resolveDevDisplayAnimationOption,
  type DevDisplayAnimationOverrideState
} from "./devDisplayTools";
import type { SessionAnimationLoadState } from "./useSessionAnimationState";

type SurfaceMode = "control" | "display";

interface UseRuntimePlaybackSelectionOptions {
  surfaceMode: SurfaceMode;
  isDevAnimationSwitcherEnabled: boolean;
  isDisplayRuntimeReady: boolean;
  devDisplayAnimationOverride: DevDisplayAnimationOverrideState;
  sessionAnimationState: SessionAnimationLoadState;
}

interface UseRuntimePlaybackSelectionResult {
  devDisplayAnimationActivationKey: number;
  selectedOption: ReturnType<typeof resolveDevDisplayAnimationOption>;
  activeAnimationSnapshot: SessionAnimationLoadState["snapshot"];
  shouldWaitForDisplayRuntimeReady: boolean;
  shouldUseDevDisplayAnimationOverride: boolean;
  shouldUseOfflineIdleFallback: boolean;
}

export function useRuntimePlaybackSelection({
  surfaceMode,
  isDevAnimationSwitcherEnabled,
  isDisplayRuntimeReady,
  devDisplayAnimationOverride,
  sessionAnimationState
}: UseRuntimePlaybackSelectionOptions): UseRuntimePlaybackSelectionResult {
  const isDisplayOverrideSurface = surfaceMode === "display" && isDevAnimationSwitcherEnabled;

  return {
    devDisplayAnimationActivationKey: devDisplayAnimationOverride.activationKey,
    selectedOption: resolveDevDisplayAnimationOption(devDisplayAnimationOverride.optionId),
    activeAnimationSnapshot: sessionAnimationState.snapshot,
    shouldWaitForDisplayRuntimeReady: isDisplayOverrideSurface && !isDisplayRuntimeReady,
    shouldUseDevDisplayAnimationOverride: isDisplayOverrideSurface && isDisplayRuntimeReady,
    shouldUseOfflineIdleFallback: sessionAnimationState.status === "offline"
  };
}