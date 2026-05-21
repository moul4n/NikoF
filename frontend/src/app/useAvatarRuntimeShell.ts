import { useEffect, useState } from "react";
import type {
  AvatarAnimationPlaybackPath,
  AvatarDebugProfileView,
  AvatarRuntimeBridge,
  AvatarRuntimeSnapshot
} from "../avatar/runtime/avatarRuntime";
import type { CharacterCatalogEntry } from "../shared/types/character";

interface UseAvatarRuntimeSnapshotOptions {
  runtime: AvatarRuntimeBridge;
}

interface UseAvatarRuntimeConfigurationOptions {
  runtime: AvatarRuntimeBridge;
  catalogLoadStatus: "loading" | "ready" | "error";
  selectedCharacter: CharacterCatalogEntry | null;
  effectiveDisplayProfileView: AvatarDebugProfileView;
  effectiveDisplayRigOverlayEnabled: boolean;
  effectiveDisplayPlaybackPath: AvatarAnimationPlaybackPath;
}

export function useAvatarRuntimeSnapshot({
  runtime
}: UseAvatarRuntimeSnapshotOptions): AvatarRuntimeSnapshot {
  const [avatarRuntimeSnapshot, setAvatarRuntimeSnapshot] = useState(() => runtime.snapshot());

  useEffect(() => {
    setAvatarRuntimeSnapshot(runtime.snapshot());

    return runtime.subscribe(() => {
      setAvatarRuntimeSnapshot(runtime.snapshot());
    });
  }, [runtime]);

  return avatarRuntimeSnapshot;
}

export function useAvatarRuntimeConfiguration({
  runtime,
  catalogLoadStatus,
  selectedCharacter,
  effectiveDisplayProfileView,
  effectiveDisplayRigOverlayEnabled,
  effectiveDisplayPlaybackPath
}: UseAvatarRuntimeConfigurationOptions): void {
  useEffect(() => {
    runtime.setDebugProfileView(effectiveDisplayProfileView);
  }, [effectiveDisplayProfileView, runtime]);

  useEffect(() => {
    runtime.setRigOverlayEnabled(effectiveDisplayRigOverlayEnabled);
  }, [effectiveDisplayRigOverlayEnabled, runtime]);

  useEffect(() => {
    runtime.setAnimationPlaybackPath(effectiveDisplayPlaybackPath);
  }, [effectiveDisplayPlaybackPath, runtime]);

  useEffect(() => {
    if (catalogLoadStatus !== "ready" || !selectedCharacter) {
      return;
    }

    void runtime.loadCharacter(selectedCharacter.summary);
    runtime.setState("idle");
  }, [catalogLoadStatus, runtime, selectedCharacter]);
}