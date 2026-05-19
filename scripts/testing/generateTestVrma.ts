/**
 * Generate a minimal valid VRMA test file for verifying the frontend VRMA pipeline.
 * This creates a simple .glb with VRMC_vrm_animation extension containing
 * a basic idle-like breathing animation (subtle spine rotations).
 *
 * Usage: npx tsx scripts/testing/generateTestVrma.ts
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const FRAME_RATE = 30;
const DURATION_S = 4.0; // 4 second loop
const FRAME_COUNT = Math.round(DURATION_S * FRAME_RATE) + 1;

// VRM humanoid bones we'll include (minimal set for a valid VRMA)
const BONES = [
  "hips", "spine", "chest", "upperChest", "neck", "head",
  "leftShoulder", "leftUpperArm", "leftLowerArm", "leftHand",
  "rightShoulder", "rightUpperArm", "rightLowerArm", "rightHand",
  "leftUpperLeg", "leftLowerLeg", "leftFoot", "leftToes",
  "rightUpperLeg", "rightLowerLeg", "rightFoot", "rightToes",
] as const;

const BONE_COUNT = BONES.length;

// Parent indices (-1 = root)
const PARENTS = [
  -1, 0, 1, 2, 3, 4,  // hips->head chain
  3, 6, 7, 8,          // left arm (leftShoulder parent = upperChest index 3)
  3, 10, 11, 12,       // right arm
  0, 14, 15, 16,       // left leg
  0, 18, 19, 20,       // right leg
];

// Rest pose rotations (slight natural curvature) - stored as [x, y, z, w]
// These encode the natural posture in the animation skeleton
const REST_ROTATIONS: [number, number, number, number][] = [
  [0.035, 0, 0, 0.999],     // hips: ~4° forward
  [0.026, 0, 0, 0.999],     // spine: ~3° forward
  [0.022, 0, 0, 0.999],     // chest: ~2.5° forward
  [0.013, 0, 0, 0.999],     // upperChest: ~1.5° forward
  [0.026, 0, 0, 0.999],     // neck: ~3° forward
  [-0.017, 0, 0, 0.999],    // head: ~2° backward
  [0, 0, 0.026, 0.999],     // leftShoulder: ~3° Z
  [0, 0, 0, 1],             // leftUpperArm
  [0, 0, 0, 1],             // leftLowerArm
  [0, 0, 0, 1],             // leftHand
  [0, 0, -0.026, 0.999],    // rightShoulder: ~-3° Z
  [0, 0, 0, 1],             // rightUpperArm
  [0, 0, 0, 1],             // rightLowerArm
  [0, 0, 0, 1],             // rightHand
  [0, 0, 0, 1],             // leftUpperLeg
  [0, 0, 0, 1],             // leftLowerLeg
  [0, 0, 0, 1],             // leftFoot
  [0, 0, 0, 1],             // leftToes
  [0, 0, 0, 1],             // rightUpperLeg
  [0, 0, 0, 1],             // rightLowerLeg
  [0, 0, 0, 1],             // rightFoot
  [0, 0, 0, 1],             // rightToes
];

function generateBreathingAnimation(): {
  times: Float32Array;
  hipsTranslation: Float32Array;
  boneRotations: Float32Array[];
} {
  const times = new Float32Array(FRAME_COUNT);
  const hipsTranslation = new Float32Array(FRAME_COUNT * 3);
  const boneRotations: Float32Array[] = [];

  for (let b = 0; b < BONE_COUNT; b++) {
    boneRotations.push(new Float32Array(FRAME_COUNT * 4));
  }

  for (let f = 0; f < FRAME_COUNT; f++) {
    const t = f / FRAME_RATE;
    times[f] = t;

    // Breathing cycle: visible up/down on hips
    const breathPhase = (Math.sin((2 * Math.PI * t) / DURATION_S) + 1) / 2; // 0-1
    const breathHeight = breathPhase * 0.03; // 3cm vertical motion (was 5mm)

    hipsTranslation[f * 3 + 0] = 0;          // x
    hipsTranslation[f * 3 + 1] = 1.0 + breathHeight; // y (base hips height + breath)
    hipsTranslation[f * 3 + 2] = 0;          // z

    for (let b = 0; b < BONE_COUNT; b++) {
      const [rx, ry, rz, rw] = REST_ROTATIONS[b];

      let extraX = 0;
      let extraZ = 0;

      // Spine chain: visible forward/back sway with breath
      if (b >= 1 && b <= 3) {
        extraX = breathPhase * 0.06; // ~3.5° per spine bone (was 0.5°)
      }

      // Head: noticeable nod
      if (b === 5) {
        extraX = Math.sin((2 * Math.PI * t) / (DURATION_S * 1.5)) * 0.05; // ~3°
      }

      // Arms: gentle swing
      if (b === 7) { // leftUpperArm
        extraZ = Math.sin((2 * Math.PI * t) / DURATION_S) * 0.08; // ~4.5°
      }
      if (b === 11) { // rightUpperArm
        extraZ = -Math.sin((2 * Math.PI * t) / DURATION_S) * 0.08; // ~4.5° opposite
      }

      // Combine rest rotation with animation delta
      boneRotations[b][f * 4 + 0] = rx + extraX;
      boneRotations[b][f * 4 + 1] = ry;
      boneRotations[b][f * 4 + 2] = rz + extraZ;
      boneRotations[b][f * 4 + 3] = rw;

      // Normalize quaternion
      const len = Math.sqrt(
        boneRotations[b][f * 4 + 0] ** 2 +
        boneRotations[b][f * 4 + 1] ** 2 +
        boneRotations[b][f * 4 + 2] ** 2 +
        boneRotations[b][f * 4 + 3] ** 2
      );
      if (len > 0) {
        boneRotations[b][f * 4 + 0] /= len;
        boneRotations[b][f * 4 + 1] /= len;
        boneRotations[b][f * 4 + 2] /= len;
        boneRotations[b][f * 4 + 3] /= len;
      }
    }
  }

  return { times, hipsTranslation, boneRotations };
}

function buildGlb(): Buffer {
  const { times, hipsTranslation, boneRotations } = generateBreathingAnimation();

  // === Binary buffer ===
  const timesBytes = FRAME_COUNT * 4;
  const hipsTransBytes = FRAME_COUNT * 12;
  const rotBytesPerBone = FRAME_COUNT * 16;
  const totalBufferSize = timesBytes + hipsTransBytes + (BONE_COUNT * rotBytesPerBone);

  const binBuffer = Buffer.alloc(totalBufferSize);
  let offset = 0;

  // Times
  const timesOffset = offset;
  for (let i = 0; i < FRAME_COUNT; i++) {
    binBuffer.writeFloatLE(times[i], offset);
    offset += 4;
  }

  // Hips translation
  const hipsTransOffset = offset;
  for (let i = 0; i < FRAME_COUNT * 3; i++) {
    binBuffer.writeFloatLE(hipsTranslation[i], offset);
    offset += 4;
  }

  // Bone rotations
  const boneRotOffsets: number[] = [];
  for (let b = 0; b < BONE_COUNT; b++) {
    boneRotOffsets.push(offset);
    for (let i = 0; i < FRAME_COUNT * 4; i++) {
      binBuffer.writeFloatLE(boneRotations[b][i], offset);
      offset += 4;
    }
  }

  // === glTF JSON ===

  // Nodes: virtual root + bones
  const nodes: any[] = [];

  // Virtual root node (index 0)
  const rootChildren: number[] = [];
  for (let b = 0; b < BONE_COUNT; b++) {
    if (PARENTS[b] === -1) rootChildren.push(b + 1);
  }
  nodes.push({ name: "VrmaRoot", children: rootChildren });

  // Bone nodes
  for (let b = 0; b < BONE_COUNT; b++) {
    const children: number[] = [];
    for (let c = 0; c < BONE_COUNT; c++) {
      if (PARENTS[c] === b) children.push(c + 1);
    }
    const node: any = {
      name: BONES[b],
      rotation: REST_ROTATIONS[b],
    };
    // Hips node (index 0) needs a rest translation so the library
    // can properly retarget the position track (avoids division by zero)
    if (b === 0) {
      node.translation = [0, 1.0, 0];
    }
    if (children.length > 0) node.children = children;
    nodes.push(node);
  }

  // Buffer views
  const bufferViews: any[] = [];
  bufferViews.push({ buffer: 0, byteOffset: timesOffset, byteLength: timesBytes });
  bufferViews.push({ buffer: 0, byteOffset: hipsTransOffset, byteLength: hipsTransBytes });
  for (let b = 0; b < BONE_COUNT; b++) {
    bufferViews.push({ buffer: 0, byteOffset: boneRotOffsets[b], byteLength: rotBytesPerBone });
  }

  // Accessors
  const accessors: any[] = [];
  accessors.push({
    bufferView: 0,
    componentType: 5126,
    count: FRAME_COUNT,
    type: "SCALAR",
    min: [0],
    max: [DURATION_S],
  });
  accessors.push({
    bufferView: 1,
    componentType: 5126,
    count: FRAME_COUNT,
    type: "VEC3",
  });
  for (let b = 0; b < BONE_COUNT; b++) {
    accessors.push({
      bufferView: 2 + b,
      componentType: 5126,
      count: FRAME_COUNT,
      type: "VEC4",
    });
  }

  // Animation channels and samplers
  const channels: any[] = [];
  const samplers: any[] = [];

  // Hips translation
  samplers.push({ input: 0, output: 1, interpolation: "LINEAR" });
  channels.push({ sampler: 0, target: { node: 1, path: "translation" } });

  // Bone rotations
  for (let b = 0; b < BONE_COUNT; b++) {
    samplers.push({ input: 0, output: 2 + b, interpolation: "LINEAR" });
    channels.push({ sampler: 1 + b, target: { node: b + 1, path: "rotation" } });
  }

  // VRMC_vrm_animation extension
  const humanBones: Record<string, { node: number }> = {};
  for (let b = 0; b < BONE_COUNT; b++) {
    humanBones[BONES[b]] = { node: b + 1 };
  }

  const gltfJson = {
    asset: { version: "2.0", generator: "NikoF Test VRMA Generator" },
    extensionsUsed: ["VRMC_vrm_animation"],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    buffers: [{ byteLength: totalBufferSize }],
    bufferViews,
    accessors,
    animations: [{
      name: "idle.default",
      channels,
      samplers,
    }],
    extensions: {
      VRMC_vrm_animation: {
        specVersion: "1.0",
        humanoid: { humanBones },
      },
    },
  };

  // Serialize JSON
  const jsonString = JSON.stringify(gltfJson);
  const jsonBuffer = Buffer.from(jsonString, "utf8");

  // Pad JSON to 4-byte alignment
  const jsonPadding = (4 - (jsonBuffer.length % 4)) % 4;
  const jsonChunkLength = jsonBuffer.length + jsonPadding;

  // Pad binary to 4-byte alignment
  const binPadding = (4 - (binBuffer.length % 4)) % 4;
  const binChunkLength = binBuffer.length + binPadding;

  // GLB: 12-byte header + JSON chunk (8+data) + BIN chunk (8+data)
  const totalLength = 12 + 8 + jsonChunkLength + 8 + binChunkLength;
  const glb = Buffer.alloc(totalLength);
  let glbOffset = 0;

  // Header
  glb.writeUInt32LE(0x46546C67, glbOffset); glbOffset += 4; // "glTF"
  glb.writeUInt32LE(2, glbOffset); glbOffset += 4;           // version
  glb.writeUInt32LE(totalLength, glbOffset); glbOffset += 4;

  // JSON chunk
  glb.writeUInt32LE(jsonChunkLength, glbOffset); glbOffset += 4;
  glb.writeUInt32LE(0x4E4F534A, glbOffset); glbOffset += 4; // "JSON"
  jsonBuffer.copy(glb, glbOffset); glbOffset += jsonBuffer.length;
  for (let i = 0; i < jsonPadding; i++) { glb[glbOffset++] = 0x20; } // space padding

  // BIN chunk
  glb.writeUInt32LE(binChunkLength, glbOffset); glbOffset += 4;
  glb.writeUInt32LE(0x004E4942, glbOffset); glbOffset += 4; // "BIN\0"
  binBuffer.copy(glb, glbOffset); glbOffset += binBuffer.length;
  for (let i = 0; i < binPadding; i++) { glb[glbOffset++] = 0x00; }

  return glb;
}

// Generate and write
const outputDir = resolve(__dirname, "../../assets/animations/library/shared");
mkdirSync(outputDir, { recursive: true });

const outputPath = resolve(outputDir, "idle.default.vrma");
const glb = buildGlb();
writeFileSync(outputPath, glb);

console.log(`Generated test VRMA: ${outputPath} (${glb.length} bytes, ${FRAME_COUNT} frames @ ${FRAME_RATE}fps)`);
