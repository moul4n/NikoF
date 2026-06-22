import * as THREE from "three";

/**
 * Stage background presets for the display / Tauri stage window.
 *
 * - "plain"       : an opaque solid colour (the default).
 * - "transparent" : no scene background — the canvas renders with alpha so the
 *                   page (and, when the Tauri window is transparent, the desktop)
 *                   shows through. The basis for a floating desktop avatar.
 * - "scene"       : reserved for future rich backdrops (gradient skybox, image
 *                   plane, full 3D environment). Register them in STAGE_BACKGROUND_PRESETS.
 */
export type StageBackgroundKind = "plain" | "transparent" | "scene";

export interface StageBackgroundPreset {
  id: string;
  label: string;
  kind: StageBackgroundKind;
  /** Solid colour for the "plain" kind. */
  color?: string;
}

export const DEFAULT_STAGE_BACKGROUND_COLOR = "#09111a";

export const STAGE_BACKGROUND_PRESETS: StageBackgroundPreset[] = [
  { id: "plain", label: "Plain", kind: "plain", color: DEFAULT_STAGE_BACKGROUND_COLOR },
  { id: "transparent", label: "Transparent", kind: "transparent" },
  // Future scenes slot in here, e.g.:
  // { id: "studio", label: "Studio", kind: "scene" },
];

export const DEFAULT_STAGE_BACKGROUND_ID = "plain";

export function isKnownStageBackgroundId(id: string): boolean {
  return STAGE_BACKGROUND_PRESETS.some((preset) => preset.id === id);
}

export function getStageBackgroundPreset(id: string): StageBackgroundPreset {
  return STAGE_BACKGROUND_PRESETS.find((preset) => preset.id === id) ?? STAGE_BACKGROUND_PRESETS[0];
}

/** Apply a background preset to the live scene + renderer. */
export function applyStageBackground(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  backgroundId: string
): void {
  const preset = getStageBackgroundPreset(backgroundId);

  switch (preset.kind) {
    case "transparent": {
      scene.background = null;
      // alpha 0 clear so the canvas is see-through where nothing is drawn.
      renderer.setClearColor(0x000000, 0);
      break;
    }
    case "scene":
      // Future rich backdrops will set scene.background / scene.environment here.
      // Until a preset implements it, fall through to a plain fill.
    case "plain":
    default: {
      const color = new THREE.Color(preset.color ?? DEFAULT_STAGE_BACKGROUND_COLOR);
      scene.background = color;
      renderer.setClearColor(color, 1);
      break;
    }
  }
}
