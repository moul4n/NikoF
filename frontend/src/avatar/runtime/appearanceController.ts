import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import flareAppearance from "../../../../assets/characters/flare/appearance.json";
import kohakuAppearance from "../../../../assets/characters/kohaku/appearance.json";

/**
 * Runtime "wardrobe" / appearance controller.
 *
 * Many imported VRMs bake their VRChat dress-up kit into the model as separate
 * clothing meshes and raw (non-expression) morph targets — clothing on/off,
 * breast/body size, hairstyle, etc. None of these are VRM expressions, so the
 * normal expression system never touches them, but they are fully drivable from
 * three.js via `mesh.visible` and `mesh.morphTargetInfluences`.
 *
 * This module reads a curated per-character appearance.json (friendly labels ->
 * mesh tokens / morph names) and resolves it against the loaded VRM:
 *   - toggles hide/show every mesh whose name contains a token (robust to the
 *     ".baked" suffix and primitive splitting),
 *   - sliders drive one or more exact-named morph targets to a [0..1] value.
 *
 * Controls that resolve to nothing on a given model are dropped, so the same
 * spec degrades gracefully. Isolated to this module + the appearance.json data;
 * nothing else depends on it.
 */

export const ENABLE_APPEARANCE_CONTROLS = true;

interface AppearanceToggleSpec {
  type: "toggle";
  id: string;
  label: string;
  meshMatch: string[];
  default: boolean;
}

interface AppearanceSliderSpec {
  type: "slider";
  id: string;
  label: string;
  morphs: string[];
  min: number;
  max: number;
  step?: number;
  default: number;
}

type AppearanceControlSpec = AppearanceToggleSpec | AppearanceSliderSpec;

interface AppearanceGroupSpec {
  id: string;
  label: string;
  controls: AppearanceControlSpec[];
}

interface AppearanceSpec {
  schemaVersion: number;
  characterId: string;
  groups: AppearanceGroupSpec[];
}

/** Serializable control state handed to the snapshot / UI. */
export interface AppearanceControlState {
  id: string;
  groupId: string;
  groupLabel: string;
  label: string;
  type: "toggle" | "slider";
  value: number;
  min: number;
  max: number;
  step: number;
}

export interface AppearanceController {
  getControls(): AppearanceControlState[];
  setControl(id: string, value: number): void;
  reset(): void;
  dispose(): void;
}

const APPEARANCE_SPECS: Partial<Record<string, AppearanceSpec>> = {
  flare: flareAppearance as AppearanceSpec,
  kohaku: kohakuAppearance as AppearanceSpec
};

interface ResolvedToggle {
  kind: "toggle";
  meshes: THREE.Mesh[];
}

interface ResolvedSlider {
  kind: "slider";
  targets: Array<{ mesh: THREE.Mesh; index: number }>;
}

interface ResolvedControl {
  state: AppearanceControlState;
  defaultValue: number;
  target: ResolvedToggle | ResolvedSlider;
}

function findMeshesByToken(vrm: VRM, tokens: string[]): THREE.Mesh[] {
  const lowered = tokens.map((token) => token.toLowerCase());
  const meshes: THREE.Mesh[] = [];

  vrm.scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) {
      return;
    }
    const name = mesh.name.toLowerCase();
    if (lowered.some((token) => name.includes(token))) {
      meshes.push(mesh);
    }
  });

  return meshes;
}

function findMorphTargets(vrm: VRM, name: string): Array<{ mesh: THREE.Mesh; index: number }> {
  const hits: Array<{ mesh: THREE.Mesh; index: number }> = [];

  vrm.scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    const dictionary = mesh.morphTargetDictionary;
    if (!mesh.isMesh || !dictionary) {
      return;
    }
    const index = dictionary[name];
    if (typeof index === "number") {
      hits.push({ mesh, index });
    }
  });

  return hits;
}

export function createAppearanceController(vrm: VRM, characterId: string): AppearanceController {
  const resolved: ResolvedControl[] = [];

  const spec = ENABLE_APPEARANCE_CONTROLS ? APPEARANCE_SPECS[characterId] : undefined;

  if (spec) {
    for (const group of spec.groups) {
      for (const control of group.controls) {
        if (control.type === "toggle") {
          const meshes = findMeshesByToken(vrm, control.meshMatch);
          if (meshes.length === 0) {
            continue;
          }
          const value = control.default ? 1 : 0;
          resolved.push({
            defaultValue: value,
            target: { kind: "toggle", meshes },
            state: {
              id: control.id,
              groupId: group.id,
              groupLabel: group.label,
              label: control.label,
              type: "toggle",
              value,
              min: 0,
              max: 1,
              step: 1
            }
          });
        } else {
          const targets = control.morphs.flatMap((morph) => findMorphTargets(vrm, morph));
          if (targets.length === 0) {
            continue;
          }
          resolved.push({
            defaultValue: control.default,
            target: { kind: "slider", targets },
            state: {
              id: control.id,
              groupId: group.id,
              groupLabel: group.label,
              label: control.label,
              type: "slider",
              value: control.default,
              min: control.min,
              max: control.max,
              step: control.step ?? 0.01
            }
          });
        }
      }
    }
  }

  const byId = new Map(resolved.map((control) => [control.state.id, control]));

  function apply(control: ResolvedControl): void {
    if (control.target.kind === "toggle") {
      const visible = control.state.value >= 0.5;
      for (const mesh of control.target.meshes) {
        mesh.visible = visible;
      }
    } else {
      const weight = THREE.MathUtils.clamp(control.state.value, 0, 1);
      for (const target of control.target.targets) {
        if (target.mesh.morphTargetInfluences) {
          target.mesh.morphTargetInfluences[target.index] = weight;
        }
      }
    }
  }

  // Apply declared defaults immediately so the model matches the panel state.
  for (const control of resolved) {
    apply(control);
  }

  return {
    getControls(): AppearanceControlState[] {
      return resolved.map((control) => ({ ...control.state }));
    },
    setControl(id: string, value: number): void {
      const control = byId.get(id);
      if (!control) {
        return;
      }
      control.state.value = control.target.kind === "toggle" ? (value >= 0.5 ? 1 : 0) : value;
      apply(control);
    },
    reset(): void {
      for (const control of resolved) {
        control.state.value = control.defaultValue;
        apply(control);
      }
    },
    dispose(): void {
      // Restore declared defaults so a re-used VRM / next character is clean.
      for (const control of resolved) {
        control.state.value = control.defaultValue;
        apply(control);
      }
    }
  };
}
