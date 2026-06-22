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
import {
  ControlSurfaceShell,
  DisplaySurfaceShell
} from "./surfaceShellPresentation";

import {
  resolvePreferredSpeechSynthesisEvent,
  useSurfaceShellOrchestration
} from "./useSurfaceShellOrchestration";
import {
  useAvatarRuntimeConfiguration,
  useAvatarRuntimeSnapshot
} from "./useAvatarRuntimeShell";
import { useRuntimePlaybackSelection } from "./useRuntimePlaybackSelection";
import { cloneDefaultBaseAnimationCommand } from "../avatar/runtime/defaultBaseAnimation";
import {
  createAvatarRuntime,
  type AvatarRuntimeBridge
} from "../avatar/runtime/avatarRuntime";
import type { BackendOperatorCommandResponseDocument } from "../shared/types/character";

export type SurfaceMode = "control" | "display";

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
  } = useCharacterShellState();
  const isDevAnimationSwitcherEnabled = import.meta.env.DEV;
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
  const isAvatarPlaybackSurface = surfaceMode === "display";
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
    devDisplayRigOverlayEnabled,
    setDevDisplayRigOverlayEnabled,
    devDisplayAnimationOverride,
    handleSelectDevDisplayAnimation,
    isDisplayRuntimeReady,
    effectiveDisplayProfileView,
    effectiveDisplayRigOverlayEnabled,
    desiredConversationAnimationLifecycleState,
    desiredConversationAnimationLifecycleReason,
    handleCommandPublished
  } = useSurfaceShellOrchestration({
    surfaceMode,
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
  useAvatarRuntimeConfiguration({
    runtime,
    catalogLoadStatus: loadState.status,
    selectedCharacter,
    effectiveDisplayProfileView,
    effectiveDisplayRigOverlayEnabled
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
    shouldReconcileLifecycle: false
  });
  const {
    devDisplayAnimationActivationKey,
    selectedOption,
    activeAnimationSnapshot,
    shouldWaitForDisplayRuntimeReady,
    shouldUseDevDisplayAnimationOverride,
    shouldUseOfflineIdleFallback
  } = useRuntimePlaybackSelection({
    surfaceMode,
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

  if (surfaceMode === "display") {
    return (
      <DisplaySurfaceShell
        runtime={runtime}
        selectedCharacter={selectedCharacter}
        backendStatusMessage={backendStatusMessage}
        speechLifecycleState={speechLifecycleState}
        speechPlaybackStatus={speechPlaybackStatus}
        isDevAnimationSwitcherEnabled={isDevAnimationSwitcherEnabled}
        devDisplayRigOverlayEnabled={devDisplayRigOverlayEnabled}
        onSetDevDisplayRigOverlayEnabled={setDevDisplayRigOverlayEnabled}
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
    />
  );
}