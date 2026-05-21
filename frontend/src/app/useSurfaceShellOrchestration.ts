import { useEffect, useState } from "react";
import { resolveSelectedCharacterId } from "../avatar/loaders/backendCharacterFlow";
import type {
  AvatarAnimationPlaybackPath,
  AvatarDebugProfileView,
  AvatarRuntimeSnapshot
} from "../avatar/runtime/avatarRuntime";
import type {
  BackendOperatorCommandResponseDocument,
  BackendSessionEventDocument,
  CharacterCatalog,
  CharacterCatalogEntry,
  CharacterId
} from "../shared/types/character";
import {
  resolveDevDisplayAnimationOption,
  type DevDisplayAnimationOptionId,
  type DevDisplayAnimationOverrideState
} from "./devDisplayTools";
import type { BackendSyncState } from "./useCharacterShellState";
import {
  resolveSpeechLifecycleCharacterId,
  type SpeechLifecycleLoadState
} from "./useSpeechLifecycleState";
import type { SpeechPlaybackStatus } from "./useSpeechPlaybackBridge";

type SurfaceMode = "control" | "display";
type AnimationLifecycleState = "idle" | "listen" | "speak";
type SpeechLifecycleSnapshot = SpeechLifecycleLoadState["snapshot"];
type StateSetter<TValue> = (value: TValue | ((currentValue: TValue) => TValue)) => void;

interface UseSurfaceShellOrchestrationOptions {
  surfaceMode: SurfaceMode;
  catalog: CharacterCatalog | null;
  catalogLoadStatus: "loading" | "ready" | "error";
  selectedCharacter: CharacterCatalogEntry | null;
  selectedCharacterId: CharacterId | null;
  setSelectedCharacterId: StateSetter<CharacterId | null>;
  latestPublishedCommand: BackendOperatorCommandResponseDocument | null;
  setLatestPublishedCommand: StateSetter<BackendOperatorCommandResponseDocument | null>;
  backendSyncState: BackendSyncState;
  speechLifecycleState: SpeechLifecycleLoadState;
  speechPlaybackStatus: SpeechPlaybackStatus;
  avatarRuntimeSnapshot: AvatarRuntimeSnapshot;
  isDevAnimationSwitcherEnabled: boolean;
  refreshSpeechLifecycle: () => void;
}

interface UseSurfaceShellOrchestrationResult {
  devDisplayProfileView: AvatarDebugProfileView;
  setDevDisplayProfileView: StateSetter<AvatarDebugProfileView>;
  devDisplayRigOverlayEnabled: boolean;
  setDevDisplayRigOverlayEnabled: StateSetter<boolean>;
  devDisplayPlaybackPath: AvatarAnimationPlaybackPath;
  setDevDisplayPlaybackPath: StateSetter<AvatarAnimationPlaybackPath>;
  devDisplayAnimationOverride: DevDisplayAnimationOverrideState;
  handleSelectDevDisplayAnimation: (optionId: DevDisplayAnimationOptionId) => void;
  isDisplayRuntimeReady: boolean;
  effectiveDisplayProfileView: AvatarDebugProfileView;
  effectiveDisplayRigOverlayEnabled: boolean;
  effectiveDisplayPlaybackPath: AvatarAnimationPlaybackPath;
  desiredConversationAnimationLifecycleState: AnimationLifecycleState | null;
  desiredConversationAnimationLifecycleReason: string | null;
  handleCommandPublished: (response: BackendOperatorCommandResponseDocument | null) => void;
}

function parseSpeechLifecycleCursor(cursor: string | null | undefined): {
  sessionId: string;
  sequence: number;
} | null {
  const trimmedCursor = cursor?.trim();

  if (!trimmedCursor) {
    return null;
  }

  const match = /^speech\.lifecycle:([^:]+):(\d+)$/.exec(trimmedCursor);

  if (!match) {
    return null;
  }

  return {
    sessionId: match[1],
    sequence: Number.parseInt(match[2], 10)
  };
}

function hasSpeechLifecycleSnapshotCaughtUp(
  snapshot: SpeechLifecycleSnapshot,
  publishedCommand: BackendOperatorCommandResponseDocument | null
): boolean {
  const snapshotCursor = parseSpeechLifecycleCursor(snapshot?.nextCursor ?? null);
  const publishedCursor = parseSpeechLifecycleCursor(publishedCommand?.next_speech_cursor ?? null);

  if (!snapshotCursor || !publishedCursor) {
    return false;
  }

  return snapshotCursor.sessionId === publishedCursor.sessionId && snapshotCursor.sequence >= publishedCursor.sequence;
}

