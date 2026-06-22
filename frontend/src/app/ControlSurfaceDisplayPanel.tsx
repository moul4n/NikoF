import React from "react";
import { WardrobePanel } from "../avatar/components/WardrobePanel";
import {
  listAppearanceControlsForCharacter,
  type AppearanceControlState
} from "../avatar/runtime/appearanceController";

interface ControlSurfaceDisplayPanelProps {
  activeCharacterId: string | null;
  boneOverlayEnabled: boolean;
  captionsEnabled: boolean;
  /** Active character's persisted wardrobe values (controlId -> value). */
  wardrobe: Record<string, number>;
  onSetBoneOverlay: (enabled: boolean) => void;
  onSetCaptions: (enabled: boolean) => void;
  onSetWardrobeControl: (controlId: string, value: number) => void;
}

/**
 * Operator controls for the always-on-top display/stage window, driven over the
 * backend display-settings seam (durable across restarts). Bone overlay and
 * captions are global; wardrobe is per character. The control surface renders
 * the wardrobe controls from the character's appearance spec (no VRM needed);
 * the display surface applies the values to the avatar.
 */
export function ControlSurfaceDisplayPanel({
  activeCharacterId,
  boneOverlayEnabled,
  captionsEnabled,
  wardrobe,
  onSetBoneOverlay,
  onSetCaptions,
  onSetWardrobeControl
}: ControlSurfaceDisplayPanelProps): JSX.Element {
  const specs = activeCharacterId ? listAppearanceControlsForCharacter(activeCharacterId) : [];
  // Render spec defaults overlaid with the persisted per-character values.
  const controls: AppearanceControlState[] = specs.map((spec) => ({
    ...spec,
    value: wardrobe[spec.id] ?? spec.value
  }));

  return (
    <section className="surface-panel control-display-panel" aria-labelledby="control-display-title">
      <div className="surface-panel__header">
        <div>
          <p className="eyebrow">Avatar display</p>
          <h2 id="control-display-title">Display &amp; wardrobe</h2>
        </div>
      </div>
      <p className="surface-panel__summary">
        Controls the always-on-top display window over the backend. Bone overlay and captions are global;
        wardrobe is saved per character. All persist across restarts.
      </p>

      <div className="control-display-panel__toggles" role="group" aria-label="Global display toggles">
        <button
          type="button"
          className={
            captionsEnabled
              ? "control-display-panel__toggle control-display-panel__toggle--active"
              : "control-display-panel__toggle"
          }
          aria-pressed={captionsEnabled}
          onClick={() => onSetCaptions(!captionsEnabled)}
        >
          Captions: {captionsEnabled ? "On" : "Off"}
        </button>
        <button
          type="button"
          className={
            boneOverlayEnabled
              ? "control-display-panel__toggle control-display-panel__toggle--active"
              : "control-display-panel__toggle"
          }
          aria-pressed={boneOverlayEnabled}
          onClick={() => onSetBoneOverlay(!boneOverlayEnabled)}
        >
          Bone overlay: {boneOverlayEnabled ? "On" : "Off"}
        </button>
      </div>

      {!activeCharacterId ? (
        <p className="surface-panel__message">Select a character to edit its wardrobe.</p>
      ) : controls.length === 0 ? (
        <p className="surface-panel__message">No wardrobe controls are defined for this character.</p>
      ) : (
        <WardrobePanel
          controls={controls}
          disabled={false}
          onChange={(id, value) => onSetWardrobeControl(id, value)}
          onReset={() => specs.forEach((spec) => onSetWardrobeControl(spec.id, spec.value))}
        />
      )}
    </section>
  );
}
