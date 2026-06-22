import * as THREE from "three";
import { VRMExpression, VRMExpressionMorphTargetBind, type VRM } from "@pixiv/three-vrm";

/**
 * Runtime synthesis of a "surprised" VRM expression for models that ship
 * without one.
 *
 * Why this exists
 * ---------------
 * VRM 0.x only defines five emotion presets (neutral/joy/angry/sorrow/fun);
 * there is no "surprised". @pixiv/three-vrm maps joy->happy, sorrow->sad,
 * fun->relaxed, but `surprised` simply has no source, so the runtime's
 * surprised channel is silently dead on most imported models.
 *
 * How the recipe was derived (not guessed)
 * ----------------------------------------
 * We took the models that DO ship a real, author-baked surprised morph and
 * regressed it onto that same model's atomic morphs (non-negative least
 * squares over the per-vertex position deltas):
 *
 *   - VRoid (test-vrm-01) `Fcl_ALL_Surprised`  -> reconstruction cos-sim 0.955
 *       Fcl_EYE_Surprised 1.00, Fcl_BRW_Surprised 1.00, mouth-open ~0.9
 *   - maria `Facial_surprise` corroborates the same component SET
 *       (brows-up + jaw-open + eyes), though its stylised baked shape fits
 *       loosely (cos-sim 0.14), so it is treated as qualitative confirmation.
 *
 * The resulting semantic baseline — eyes wide (1.0) + brows raised (1.0) +
 * mouth open (moderate) — is expressed below against morph-target NAMES and
 * mapped per-model through ordered candidate groups, so it transfers across
 * naming conventions (Flare ARKit, Kohaku MMD, VRoid Fcl_, maria B_).
 *
 * Removal / revert
 * ----------------
 * This whole feature is isolated to this file plus a single guarded call site
 * in avatarRuntime.ts. Flip ENABLE_SURPRISED_SYNTHESIS to false to disable it
 * at runtime, or `git revert` the feature commit to remove it entirely.
 */

export const SURPRISED_EXPRESSION_NAME = "surprised";

/** Master switch — set to false to disable runtime surprised synthesis. */
export const ENABLE_SURPRISED_SYNTHESIS = true;

/** A single morph contribution: bind `name` at `weight` (0..1) when present. */
interface MorphBindSpec {
  name: string;
  weight: number;
}

/**
 * An ordered list of candidate groups for one facial component ("slot").
 * The first group whose PRIMARY morph (its first entry) exists on the model
 * wins; every present member of that group is then bound. Native, author-tuned
 * surprised morphs are listed first; atomic ARKit/Fcl_/B_ fallbacks follow.
 */
interface ExpressionSlot {
  id: string;
  groups: MorphBindSpec[][];
}