function hasPendingPublishedSpeechLifecycle(
  snapshot: SpeechLifecycleSnapshot,
  publishedCommand: BackendOperatorCommandResponseDocument | null
): boolean {
  if (!publishedCommand || publishedCommand.status !== "ready") {
    return false;
  }

  const publishedCanonicalSpeech = publishedCommand.speech_lifecycle_events.some(
    (envelope) => envelope.event.event_type === "speech.synthesis"
  );

  if (!publishedCanonicalSpeech) {
    return false;
  }

  return !hasSpeechLifecycleSnapshotCaughtUp(snapshot, publishedCommand);
}

function resolvePublishedSpeechSynthesisEvent(
  publishedCommand: BackendOperatorCommandResponseDocument | null
): BackendSessionEventDocument | null {
  return (
    publishedCommand?.speech_lifecycle_events.find((envelope) => envelope.event.event_type === "speech.synthesis")?.event ??
    null
  );
}

export function resolvePreferredSpeechSynthesisEvent(
  snapshot: SpeechLifecycleSnapshot,
  publishedCommand: BackendOperatorCommandResponseDocument | null
): BackendSessionEventDocument | null {
  if (hasPendingPublishedSpeechLifecycle(snapshot, publishedCommand)) {
    return resolvePublishedSpeechSynthesisEvent(publishedCommand) ?? snapshot?.canonicalSpeechSynthesisEvent ?? null;
  }

  return snapshot?.canonicalSpeechSynthesisEvent ?? resolvePublishedSpeechSynthesisEvent(publishedCommand);
}

function hasActiveCanonicalTranscription(snapshot: SpeechLifecycleSnapshot): boolean {
  const transcriptionStatus = snapshot?.canonicalTranscriptionEvent?.transcription?.status?.trim().toLowerCase();

  if (!transcriptionStatus) {
    return false;
  }

  return !["degraded", "error", "final", "ready", "unavailable"].includes(transcriptionStatus);
}

function resolveDesiredConversationAnimationLifecycleState(
  speechSnapshot: SpeechLifecycleSnapshot,
  publishedCommand: BackendOperatorCommandResponseDocument | null,
  speechPlaybackStatus: SpeechPlaybackStatus
): AnimationLifecycleState {
  if (hasPendingPublishedSpeechLifecycle(speechSnapshot, publishedCommand)) {
    return "speak";
  }

  if (speechPlaybackStatus !== "idle" && speechSnapshot?.canonicalSpeechSynthesisEvent?.synthesis) {
    return "speak";
  }

  if (hasActiveCanonicalTranscription(speechSnapshot)) {
    return "listen";
  }

  return "idle";
}

function resolveAnimationLifecycleUpdateReason(
  lifecycleState: AnimationLifecycleState,
  speechSnapshot: SpeechLifecycleSnapshot,
  publishedCommand: BackendOperatorCommandResponseDocument | null,
  speechPlaybackStatus: SpeechPlaybackStatus
): string {
  if (lifecycleState === "listen") {
    return "canonical_transcription_active";
  }

  if (lifecycleState === "speak") {
    if (hasPendingPublishedSpeechLifecycle(speechSnapshot, publishedCommand)) {
      return "canonical_command_published";
    }

    if (speechPlaybackStatus !== "idle") {
      return "canonical_speech_playback_active";
    }

    return "canonical_synthesis_active";
  }

  return "conversation_idle";
}

