import React, { useEffect, useState } from "react";
import { useCharacterShellState } from "./useCharacterShellState";
import { useSessionAnimationState } from "./useSessionAnimationState";
import {
  useSpeechLifecycleState
} from "./useSpeechLifecycleState";
import {
  useSpeechPlaybackBridge,
} from "./useSpeechPlaybackBridge";
import { useSpeechAudioStream } from "./useSpeechAudioStream";
import { useAudioOutputSink } from "./useAudioOutputState";
import {
  ControlSurfaceShell,
  DisplaySurfaceShell
} from "./surfaceShellPresentation";
import { StageSurfaceShell } from "./StageSurfaceShell";

import {
  resolvePreferredSpeechSynthesisEvent,
  useSurfaceShellOrchestration
} from "./useSurfaceShellOrchestration";
import {
  useAvatarRuntimeConfiguration,
  useAvatarRuntimeSnapshot
} from "./useAvatarRuntimeShell";
import { useRuntimePlaybackSelection } from "./useRuntimePlaybackSelection";
import { useDisplaySettings } from "./useDisplaySettings";
import { cloneDefaultBaseAnimationCommand } from "../avatar/runtime/defaultBaseAnimation";
import {
  createAvatarRuntime,
  type AvatarRuntimeBridge
} from "../avatar/runtime/avatarRuntime";
import type { BackendOperatorCommandResponseDocument } from "../shared/types/character";

export type SurfaceMode = "control" | "display" | "stage";

interface AppProps {
  surfaceMode: SurfaceMode;
}

function resolveMoodDrivenIdleCommand(feelingName: string | null | undefined) {
  const normalizedFeelingName = feelingName?.trim().toLowerCase();

  if (normalizedFeelingName === "happy") {
    return {
      id: "idle.happy",
      playback: "loop"
    } as const;
  }

  if (normalizedFeelingName === "sad") {
    return {
      id: "idle.sad",
      playback: "loop"
    } as const;
  }

  return cloneDefaultBaseAnimationCommand();
}