const SURPRISED_SLOTS: ExpressionSlot[] = [
  {
    id: "eyes",
    groups: [
      // Native combined "surprised eyes" (author-tuned -> full weight)
      [{ name: "Eye_Surprised", weight: 1.0 }],
      [{ name: "Fcl_EYE_Surprised", weight: 1.0 }],
      [{ name: "Eye_Surprised_L", weight: 1.0 }, { name: "Eye_Surprised_R", weight: 1.0 }],
      // Kohaku-style MMD rig: "eye1.open" = plain wide-open eyes (iris intact).
      // Avoid her stylized shock morphs (eye1.maru / eye1.sirome /
      // eye1.pupil_erase) — those deliberately hide or displace the iris and
      // render as blank white eyes.
      [{ name: "eye1.open", weight: 1.0 }],
      [{ name: "eye1.open_left", weight: 1.0 }, { name: "eye1.open_right", weight: 1.0 }],
      // Atomic eye-wide
      [{ name: "EyeWideLeft", weight: 1.0 }, { name: "EyeWideRight", weight: 1.0 }],
      [{ name: "B_EyeWide", weight: 1.0 }],
      [{ name: "B_EyeWide_Left", weight: 1.0 }, { name: "B_EyeWide_Right", weight: 1.0 }]
    ]
  },
  {
    id: "brows",
    groups: [
      // Native combined "surprised brows"
      [{ name: "Brow_Surprised", weight: 1.0 }],
      [{ name: "Fcl_BRW_Surprised", weight: 1.0 }],
      [{ name: "brow_surprised", weight: 1.0 }],
      [{ name: "Brow_Surprised_L", weight: 1.0 }, { name: "Brow_Surprised_R", weight: 1.0 }],
      // Atomic brow-raise (inner + outer)
      [
        { name: "BrowInnerUp", weight: 0.9 },
        { name: "BrowOuterUpLeft", weight: 0.9 },
        { name: "BrowOuterUpRight", weight: 0.9 }
      ],
      [{ name: "Brow_Up", weight: 0.9 }],
      [{ name: "Brow_Up_L", weight: 0.9 }, { name: "Brow_Up_R", weight: 0.9 }],
      [
        { name: "B_BrowInnerUp", weight: 0.9 },
        { name: "B_BrowOuterUp_Left", weight: 0.9 },
        { name: "B_BrowOuterUp_Right", weight: 0.9 }
      ],
      // Kohaku-style MMD rig: eyebrows are the "blow.*" group ("blow" == brow).
      // Her angry/sorrow presets drive blow.anger/blow.komaru, so a raised
      // brow (blow.up) is the matching surprised shape.
      [{ name: "blow.up", weight: 0.9 }],
      [{ name: "blow.upleft", weight: 0.9 }, { name: "blow.upright", weight: 0.9 }]
    ]
  },
  {
    id: "mouth",
    groups: [
      // Native combined "surprised mouth"
      [{ name: "mouth.surprise", weight: 1.0 }],
      // Atomic jaw/mouth open — moderate gape, with roundness where available.
      // ARKit JawOpen at full reads as a yawn; the regression's mouth share
      // maps to a partial open here.
      [{ name: "JawOpen", weight: 0.38 }, { name: "MouthFunnel", weight: 0.3 }],
      [{ name: "B_JawOpen", weight: 0.5 }],
      [{ name: "Fcl_MTH_O", weight: 0.6 }],
      [{ name: "mouth.o", weight: 0.6 }],
      [{ name: "mouth.o_1", weight: 0.6 }]
    ]
  }
];

/** Resolve a morph-target name to every (mesh, index) pair that carries it. */
function resolveMorphTargets(vrm: VRM, name: string): Array<{ mesh: THREE.Mesh; index: number }> {
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

export interface SurprisedSynthesisResult {
  /** True when a surprised expression was registered by this call. */
  registered: boolean;
  /** Morph-target names that were bound (empty when nothing matched). */
  boundMorphNames: string[];
  /** Reason the call was a no-op, when applicable. */
  skippedReason?: "disabled" | "no-expression-manager" | "already-present" | "no-matching-morphs";
}

/**
 * Register a synthesized "surprised" expression on `vrm` when it lacks one.
 * Idempotent and non-destructive: never touches a model that already exposes
 * surprised, and binds only morphs that genuinely exist on this model (so a
 * model with no usable morphs — e.g. a VRChat dress-up rig — is left untouched).
 */
export function synthesizeSurprisedExpression(vrm: VRM): SurprisedSynthesisResult {
  if (!ENABLE_SURPRISED_SYNTHESIS) {
    return { registered: false, boundMorphNames: [], skippedReason: "disabled" };
  }

  const expressionManager = vrm.expressionManager;

  if (!expressionManager) {
    return { registered: false, boundMorphNames: [], skippedReason: "no-expression-manager" };
  }

  if (expressionManager.getExpression(SURPRISED_EXPRESSION_NAME)) {
    return { registered: false, boundMorphNames: [], skippedReason: "already-present" };
  }

  const expression = new VRMExpression(SURPRISED_EXPRESSION_NAME);
  const boundMorphNames: string[] = [];

  for (const slot of SURPRISED_SLOTS) {
    const chosenGroup = slot.groups.find((group) => resolveMorphTargets(vrm, group[0].name).length > 0);

    if (!chosenGroup) {
      continue;
    }

    for (const spec of chosenGroup) {
      const targets = resolveMorphTargets(vrm, spec.name);

      if (targets.length === 0) {
        continue;
      }

      for (const target of targets) {
        expression.addBind(
          new VRMExpressionMorphTargetBind({
            primitives: [target.mesh],
            index: target.index,
            weight: spec.weight
          })
        );
      }

      boundMorphNames.push(spec.name);
    }
  }

  if (boundMorphNames.length === 0) {
    return { registered: false, boundMorphNames: [], skippedReason: "no-matching-morphs" };
  }

  expressionManager.registerExpression(expression);

  return { registered: true, boundMorphNames };
}
