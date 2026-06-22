import { useCallback, useEffect, useRef, useState } from "react";
import type { AvatarRuntimeBridge } from "../avatar/runtime/avatarRuntime";
import { listAppearanceControlsForCharacter } from "../avatar/runtime/appearanceController";
import {
  getDisplaySettings,
  updateDisplaySettings,
  type DisplaySettingsDocument,
  type DisplaySettingsUpdate
} from "../avatar/loaders/displaySettings";

const DISPLAY_SETTINGS_POLL_MS = 2500;
const WARDROBE_PUT_DEBOUNCE_MS = 250;

const DEFAULT_DOCUMENT: DisplaySettingsDocument = {
  global: { bone_overlay: false, captions: true },
  characters: {}
};

interface UseDisplaySettingsOptions {
  // When provided, the active character's persisted wardrobe values are applied
  // to this runtime. Bone overlay is NOT applied here — the avatar-runtime
  // configuration effect owns runtime.setRigOverlayEnabled, driven by
  // boneOverlayEnabled, so this hook only persists/exposes it (one owner).
  runtime?: AvatarRuntimeBridge;
  activeCharacterId?: string | null;
  // Changes when the avatar's per-character appearance controller becomes ready
  // (e.g. the runtime load state), so persisted wardrobe is re-applied after a
  // character (re)load resets the controller to defaults.
  runtimeReadyToken?: string;
}

export interface UseDisplaySettingsResult {
  document: DisplaySettingsDocument;
  boneOverlayEnabled: boolean;
  captionsEnabled: boolean;
  /** Active character's wardrobe values (controlId -> value), or {}. */
  wardrobe: Record<string, number>;
  setBoneOverlay: (enabled: boolean) => void;
  setCaptions: (enabled: boolean) => void;
  setWardrobeControl: (controlId: string, value: number) => void;
  resetWardrobe: () => void;
}

/**
 * The single source of truth for persistent display + wardrobe settings, backed
 * by the backend (durable across restarts). Polls so control-surface changes
 * reach the separate always-on-top display window. Setters update optimistically
 * and persist via PUT; with a runtime, polled state is applied to the avatar.
 */
export function useDisplaySettings(options: UseDisplaySettingsOptions = {}): UseDisplaySettingsResult {
  const { runtime, activeCharacterId = null, runtimeReadyToken = "" } = options;
  const [document, setDocument] = useState<DisplaySettingsDocument>(DEFAULT_DOCUMENT);

  // Last wardrobe applied to the runtime, so we only call the bridge on change
  // (and re-apply when the active character switches or the controller reloads).
  const appliedWardrobeKey = useRef<string | null>(null);
  const wardrobePutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Poll the backend; merge into local state (don't clobber an in-flight
  // optimistic change that hasn't round-tripped — last write wins on next poll).
  useEffect(() => {
    let cancelled = false;
    async function poll(): Promise<void> {
      const next = await getDisplaySettings();
      if (cancelled || !next) {
        return;
      }
      setDocument(next);
    }
    void poll();
    const timer = window.setInterval(() => void poll(), DISPLAY_SETTINGS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // Apply the active character's wardrobe to the runtime (display/stage). Bone
  // overlay is applied by the avatar-runtime configuration effect, not here.
  const wardrobe = activeCharacterId ? document.characters[activeCharacterId] ?? {} : {};
  useEffect(() => {
    if (!runtime) {
      return;
    }
    const key = `${activeCharacterId ?? ""}:${runtimeReadyToken}:${JSON.stringify(wardrobe)}`;
    if (appliedWardrobeKey.current !== key) {
      appliedWardrobeKey.current = key;
      for (const [controlId, value] of Object.entries(wardrobe)) {
        runtime.setAppearanceControl(controlId, value);
      }
    }
  }, [runtime, activeCharacterId, runtimeReadyToken, document, wardrobe]);

  const setBoneOverlay = useCallback((enabled: boolean) => {
    setDocument((prev) => ({ ...prev, global: { ...prev.global, bone_overlay: enabled } }));
    void updateDisplaySettings({ bone_overlay: enabled });
  }, []);

  const setCaptions = useCallback((enabled: boolean) => {
    setDocument((prev) => ({ ...prev, global: { ...prev.global, captions: enabled } }));
    void updateDisplaySettings({ captions: enabled });
  }, []);

  const setWardrobeControl = useCallback(
    (controlId: string, value: number) => {
      if (!activeCharacterId) {
        return;
      }
      setDocument((prev) => ({
        ...prev,
        characters: {
          ...prev.characters,
          [activeCharacterId]: { ...(prev.characters[activeCharacterId] ?? {}), [controlId]: value }
        }
      }));
      runtime?.setAppearanceControl(controlId, value);
      // Debounce the PUT so dragging a slider doesn't flood the backend.
      const update: DisplaySettingsUpdate = { wardrobe: { [activeCharacterId]: { [controlId]: value } } };
      if (wardrobePutTimer.current) {
        clearTimeout(wardrobePutTimer.current);
      }
      wardrobePutTimer.current = setTimeout(() => {
        void updateDisplaySettings(update);
      }, WARDROBE_PUT_DEBOUNCE_MS);
    },
    [activeCharacterId, runtime]
  );

  const resetWardrobe = useCallback(() => {
    if (!activeCharacterId) {
      return;
    }
    for (const control of listAppearanceControlsForCharacter(activeCharacterId)) {
      setWardrobeControl(control.id, control.value);
    }
  }, [activeCharacterId, setWardrobeControl]);

  return {
    document,
    boneOverlayEnabled: document.global.bone_overlay,
    captionsEnabled: document.global.captions,
    wardrobe,
    setBoneOverlay,
    setCaptions,
    setWardrobeControl,
    resetWardrobe
  };
}