export function useSurfaceShellOrchestration({
  surfaceMode,
  catalog,
  catalogLoadStatus,
  selectedCharacter,
  selectedCharacterId,
  setSelectedCharacterId,
  latestPublishedCommand,
  setLatestPublishedCommand,
  backendSyncState,
  speechLifecycleState,
  speechPlaybackStatus,
  avatarRuntimeSnapshot,
  isDevAnimationSwitcherEnabled,
  refreshSpeechLifecycle
}: UseSurfaceShellOrchestrationOptions): UseSurfaceShellOrchestrationResult {
  const [devDisplayProfileView, setDevDisplayProfileView] = useState<AvatarDebugProfileView>("front");
  const [devDisplayRigOverlayEnabled, setDevDisplayRigOverlayEnabled] = useState(false);
  const [devDisplayPlaybackPath, setDevDisplayPlaybackPath] = useState<AvatarAnimationPlaybackPath>("official");
  const [devDisplayAnimationOverride, setDevDisplayAnimationOverride] = useState<DevDisplayAnimationOverrideState>({
    optionId: "backend",
    activationKey: 0
  });

  const isDisplayRuntimeReady = avatarRuntimeSnapshot.mounted && avatarRuntimeSnapshot.loadState === "ready";
  const effectiveDisplayProfileView: AvatarDebugProfileView =
    surfaceMode === "display" && isDevAnimationSwitcherEnabled ? devDisplayProfileView : "front";
  const effectiveDisplayRigOverlayEnabled =
    surfaceMode === "display" && isDevAnimationSwitcherEnabled ? devDisplayRigOverlayEnabled : false;
  const effectiveDisplayPlaybackPath: AvatarAnimationPlaybackPath =
    surfaceMode === "display" && isDevAnimationSwitcherEnabled ? devDisplayPlaybackPath : "official";
  const desiredConversationAnimationLifecycleState =
    catalogLoadStatus === "ready" && selectedCharacter
      ? resolveDesiredConversationAnimationLifecycleState(
          speechLifecycleState.snapshot,
          latestPublishedCommand,
          speechPlaybackStatus
        )
      : null;
  const desiredConversationAnimationLifecycleReason =
    desiredConversationAnimationLifecycleState === null
      ? null
      : resolveAnimationLifecycleUpdateReason(
          desiredConversationAnimationLifecycleState,
          speechLifecycleState.snapshot,
          latestPublishedCommand,
          speechPlaybackStatus
        );

  useEffect(() => {
    if (!latestPublishedCommand) {
      return;
    }

    if (hasSpeechLifecycleSnapshotCaughtUp(speechLifecycleState.snapshot, latestPublishedCommand)) {
      setLatestPublishedCommand((currentCommand) => {
        if (currentCommand?.next_speech_cursor !== latestPublishedCommand.next_speech_cursor) {
          return currentCommand;
        }

        return null;
      });
      return;
    }

    // Safety net: if the snapshot never catches up (e.g. backend restarted and
    // lost the event store), clear the stale published command after a timeout.
    const stalenessTimeout = setTimeout(() => {
      setLatestPublishedCommand((currentCommand) => {
        if (currentCommand?.next_speech_cursor !== latestPublishedCommand.next_speech_cursor) {
          return currentCommand;
        }

        return null;
      });
    }, 15_000);

    return () => clearTimeout(stalenessTimeout);
  }, [latestPublishedCommand, speechLifecycleState.snapshot]);

  useEffect(() => {
    if (surfaceMode !== "display" || catalogLoadStatus !== "ready" || !backendSyncState.activeCharacterConnected) {
      return;
    }

    const backendLifecycleCharacterId = resolveSpeechLifecycleCharacterId(speechLifecycleState.snapshot);

    if (!backendLifecycleCharacterId || !catalog) {
      return;
    }

    const reconciledCharacterId = resolveSelectedCharacterId(catalog, backendLifecycleCharacterId);

    if (!reconciledCharacterId || reconciledCharacterId === selectedCharacterId) {
      return;
    }

    setSelectedCharacterId(reconciledCharacterId);
  }, [
    backendSyncState.activeCharacterConnected,
    catalog,
    catalogLoadStatus,
    selectedCharacterId,
    setSelectedCharacterId,
    speechLifecycleState.snapshot,
    surfaceMode
  ]);

  function handleCommandPublished(response: BackendOperatorCommandResponseDocument | null): void {
    if (!response) {
      setLatestPublishedCommand(null);
      return;
    }

    const reconciledCharacterId = catalog
      ? resolveSelectedCharacterId(catalog, response.character_id)
      : response.character_id;

    setLatestPublishedCommand(response);

    if (reconciledCharacterId && reconciledCharacterId !== selectedCharacterId) {
      setSelectedCharacterId(reconciledCharacterId);
    }

    refreshSpeechLifecycle();
  }

  function handleSelectDevDisplayAnimation(optionId: DevDisplayAnimationOptionId): void {
    if (!isDevAnimationSwitcherEnabled || !isDisplayRuntimeReady) {
      return;
    }

    setDevDisplayAnimationOverride((currentState) => ({
      optionId,
      activationKey: currentState.activationKey + 1
    }));
  }

  return {
    devDisplayProfileView,
    setDevDisplayProfileView,
    devDisplayRigOverlayEnabled,
    setDevDisplayRigOverlayEnabled,
    devDisplayPlaybackPath,
    setDevDisplayPlaybackPath,
    devDisplayAnimationOverride,
    handleSelectDevDisplayAnimation,
    isDisplayRuntimeReady,
    effectiveDisplayProfileView,
    effectiveDisplayRigOverlayEnabled,
    effectiveDisplayPlaybackPath,
    desiredConversationAnimationLifecycleState,
    desiredConversationAnimationLifecycleReason,
    handleCommandPublished
  };
}