export function App({ surfaceMode }: AppProps): JSX.Element {
  const [runtime] = useState<AvatarRuntimeBridge>(() => createAvatarRuntime());
  // The wrapperless "stage" surface behaves exactly like "display" for all
  // runtime/playback logic (it renders + voices the avatar); only the rendered
  // shell differs. Collapse it to "display" everywhere except the final branch.
  const runtimeSurfaceMode: "control" | "display" = surfaceMode === "stage" ? "display" : surfaceMode;
  const [latestPublishedCommand, setLatestPublishedCommand] = useState<BackendOperatorCommandResponseDocument | null>(null);
  const {
    loadState,
    backendSyncState,
    backendStatusMessage,
    selectedCharacter,
    selectedCharacterId,
    setSelectedCharacterId,
    speechLifecycleRefreshKey,
    sessionAnimationRefreshKey,
    refreshSpeechLifecycle,
    handleSelectCharacter
  } = useCharacterShellState({
    followBackendActiveCharacter: runtimeSurfaceMode === "display",
    assertSelectionToBackend: runtimeSurfaceMode === "control"
  });
  // The stage surface has no dev switcher UI and must stay purely backend-driven
  // (so commands from the control surface play through), so never enable the dev
  // animation override there even in a dev build.
  const isDevAnimationSwitcherEnabled = import.meta.env.DEV && surfaceMode !== "stage";
  const speechLifecycleState = useSpeechLifecycleState({
    catalogLoadStatus: loadState.status,
    externalRefreshKey: speechLifecycleRefreshKey
  });
  const preferredSpeechSynthesisEvent = resolvePreferredSpeechSynthesisEvent(
    speechLifecycleState.snapshot,
    latestPublishedCommand
  );
  // Voice replies only on the surface that renders the avatar/animation
  // (the display surface). This both fixes duplicate audio across windows and
  // scopes the streamed-audio WebSocket consumer to the page with the avatar.
  const isAvatarPlaybackSurface = runtimeSurfaceMode === "display";
  // Route avatar speech playback to the backend-saved output device on whichever
  // surface voices the avatar, so the display window follows a control-surface
  // change and a reload restores the same speakers.
  useAudioOutputSink();
  const speechAudioStream = useSpeechAudioStream({ enabled: isAvatarPlaybackSurface });
  const speechPlaybackStatus = useSpeechPlaybackBridge({
    runtime,
    canonicalSynthesisEvent: preferredSpeechSynthesisEvent,
    latestAvailableSynthesisEvent: speechLifecycleState.snapshot?.canonicalSpeechSynthesisEvent ?? null,
    canonicalSynthesisSegments: speechLifecycleState.snapshot?.canonicalSpeechSynthesisSegments ?? [],
    playbackEnabled: isAvatarPlaybackSurface,
    resolveSegmentAudioOverride: speechAudioStream.getSegmentAudioUrl
  });
  const avatarRuntimeSnapshot = useAvatarRuntimeSnapshot({ runtime });
  const {
    devDisplayProfileView,
    setDevDisplayProfileView,
    devDisplayAnimationOverride,
    handleSelectDevDisplayAnimation,
    isDisplayRuntimeReady,
    effectiveDisplayProfileView,
    desiredConversationAnimationLifecycleState,
    desiredConversationAnimationLifecycleReason,
    handleCommandPublished
  } = useSurfaceShellOrchestration({
    surfaceMode: runtimeSurfaceMode,
    catalog: loadState.catalog,
    catalogLoadStatus: loadState.status,
    selectedCharacter,
    selectedCharacterId,
    setSelectedCharacterId,
    latestPublishedCommand,
    setLatestPublishedCommand,
    backendSyncState,
    speechLifecycleState,
    speechPlaybackStatus: speechPlaybackStatus.status,
    avatarRuntimeSnapshot,
    isDevAnimationSwitcherEnabled,
    refreshSpeechLifecycle
  });
  // Single source of truth for persistent display + wardrobe settings (durable,
  // backend-backed). Applies the active character's wardrobe to the runtime;
  // bone overlay is applied via the runtime-configuration effect below.
  const displaySettings = useDisplaySettings({
    runtime,
    activeCharacterId: selectedCharacter?.summary.characterId ?? null,
    runtimeReadyToken: avatarRuntimeSnapshot.loadState
  });
  useAvatarRuntimeConfiguration({
    runtime,
    catalogLoadStatus: loadState.status,
    selectedCharacter,
    effectiveDisplayProfileView,
    // Bone overlay is now a backend-driven display setting (toggled from the
    // control surface, persisted). runtimeSurfaceMode maps the stage window to
    // "display", so this applies to both the browser display and the Tauri stage.
    effectiveDisplayRigOverlayEnabled:
      runtimeSurfaceMode === "display" ? displaySettings.boneOverlayEnabled : false
  });

  const sessionAnimationState = useSessionAnimationState({
    catalog: loadState.catalog,
    catalogLoadStatus: loadState.status,
    backendActiveCharacterConnected: backendSyncState.activeCharacterConnected,
    selectedCharacterId,
    setSelectedCharacterId,
    externalRefreshKey: sessionAnimationRefreshKey,
    desiredLifecycleState: desiredConversationAnimationLifecycleState,
    desiredLifecycleReason: desiredConversationAnimationLifecycleReason,
    shouldReconcileLifecycle: false,
    followBackendActiveCharacter: runtimeSurfaceMode === "display"
  });
  const {
    devDisplayAnimationActivationKey,
    selectedOption,
    activeAnimationSnapshot,
    shouldWaitForDisplayRuntimeReady,
    shouldUseDevDisplayAnimationOverride,
    shouldUseOfflineIdleFallback
  } = useRuntimePlaybackSelection({
    surfaceMode: runtimeSurfaceMode,
    isDevAnimationSwitcherEnabled,
    isDisplayRuntimeReady,
    devDisplayAnimationOverride,
    sessionAnimationState
  });
  const currentAssistantFeelingName = speechLifecycleState.snapshot?.canonicalAssistantMessageEvent?.assistant?.feeling?.name;

  useEffect(() => {
    runtime.setIdleAnimation(resolveMoodDrivenIdleCommand(currentAssistantFeelingName), { source: "system" });
  }, [currentAssistantFeelingName, runtime]);

  useEffect(() => {
    if (shouldWaitForDisplayRuntimeReady || !shouldUseDevDisplayAnimationOverride) {
      return;
    }

    if (selectedOption.behavior === "neutral") {
      runtime.play(null);
      return;
    }

    if (selectedOption.behavior === "command" && selectedOption.semanticCommand) {
      runtime.play({ ...selectedOption.semanticCommand });
    }
  }, [
    devDisplayAnimationActivationKey,
    runtime,
    selectedOption,
    shouldUseDevDisplayAnimationOverride,
    shouldWaitForDisplayRuntimeReady
  ]);

  useEffect(() => {
    if (shouldWaitForDisplayRuntimeReady || shouldUseDevDisplayAnimationOverride) {
      return;
    }

    if (activeAnimationSnapshot) {
      runtime.play(activeAnimationSnapshot.semanticCommand);
      return;
    }

    if (shouldUseOfflineIdleFallback) {
      runtime.play(cloneDefaultBaseAnimationCommand());
    }
  }, [
    activeAnimationSnapshot,
    runtime,
    shouldUseDevDisplayAnimationOverride,
    shouldUseOfflineIdleFallback,
    shouldWaitForDisplayRuntimeReady
  ]);

  if (surfaceMode === "stage") {
    return <StageSurfaceShell runtime={runtime} selectedCharacter={selectedCharacter} />;
  }

  if (surfaceMode === "display") {
    return (
      <DisplaySurfaceShell
        runtime={runtime}
        selectedCharacter={selectedCharacter}
        backendStatusMessage={backendStatusMessage}
        speechLifecycleState={speechLifecycleState}
        speechPlaybackStatus={speechPlaybackStatus}
        isDevAnimationSwitcherEnabled={isDevAnimationSwitcherEnabled}
        devDisplayRigOverlayEnabled={displaySettings.boneOverlayEnabled}
        onSetDevDisplayRigOverlayEnabled={displaySettings.setBoneOverlay}
        captionsEnabled={displaySettings.captionsEnabled}
        onSetCaptionsEnabled={displaySettings.setCaptions}
        onAppearanceControlChange={displaySettings.setWardrobeControl}
        onAppearanceReset={displaySettings.resetWardrobe}
        onSelectDevDisplayAnimation={handleSelectDevDisplayAnimation}
        isDisplayRuntimeReady={isDisplayRuntimeReady}
      />
    );
  }

  return (
    <ControlSurfaceShell
      loadState={loadState}
      selectedCharacter={selectedCharacter}
      selectedCharacterId={selectedCharacterId}
      onSelectCharacter={handleSelectCharacter}
      onCommandPublished={handleCommandPublished}
      backendStatusMessage={backendStatusMessage}
      backendSyncState={backendSyncState}
      speechLifecycleState={speechLifecycleState}
      speechPlaybackStatus={speechPlaybackStatus}
      displaySettings={displaySettings}
    />
  );
}