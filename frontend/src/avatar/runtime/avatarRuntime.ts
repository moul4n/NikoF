import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMHumanBoneName, VRMLoaderPlugin, type VRM } from "@pixiv/three-vrm";
import type {
  SemanticAnimationCommand,
  SemanticAnimationRuntimePayload
} from "../../shared/types/animation";
import type {
  BackendSpeechVisemeSlotDocument,
  CharacterId,
  CharacterManifestSummary,
  CharacterRuntimeState
} from "../../shared/types/character";
import { resolveSharedSemanticAnimationPayload, DEFAULT_BASE_ANIMATION_COMMAND } from "./defaultBaseAnimation";
import {
  type HumanoidChannelPlayback,
  type HumanoidChannelPlaybackDebugPoseSnapshot
} from "./humanoidChannelPlayback";
import {
  isIdleSemanticAnimationPayload,
  resolveAvatarRuntimePlayback,
  type AvatarRuntimeResolvedPlayback
} from "./avatarRuntimePlaybackRoute";
import { createVrmaPlayback, type VrmaPlaybackBridge } from "./vrmaPlayback";
import { resolveVrmaAssetCandidates } from "./vrmaAssetResolution";
import type { AvatarRuntimeMountPoints } from "./mountPoints";
import { createPassiveBlinkController, type PassiveBlinkController } from "./passiveBlink";
import { createPassiveMouthController, type PassiveMouthController } from "./passiveMouth";
import { createPassiveEyeDriftController, type PassiveEyeDriftController } from "./passiveEyeDrift";
import {
  createPassiveEmotionController,
  type PassiveEmotionController,
  type PassiveEmotionName
} from "./passiveEmotion";

type AvatarRuntimeLoadState = "idle" | "loading" | "ready" | "error";
type AvatarSpeechReactionMode = "idle" | "coarse" | "viseme";
type AvatarOverlayChannelId = "speech";
type AvatarOverlaySource = "backend.speech.lifecycle";
export type AvatarAnimationPlaybackPath = "mixer" | "feetAnchored" | "vrma";
export type AvatarRuntimeEmotionName = PassiveEmotionName;
type VRMHumanBoneNameValue = (typeof VRMHumanBoneName)[keyof typeof VRMHumanBoneName];

type AvatarRuntimeListener = () => void;

const VRM_MOUTH_EXPRESSION_NAMES = ["aa", "ih", "ou", "ee", "oh"] as const;
const VRM_MOUTH_EXPRESSION_NAME_SET = new Set<string>(VRM_MOUTH_EXPRESSION_NAMES);
const VRM_MOUTH_EXPRESSION_ALIASES: Record<string, (typeof VRM_MOUTH_EXPRESSION_NAMES)[number]> = {
  a: "aa",
  aa: "aa",
  i: "ih",
  ih: "ih",
  u: "ou",
  ou: "ou",
  e: "ee",
  ee: "ee",
  o: "oh",
  oh: "oh"
};

interface AvatarSpeechReactionViseme {
  expressionName: string;
  label: string;
  startMs: number;
  endMs: number;
}

export interface AvatarOverlayChannelSnapshot {
  channelId: AvatarOverlayChannelId;
  active: boolean;
  mode: AvatarSpeechReactionMode;
  source: AvatarOverlaySource | null;
  label: string | null;
}

export interface AvatarSpeechReactionInput {
  utteranceDurationMs: number | null;
  visemeSlots?: BackendSpeechVisemeSlotDocument[] | null;
}

export type AvatarDebugProfileView = "front" | "side";

interface LoadedAvatar {
  anchorRoot: THREE.Object3D;
  anchorBaselineQuaternion: THREE.Quaternion;
  frontProfileQuaternion: THREE.Quaternion;
  root: THREE.Object3D;
  vrm: VRM | null;
}

interface RigOverlaySegmentDefinition {
  startBoneName: VRMHumanBoneNameValue;
  endBoneName: VRMHumanBoneNameValue;
  color: number;
}

interface RigOverlaySegment {
  startNode: THREE.Object3D;
  endNode: THREE.Object3D;
  color: THREE.Color;
}

interface RigOverlayJoint {
  boneName: VRMHumanBoneNameValue;
  node: THREE.Object3D;
  color: THREE.Color;
  markerRoot: THREE.Group;
}

interface RigOverlayState {
  avatarRoot: THREE.Object3D;
  root: THREE.Group;
  lineGeometry: THREE.BufferGeometry;
  lineMaterial: THREE.LineBasicMaterial;
  linePositionAttribute: THREE.BufferAttribute;
  lineColorAttribute: THREE.BufferAttribute;
  jointGeometry: THREE.BufferGeometry;
  jointMaterial: THREE.PointsMaterial;
  jointPositionAttribute: THREE.BufferAttribute;
  jointColorAttribute: THREE.BufferAttribute;
  markerGeometry: THREE.BufferGeometry;
  markerMaterials: [THREE.LineBasicMaterial, THREE.LineBasicMaterial, THREE.LineBasicMaterial];
  segments: RigOverlaySegment[];
  joints: RigOverlayJoint[];
}

interface ActiveBaseAnimationState {
  command: SemanticAnimationCommand;
  payload: SemanticAnimationRuntimePayload;
  playbackPath: AvatarAnimationPlaybackPath;
  root: THREE.Object3D;
  baselinePosition: THREE.Vector3;
  baselineQuaternion: THREE.Quaternion;
  humanoidPlayback: HumanoidChannelPlayback | null;
  elapsedSeconds: number;
}

interface AvatarHumanoidPlaybackDebugSnapshot {
  activeAnimationId: string | null;
  hasActiveBaseAnimation: boolean;
  hasHumanoidPlayback: boolean;
  playbackPath: AvatarAnimationPlaybackPath | null;
  channelSpace: string | null;
  elapsedSeconds: number | null;
  currentPose: HumanoidChannelPlaybackDebugPoseSnapshot | null;
  finalFramePose: HumanoidChannelPlaybackDebugPoseSnapshot | null;
  boundChannels: Array<{
    channelName: string;
    normalizedName: string;
    boneName: string;
    axis: "x" | "y" | "z";
    scale: number;
    sampledDelta: number | null;
  }>;
  quaternionBoundChannels: Array<{
    normalizedNamePrefix: string;
    boneName: string;
    sampledRotation: [number, number, number, number] | null;
  }>;
  targetedBones: string[];
}

interface AvatarProfileOrientationSnapshot {
  selectedProfileView: AvatarDebugProfileView;
  rootForward: [number, number, number] | null;
  humanoidForward: [number, number, number] | null;
  baselineForward: [number, number, number] | null;
  appliedForward: [number, number, number] | null;
  expectedForward: [number, number, number];
  baselineYawDegrees: number | null;
  appliedYawDegrees: number | null;
  expectedYawDegrees: number;
  yawErrorDegrees: number | null;
  anchorQuaternion: [number, number, number, number] | null;
  expectedAnchorQuaternion: [number, number, number, number] | null;
  anchorAngularErrorDegrees: number | null;
}

interface AvatarRuntimeDebugApi {
  getProfileOrientationSnapshot: () => AvatarProfileOrientationSnapshot | null;
  getHumanoidPlayback: () => AvatarHumanoidPlaybackDebugSnapshot;
}

type ResolvedAnimationPlayback = AvatarRuntimeResolvedPlayback;

declare global {
  interface Window {
    __NIKOF_AVATAR_DEBUG__?: AvatarRuntimeDebugApi;
  }
}

export interface AvatarRuntimeSnapshot {
  mounted: boolean;
  currentCharacterId: CharacterId | null;
  currentState: CharacterRuntimeState;
  mountPoints: AvatarRuntimeMountPoints | null;
  pendingAnimation: SemanticAnimationCommand | null;
  baseAnimation: SemanticAnimationCommand | null;
  currentModelUrl: string | null;
  loadState: AvatarRuntimeLoadState;
  activeEmotion: AvatarRuntimeEmotionName | null;
  speechReactionMode: AvatarSpeechReactionMode;
  activeViseme: string | null;
  overlayChannels: AvatarOverlayChannelSnapshot[];
  error: string | null;
}

export interface AvatarRuntimeBridge {
  mount: (mountPoints: AvatarRuntimeMountPoints) => void;
  unmount: () => void;
  loadCharacter: (character: CharacterManifestSummary) => Promise<void>;
  setState: (state: CharacterRuntimeState) => void;
  setDebugProfileView: (profileView: AvatarDebugProfileView) => void;
  setRigOverlayEnabled: (enabled: boolean) => void;
  setAnimationPlaybackPath: (playbackPath: AvatarAnimationPlaybackPath) => void;
  setEmotion: (emotion: AvatarRuntimeEmotionName | null) => void;
  beginSpeechReaction: (input: AvatarSpeechReactionInput) => void;
  clearSpeechReaction: () => void;
  play: (command: SemanticAnimationCommand | null) => void;
  subscribe: (listener: AvatarRuntimeListener) => () => void;
  snapshot: () => AvatarRuntimeSnapshot;
}

const RIG_OVERLAY_SEGMENTS = [
  { startBoneName: VRMHumanBoneName.Hips, endBoneName: VRMHumanBoneName.Spine, color: 0x72d6c9 },
  { startBoneName: VRMHumanBoneName.Spine, endBoneName: VRMHumanBoneName.Chest, color: 0x72d6c9 },
  { startBoneName: VRMHumanBoneName.Chest, endBoneName: VRMHumanBoneName.UpperChest, color: 0x72d6c9 },
  { startBoneName: VRMHumanBoneName.UpperChest, endBoneName: VRMHumanBoneName.Neck, color: 0x72d6c9 },
  { startBoneName: VRMHumanBoneName.Neck, endBoneName: VRMHumanBoneName.Head, color: 0x72d6c9 },
  { startBoneName: VRMHumanBoneName.UpperChest, endBoneName: VRMHumanBoneName.LeftShoulder, color: 0xff8a65 },
  { startBoneName: VRMHumanBoneName.LeftShoulder, endBoneName: VRMHumanBoneName.LeftUpperArm, color: 0xff8a65 },
  { startBoneName: VRMHumanBoneName.LeftUpperArm, endBoneName: VRMHumanBoneName.LeftLowerArm, color: 0xff8a65 },
  { startBoneName: VRMHumanBoneName.LeftLowerArm, endBoneName: VRMHumanBoneName.LeftHand, color: 0xff8a65 },
  { startBoneName: VRMHumanBoneName.UpperChest, endBoneName: VRMHumanBoneName.RightShoulder, color: 0x5aa9ff },
  { startBoneName: VRMHumanBoneName.RightShoulder, endBoneName: VRMHumanBoneName.RightUpperArm, color: 0x5aa9ff },
  { startBoneName: VRMHumanBoneName.RightUpperArm, endBoneName: VRMHumanBoneName.RightLowerArm, color: 0x5aa9ff },
  { startBoneName: VRMHumanBoneName.RightLowerArm, endBoneName: VRMHumanBoneName.RightHand, color: 0x5aa9ff },
  { startBoneName: VRMHumanBoneName.Hips, endBoneName: VRMHumanBoneName.LeftUpperLeg, color: 0xa2e05a },
  { startBoneName: VRMHumanBoneName.LeftUpperLeg, endBoneName: VRMHumanBoneName.LeftLowerLeg, color: 0xa2e05a },
  { startBoneName: VRMHumanBoneName.LeftLowerLeg, endBoneName: VRMHumanBoneName.LeftFoot, color: 0xa2e05a },
  { startBoneName: VRMHumanBoneName.LeftFoot, endBoneName: VRMHumanBoneName.LeftToes, color: 0xa2e05a },
  { startBoneName: VRMHumanBoneName.Hips, endBoneName: VRMHumanBoneName.RightUpperLeg, color: 0xf1d35b },
  { startBoneName: VRMHumanBoneName.RightUpperLeg, endBoneName: VRMHumanBoneName.RightLowerLeg, color: 0xf1d35b },
  { startBoneName: VRMHumanBoneName.RightLowerLeg, endBoneName: VRMHumanBoneName.RightFoot, color: 0xf1d35b },
  { startBoneName: VRMHumanBoneName.RightFoot, endBoneName: VRMHumanBoneName.RightToes, color: 0xf1d35b }
] as const satisfies readonly RigOverlaySegmentDefinition[];

const FLOOR_GROUNDING_BONE_NAMES = [
  VRMHumanBoneName.LeftFoot,
  VRMHumanBoneName.RightFoot,
  VRMHumanBoneName.LeftToes,
  VRMHumanBoneName.RightToes
] as const satisfies readonly VRMHumanBoneNameValue[];
const FLOOR_GROUNDING_FOOT_BONE_NAMES = [
  VRMHumanBoneName.LeftFoot,
  VRMHumanBoneName.RightFoot
] as const satisfies readonly VRMHumanBoneNameValue[];

export function createAvatarRuntime(): AvatarRuntimeBridge {
  function resolveFinalFrameElapsedSeconds(payload: SemanticAnimationRuntimePayload): number {
    const lastSampleTime = payload.sampling?.timesS[payload.sampling.timesS.length - 1];

    if (typeof lastSampleTime === "number" && Number.isFinite(lastSampleTime) && lastSampleTime >= 0) {
      return lastSampleTime;
    }

    return Math.max(payload.durationMs / 1000, 0);
  }

  function roundComparisonNumber(value: number): number {
    return Number(value.toFixed(6));
  }

  function roundQuaternion(
    rotation: [number, number, number, number]
  ): [number, number, number, number] {
    return rotation.map((value) => roundComparisonNumber(value)) as [number, number, number, number];
  }

  function createSpeechOverlayChannel(
    values: Partial<AvatarOverlayChannelSnapshot> = {}
  ): AvatarOverlayChannelSnapshot {
    const nextChannel: AvatarOverlayChannelSnapshot = {
      channelId: "speech",
      active: false,
      mode: "idle",
      source: null,
      label: null,
      ...values
    };

    if (nextChannel.mode === "idle") {
      return {
        channelId: "speech",
        active: false,
        mode: "idle",
        source: null,
        label: null
      };
    }

    return {
      ...nextChannel,
      active: true,
      source: nextChannel.source ?? "backend.speech.lifecycle"
    };
  }

  let snapshot: AvatarRuntimeSnapshot = {
    mounted: false,
    currentCharacterId: null,
    currentState: "idle",
    mountPoints: null,
    pendingAnimation: null,
    baseAnimation: null,
    currentModelUrl: null,
    loadState: "idle",
    activeEmotion: null,
    speechReactionMode: "idle",
    activeViseme: null,
    overlayChannels: [createSpeechOverlayChannel()],
    error: null
  };
  let currentCharacter: CharacterManifestSummary | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let orbitControls: OrbitControls | null = null;
  let viewportElement: HTMLElement | null = null;
  let animationFrameId: number | null = null;
  let currentAvatar: LoadedAvatar | null = null;
  let activeBaseAnimation: ActiveBaseAnimationState | null = null;
  let debugProfileView: AvatarDebugProfileView = "front";
  let rigOverlayEnabled = false;
  let rigOverlayState: RigOverlayState | null = null;
  let animationPlaybackPath: AvatarAnimationPlaybackPath = "mixer";
  let vrmaPlayback: VrmaPlaybackBridge | null = null;
  let passiveBlink: PassiveBlinkController | null = null;
  let passiveMouth: PassiveMouthController | null = null;
  let passiveEyeDrift: PassiveEyeDriftController | null = null;
  let passiveEmotion: PassiveEmotionController | null = null;
  let activeLoadRequestId = 0;
  let activeLoadTargetKey: string | null = null;
  let activeLoadPromise: Promise<void> | null = null;
  let speechReactionTimeoutIds: number[] = [];
  let activeSpeechExpressionName: string | null = null;
  const listeners = new Set<AvatarRuntimeListener>();
  const clock = new THREE.Clock();
  const debugFrontProfileTargetForward = new THREE.Vector3(0, 0, 1);
  const debugSideProfileYawOffsetQuaternion = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    Math.PI / 2
  );

  function roundVector3(vector: THREE.Vector3): [number, number, number] {
    return [roundComparisonNumber(vector.x), roundComparisonNumber(vector.y), roundComparisonNumber(vector.z)];
  }

  function roundQuaternionValues(quaternion: THREE.Quaternion): [number, number, number, number] {
    return roundQuaternion([quaternion.x, quaternion.y, quaternion.z, quaternion.w]);
  }

  function resolveForwardYawDegrees(forward: THREE.Vector3 | null): number | null {
    if (!forward || forward.lengthSq() <= 1e-6) {
      return null;
    }

    return roundComparisonNumber(THREE.MathUtils.radToDeg(Math.atan2(forward.x, forward.z)));
  }

  function normalizeYawDegrees(degrees: number): number {
    const normalizedDegrees = ((degrees + 180) % 360 + 360) % 360 - 180;
    return roundComparisonNumber(normalizedDegrees === -180 ? 180 : normalizedDegrees);
  }

  function resolveYawErrorDegrees(actualDegrees: number | null, expectedDegrees: number): number | null {
    if (actualDegrees === null) {
      return null;
    }

    return normalizeYawDegrees(actualDegrees - expectedDegrees);
  }

  function resolveExpectedProfileQuaternion(avatar: LoadedAvatar): THREE.Quaternion {
    const expectedQuaternion = avatar.frontProfileQuaternion.clone();

    if (debugProfileView === "side") {
      expectedQuaternion.multiply(debugSideProfileYawOffsetQuaternion);
    }

    return expectedQuaternion.normalize();
  }

  function resolveExpectedProfileForward(): THREE.Vector3 {
    const expectedForward = debugFrontProfileTargetForward.clone();

    if (debugProfileView === "side") {
      expectedForward.applyQuaternion(debugSideProfileYawOffsetQuaternion);
    }

    return expectedForward.normalize();
  }

  function getProfileOrientationSnapshot(): AvatarProfileOrientationSnapshot | null {
    if (!currentAvatar) {
      return null;
    }

    const liveAnchorQuaternion = currentAvatar.anchorRoot.quaternion.clone();
    currentAvatar.anchorRoot.updateWorldMatrix(true, true);
    const rootForward = resolveRootHorizontalForward(currentAvatar.root);
    const humanoidForward = resolveHumanoidHorizontalForward(currentAvatar.vrm);
    const appliedForward = resolveHorizontalAvatarForward(currentAvatar.root, currentAvatar.vrm);
    currentAvatar.anchorRoot.quaternion.copy(currentAvatar.anchorBaselineQuaternion);
    currentAvatar.anchorRoot.updateWorldMatrix(true, true);
    const baselineForward = resolveHorizontalAvatarForward(currentAvatar.root, currentAvatar.vrm);

    const expectedAnchorQuaternion = resolveExpectedProfileQuaternion(currentAvatar);
    const expectedForward = resolveExpectedProfileForward();
    const anchorAngularErrorDegrees = roundComparisonNumber(
      THREE.MathUtils.radToDeg(liveAnchorQuaternion.angleTo(expectedAnchorQuaternion))
    );
    const snapshot = {
      selectedProfileView: debugProfileView,
      rootForward: rootForward ? roundVector3(rootForward) : null,
      humanoidForward: humanoidForward ? roundVector3(humanoidForward) : null,
      baselineForward: baselineForward ? roundVector3(baselineForward) : null,
      appliedForward: appliedForward ? roundVector3(appliedForward) : null,
      expectedForward: roundVector3(expectedForward),
      baselineYawDegrees: resolveForwardYawDegrees(baselineForward),
      appliedYawDegrees: resolveForwardYawDegrees(appliedForward),
      expectedYawDegrees: resolveForwardYawDegrees(expectedForward) ?? 0,
      yawErrorDegrees: resolveYawErrorDegrees(
        resolveForwardYawDegrees(appliedForward),
        resolveForwardYawDegrees(expectedForward) ?? 0
      ),
      anchorQuaternion: roundQuaternionValues(liveAnchorQuaternion),
      expectedAnchorQuaternion: roundQuaternionValues(expectedAnchorQuaternion),
      anchorAngularErrorDegrees
    } satisfies AvatarProfileOrientationSnapshot;

    currentAvatar.anchorRoot.quaternion.copy(liveAnchorQuaternion);
    currentAvatar.anchorRoot.updateWorldMatrix(true, true);

    return snapshot;
  }

  function resolveHorizontalAvatarForward(root: THREE.Object3D, vrm: VRM | null): THREE.Vector3 | null {
    return resolveHumanoidHorizontalForward(vrm) ?? resolveRootHorizontalForward(root);
  }

  function resolveRootHorizontalForward(root: THREE.Object3D): THREE.Vector3 | null {
    const rootForward = root.getWorldDirection(new THREE.Vector3());
    rootForward.y = 0;

    if (rootForward.lengthSq() <= 1e-6) {
      return null;
    }

    return rootForward.normalize();
  }

  function resolveHumanoidHorizontalForward(vrm: VRM | null): THREE.Vector3 | null {
    if (!vrm) {
      return null;
    }

    const hipsNode = resolveRigOverlayBoneNode(vrm, VRMHumanBoneName.Hips);
    const headNode =
      resolveRigOverlayBoneNode(vrm, VRMHumanBoneName.Head) ??
      resolveRigOverlayBoneNode(vrm, VRMHumanBoneName.Neck) ??
      resolveRigOverlayBoneNode(vrm, VRMHumanBoneName.UpperChest) ??
      resolveRigOverlayBoneNode(vrm, VRMHumanBoneName.Chest);
    const lateralBonePairs: Array<[VRMHumanBoneNameValue, VRMHumanBoneNameValue]> = [
      [VRMHumanBoneName.LeftShoulder, VRMHumanBoneName.RightShoulder],
      [VRMHumanBoneName.LeftUpperLeg, VRMHumanBoneName.RightUpperLeg],
      [VRMHumanBoneName.LeftUpperArm, VRMHumanBoneName.RightUpperArm]
    ];

    if (!hipsNode || !headNode) {
      return null;
    }

    const upVector = headNode
      .getWorldPosition(new THREE.Vector3())
      .sub(hipsNode.getWorldPosition(new THREE.Vector3()));

    for (const [leftBoneName, rightBoneName] of lateralBonePairs) {
      const leftLateralNode = resolveRigOverlayBoneNode(vrm, leftBoneName);
      const rightLateralNode = resolveRigOverlayBoneNode(vrm, rightBoneName);

      if (!leftLateralNode || !rightLateralNode) {
        continue;
      }

      const rightVector = rightLateralNode
        .getWorldPosition(new THREE.Vector3())
        .sub(leftLateralNode.getWorldPosition(new THREE.Vector3()));
      const humanoidForward = rightVector.cross(upVector);
      humanoidForward.y = 0;

      if (humanoidForward.lengthSq() > 1e-6) {
        return humanoidForward.normalize();
      }
    }

    return null;
  }

  function resolveFrontProfileQuaternion(avatar: Pick<LoadedAvatar, "anchorRoot" | "anchorBaselineQuaternion" | "root" | "vrm">): THREE.Quaternion {
    avatar.anchorRoot.quaternion.copy(avatar.anchorBaselineQuaternion);
    avatar.anchorRoot.updateWorldMatrix(true, true);

    const measuredForward = resolveHorizontalAvatarForward(avatar.root, avatar.vrm);

    if (!measuredForward) {
      return avatar.anchorBaselineQuaternion.clone();
    }

    return avatar.anchorBaselineQuaternion
      .clone()
      .premultiply(new THREE.Quaternion().setFromUnitVectors(measuredForward, debugFrontProfileTargetForward))
      .normalize();
  }

  function createCharacterLoadTargetKey(character: CharacterManifestSummary): string {
    return `${character.characterId}:${character.assets.modelUrl}`;
  }

  function applyDebugProfileView(avatar: LoadedAvatar): void {
    avatar.anchorRoot.quaternion.copy(avatar.frontProfileQuaternion);

    if (debugProfileView === "side") {
      avatar.anchorRoot.quaternion.multiply(debugSideProfileYawOffsetQuaternion);
    }
  }

  function syncDebugProfileView(): void {
    if (!currentAvatar) {
      return;
    }

    if (!activeBaseAnimation) {
      applyDebugProfileView(currentAvatar);
      fitCameraToAvatar(currentAvatar.anchorRoot);
      emitChange();
      return;
    }

    restoreBaseAnimationPose(activeBaseAnimation);
    applyDebugProfileView(currentAvatar);
    updateBaseAnimation(0);
    fitCameraToAvatar(currentAvatar.anchorRoot);
    emitChange();
  }

  function createRigOverlayLineMaterial(): THREE.LineBasicMaterial {
    return new THREE.LineBasicMaterial({
      vertexColors: true,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.92,
      toneMapped: false
    });
  }

  function createRigOverlayJointMaterial(): THREE.PointsMaterial {
    return new THREE.PointsMaterial({
      vertexColors: true,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.96,
      size: 7,
      sizeAttenuation: false,
      toneMapped: false
    });
  }

  function createRigOverlayMarkerMaterial(color: number): THREE.LineBasicMaterial {
    return new THREE.LineBasicMaterial({
      color,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.8,
      toneMapped: false
    });
  }

  function createRigOverlayMarkerGeometry(): THREE.BufferGeometry {
    const segmentCount = 24;
    const positions = new Float32Array(segmentCount * 3);

    for (let index = 0; index < segmentCount; index += 1) {
      const angle = (index / segmentCount) * Math.PI * 2;
      const offset = index * 3;
      positions[offset] = Math.cos(angle);
      positions[offset + 1] = Math.sin(angle);
      positions[offset + 2] = 0;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return geometry;
  }

  function resolveRigOverlayJointColor(boneName: VRMHumanBoneNameValue): THREE.Color {
    switch (boneName) {
      case VRMHumanBoneName.LeftShoulder:
      case VRMHumanBoneName.LeftUpperArm:
      case VRMHumanBoneName.LeftLowerArm:
      case VRMHumanBoneName.LeftHand:
        return new THREE.Color(0xff8a65);
      case VRMHumanBoneName.RightShoulder:
      case VRMHumanBoneName.RightUpperArm:
      case VRMHumanBoneName.RightLowerArm:
      case VRMHumanBoneName.RightHand:
        return new THREE.Color(0x5aa9ff);
      case VRMHumanBoneName.LeftUpperLeg:
      case VRMHumanBoneName.LeftLowerLeg:
      case VRMHumanBoneName.LeftFoot:
      case VRMHumanBoneName.LeftToes:
        return new THREE.Color(0xa2e05a);
      case VRMHumanBoneName.RightUpperLeg:
      case VRMHumanBoneName.RightLowerLeg:
      case VRMHumanBoneName.RightFoot:
      case VRMHumanBoneName.RightToes:
        return new THREE.Color(0xf1d35b);
      default:
        return new THREE.Color(0x72d6c9);
    }
  }

  function resolveRigOverlayMarkerScale(boneName: VRMHumanBoneNameValue): number {
    switch (boneName) {
      case VRMHumanBoneName.Hips:
      case VRMHumanBoneName.Spine:
      case VRMHumanBoneName.Chest:
      case VRMHumanBoneName.UpperChest:
      case VRMHumanBoneName.Head:
        return 0.06;
      case VRMHumanBoneName.LeftShoulder:
      case VRMHumanBoneName.RightShoulder:
      case VRMHumanBoneName.LeftUpperArm:
      case VRMHumanBoneName.RightUpperArm:
      case VRMHumanBoneName.LeftUpperLeg:
      case VRMHumanBoneName.RightUpperLeg:
        return 0.05;
      default:
        return 0.04;
    }
  }

  function createRigOverlayJointMarker(
    boneName: VRMHumanBoneNameValue,
    markerGeometry: THREE.BufferGeometry,
    markerMaterials: readonly [THREE.LineBasicMaterial, THREE.LineBasicMaterial, THREE.LineBasicMaterial]
  ): THREE.Group {
    const markerRoot = new THREE.Group();
    const xRing = new THREE.LineLoop(markerGeometry, markerMaterials[0]);
    const yRing = new THREE.LineLoop(markerGeometry, markerMaterials[1]);
    const zRing = new THREE.LineLoop(markerGeometry, markerMaterials[2]);
    const markerScale = resolveRigOverlayMarkerScale(boneName);

    xRing.rotation.y = Math.PI / 2;
    yRing.rotation.x = Math.PI / 2;

    for (const ring of [xRing, yRing, zRing]) {
      ring.renderOrder = 10_002;
      ring.frustumCulled = false;
    }

    markerRoot.scale.setScalar(markerScale);
    markerRoot.add(xRing, yRing, zRing);
    return markerRoot;
  }

  function removeRigOverlayHelper(): void {
    if (!rigOverlayState) {
      return;
    }

    scene?.remove(rigOverlayState.root);
    rigOverlayState.lineGeometry.dispose();
    rigOverlayState.lineMaterial.dispose();
    rigOverlayState.jointGeometry.dispose();
    rigOverlayState.jointMaterial.dispose();
    rigOverlayState.markerGeometry.dispose();
    rigOverlayState.markerMaterials.forEach((material) => material.dispose());
    rigOverlayState = null;
  }

  function resolveRigOverlayBoneNode(vrm: VRM, boneName: VRMHumanBoneNameValue): THREE.Object3D | null {
    return vrm.humanoid.getRawBoneNode(boneName) ?? vrm.humanoid.getNormalizedBoneNode(boneName);
  }

  function groundAvatarRootToFloor(root: THREE.Object3D, vrm: VRM | null, debugLabel?: string): void {
    const label = debugLabel ?? "unknown";
    root.updateWorldMatrix(true, true);

    const groundedBoneHeights = vrm
      ? FLOOR_GROUNDING_BONE_NAMES.map((boneName) => {
          const node = resolveRigOverlayBoneNode(vrm, boneName);
          if (node) {
            const y = node.getWorldPosition(new THREE.Vector3()).y;
            console.log(`[ground:${label}] bone=${boneName} worldY=${y.toFixed(6)}`);
            return y;
          }
          return null;
        })
          .filter((h): h is number => h !== null && Number.isFinite(h))
      : [];
    const groundedFootHeights = vrm
      ? FLOOR_GROUNDING_FOOT_BONE_NAMES.map((boneName) => {
          const node = resolveRigOverlayBoneNode(vrm, boneName);
          if (node) {
            const y = node.getWorldPosition(new THREE.Vector3()).y;
            console.log(`[ground:${label}] footBone=${boneName} worldY=${y.toFixed(6)}`);
            return y;
          }
          return null;
        })
          .filter((h): h is number => h !== null && Number.isFinite(h))
      : [];

    const floorHeight =
      groundedFootHeights.length > 0
        ? Math.max(...groundedFootHeights)
        : groundedBoneHeights.length > 0
        ? Math.min(...groundedBoneHeights)
        : new THREE.Box3().setFromObject(root).min.y;

    console.log(`[ground:${label}] floorHeight=${floorHeight.toFixed(6)} root.position.y=${root.position.y.toFixed(6)} threshold=${1e-4}`);

    if (!Number.isFinite(floorHeight) || Math.abs(floorHeight) <= 1e-4) {
      console.log(`[ground:${label}] SKIPPED (below threshold or NaN)`);
      return;
    }

    root.position.y -= floorHeight;
    console.log(`[ground:${label}] APPLIED => root.position.y=${root.position.y.toFixed(6)}`);
    root.updateWorldMatrix(true, true);
  }

  /**
   * Per-frame floor grounding: two-phase approach equivalent to Unity's "Foot IK".
   * Phase 1: Root Y clamp — lowers the whole skeleton so the lowest foot reaches Y=0.
   * Phase 2: Per-leg IK — swings each UpperLeg to plant any remaining lifted foot at Y=0.
   * Phase 3: Toe-out correction — applies retargeting compensation so feet splay outward
   *          matching the source animation's visual intent on the original skeleton.
   * Runs generically on all animations; compensates for proportion mismatch without
   * modifying animation data.
   */
  const _floorVec = new THREE.Vector3();
  const _floorVec2 = new THREE.Vector3();

  // Toe-out angles (degrees) to apply as retargeting compensation.
  // The source animation (XBot) shows ~7° toe-out on both feet in the idle pose.
  // Our VRM model's leg chain orientation absorbs most of this, so we re-add it.
  const TOE_OUT_LEFT_DEG = 5;
  const TOE_OUT_RIGHT_DEG = 7;

  function applyFloorGrounding(root: THREE.Object3D, vrm: VRM): void {
    // --- Phase 1: Root Y clamp using HIGHEST foot ---
    // By clamping to the max foot Y, we guarantee NO foot goes above Y=0.
    // The other foot may go below floor (invisible) and gets IK'd back up in Phase 2.
    root.updateMatrixWorld(true);

    const leftFoot = vrm.humanoid.getRawBoneNode(VRMHumanBoneName.LeftFoot);
    const rightFoot = vrm.humanoid.getRawBoneNode(VRMHumanBoneName.RightFoot);

    if (!leftFoot || !rightFoot) return;

    const leftFootY = leftFoot.getWorldPosition(_floorVec).y;
    const rightFootY = rightFoot.getWorldPosition(_floorVec2).y;
    const highestFootY = Math.max(leftFootY, rightFootY);

    if (Number.isFinite(highestFootY) && Math.abs(highestFootY) > 0.0005) {
      root.position.y -= highestFootY;
      root.updateMatrixWorld(true);
    }

    // --- Phase 2: Per-leg IK (bring any foot that's below OR above Y=0 back to Y=0) ---
    applyLegSwingIK(vrm, VRMHumanBoneName.LeftUpperLeg, VRMHumanBoneName.LeftFoot);
    applyLegSwingIK(vrm, VRMHumanBoneName.RightUpperLeg, VRMHumanBoneName.RightFoot);

    // --- Phase 3: Toe-out retargeting correction ---
    // The source skeleton shows visible toe-out that the VRM chain doesn't reproduce.
    // Apply a Y-axis rotation to each foot bone to match the original visual intent.
    const leftToeOutRad = (TOE_OUT_LEFT_DEG * Math.PI) / 180;
    leftFoot.quaternion.multiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), leftToeOutRad)
    );
    leftFoot.updateWorldMatrix(false, true);

    const rightToeOutRad = (TOE_OUT_RIGHT_DEG * Math.PI) / 180;
    rightFoot.quaternion.multiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -rightToeOutRad)
    );
    rightFoot.updateWorldMatrix(false, true);

    // Expose VRM for debug inspection
    (window as any).__vrm = vrm;

    // Diagnostic (re-measure after IK)
    const _diagLQ = new THREE.Quaternion();
    const _diagRQ = new THREE.Quaternion();
    leftFoot.getWorldQuaternion(_diagLQ);
    rightFoot.getWorldQuaternion(_diagRQ);
    // Foot forward = local -Z in world space (VRM T-pose faces -Z)
    const lFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(_diagLQ);
    const rFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(_diagRQ);
    // Toe-out angle: atan2 of XZ projection relative to world -Z
    const lToeOut = Math.atan2(-lFwd.x, -lFwd.z) * 180 / Math.PI;
    const rToeOut = Math.atan2(rFwd.x, -rFwd.z) * 180 / Math.PI;

    // Knee world positions for tracking direction
    const leftKnee = vrm.humanoid.getRawBoneNode(VRMHumanBoneName.LeftLowerLeg);
    const rightKnee = vrm.humanoid.getRawBoneNode(VRMHumanBoneName.RightLowerLeg);
    const lKneePos = leftKnee ? leftKnee.getWorldPosition(new THREE.Vector3()) : null;
    const rKneePos = rightKnee ? rightKnee.getWorldPosition(new THREE.Vector3()) : null;

    (window as any).__floorClampDiag = {
      highestFootY,
      rootY: root.position.y,
      leftFootY: leftFoot.getWorldPosition(_floorVec).y,
      rightFootY: rightFoot.getWorldPosition(_floorVec2).y,
      leftToeOutDeg: lToeOut,
      rightToeOutDeg: rToeOut,
      leftFootFwd: { x: lFwd.x.toFixed(4), z: lFwd.z.toFixed(4) },
      rightFootFwd: { x: rFwd.x.toFixed(4), z: rFwd.z.toFixed(4) },
      leftKneeWorldPos: lKneePos ? { x: lKneePos.x.toFixed(4), y: lKneePos.y.toFixed(4), z: lKneePos.z.toFixed(4) } : null,
      rightKneeWorldPos: rKneePos ? { x: rKneePos.x.toFixed(4), y: rKneePos.y.toFixed(4), z: rKneePos.z.toFixed(4) } : null,
    };
  }

  /**
   * Two-bone IK solver for leg grounding. Adjusts UpperLeg and LowerLeg rotations
   * to plant the foot at Y=0 while keeping the knee pointing forward via pole constraint.
   *
   * Algorithm:
   *  1. Compute target knee position using law of cosines + pole direction
   *  2. Swing upper leg to point at new knee position
   *  3. Apply pole constraint: twist upper leg around its axis so knee faces forward
   *  4. Swing lower leg to point at foot target
   *  5. Restore foot world orientation (toe-out preservation)
   */
  function applyLegSwingIK(
    vrm: VRM,
    upperBoneName: VRMHumanBoneNameValue,
    footBoneName: VRMHumanBoneNameValue
  ): void {
    const lowerBoneName = upperBoneName === VRMHumanBoneName.LeftUpperLeg
      ? VRMHumanBoneName.LeftLowerLeg
      : VRMHumanBoneName.RightLowerLeg;

    const upperNode = vrm.humanoid.getRawBoneNode(upperBoneName);
    const lowerNode = vrm.humanoid.getRawBoneNode(lowerBoneName);
    const footNode = vrm.humanoid.getRawBoneNode(footBoneName);

    if (!upperNode || !lowerNode || !footNode) return;

    const hipPos = new THREE.Vector3();
    const kneePos = new THREE.Vector3();
    const footPos = new THREE.Vector3();
    upperNode.getWorldPosition(hipPos);
    lowerNode.getWorldPosition(kneePos);
    footNode.getWorldPosition(footPos);

    // Only fix if foot is meaningfully away from floor (in either direction)
    if (Math.abs(footPos.y) <= 0.001) return;

    // Capture foot world orientation BEFORE IK so we can restore it after
    const footWorldQuatBefore = new THREE.Quaternion();
    footNode.getWorldQuaternion(footWorldQuatBefore);

    // --- Robust pole direction from animation's knee position ---
    // The knee's forward direction (XZ projection from hip) tells us where the kneecap
    // should face. This is stable even when the leg is nearly straight.
    const animPoleDir = new THREE.Vector3(
      kneePos.x - hipPos.x, 0, kneePos.z - hipPos.z
    );
    if (animPoleDir.lengthSq() < 0.0001) {
      // Knee directly above/below hip — use world forward as fallback
      animPoleDir.set(0, 0, -1);
    }
    animPoleDir.normalize();

    // Target: same X/Z, Y=0
    const targetPos = new THREE.Vector3(footPos.x, 0, footPos.z);

    // Bone lengths
    const upperLen = hipPos.distanceTo(kneePos);
    const lowerLen = kneePos.distanceTo(footPos);
    const chainLen = upperLen + lowerLen;

    // Distance from hip to target
    const targetDist = hipPos.distanceTo(targetPos);

    // --- Unreachable: fully extend toward target ---
    if (targetDist >= chainLen * 0.9999) {
      const hipToTarget = targetPos.clone().sub(hipPos).normalize();
      const currentHipToFoot = footPos.clone().sub(hipPos).normalize();
      if (currentHipToFoot.distanceTo(hipToTarget) > 0.0001) {
        const swing = new THREE.Quaternion().setFromUnitVectors(currentHipToFoot, hipToTarget);
        applyWorldRotationToLocal(upperNode, swing);
        upperNode.updateWorldMatrix(false, true);
        // Apply pole constraint even for extended leg
        applyPoleConstraint(upperNode, lowerNode, hipPos, animPoleDir);
      }
      // Straighten knee toward target
      lowerNode.getWorldPosition(kneePos);
      footNode.getWorldPosition(footPos);
      const kneeToFoot = footPos.clone().sub(kneePos).normalize();
      const kneeToTarget = targetPos.clone().sub(kneePos).normalize();
      if (kneeToFoot.distanceTo(kneeToTarget) > 0.0001) {
        const lowerSwing = new THREE.Quaternion().setFromUnitVectors(kneeToFoot, kneeToTarget);
        applyWorldRotationToLocal(lowerNode, lowerSwing);
        lowerNode.updateWorldMatrix(false, true);
      }
      restoreFootOrientation(footNode, footWorldQuatBefore);
      (window as any).__ikDebug = { path: "unreachable", targetDist, chainLen };
      return;
    }

    // --- Too close: bail ---
    if (targetDist < Math.abs(upperLen - lowerLen) + 0.001) {
      (window as any).__ikDebug = { bail: "tooClose", upperLen, lowerLen, targetDist };
      return;
    }

    // --- Solve knee position using law of cosines ---
    const cosHipAngle = (upperLen * upperLen + targetDist * targetDist - lowerLen * lowerLen)
      / (2 * upperLen * targetDist);
    const hipAngle = Math.acos(Math.max(-1, Math.min(1, cosHipAngle)));

    // Direction from hip to target
    const hipToTarget = targetPos.clone().sub(hipPos).normalize();

    // Pole direction perpendicular to hip→target axis.
    // Project animPoleDir onto the plane perpendicular to hipToTarget.
    const poleDot = animPoleDir.dot(hipToTarget);
    const poleDir = animPoleDir.clone().sub(
      hipToTarget.clone().multiplyScalar(poleDot)
    );
    if (poleDir.lengthSq() < 0.0001) {
      // Degenerate (pole aligned with target direction) — use world forward
      poleDir.set(0, 0, -1);
      const d = poleDir.dot(hipToTarget);
      poleDir.sub(hipToTarget.clone().multiplyScalar(d));
    }
    poleDir.normalize();

    // New knee position
    const newKneePos = hipPos.clone()
      .add(hipToTarget.clone().multiplyScalar(Math.cos(hipAngle) * upperLen))
      .add(poleDir.clone().multiplyScalar(Math.sin(hipAngle) * upperLen));

    // --- Step 1: Swing upper leg to point at new knee position ---
    const currentHipToKnee = kneePos.clone().sub(hipPos).normalize();
    const desiredHipToKnee = newKneePos.clone().sub(hipPos).normalize();

    if (currentHipToKnee.distanceTo(desiredHipToKnee) > 0.0001) {
      const upperSwing = new THREE.Quaternion().setFromUnitVectors(currentHipToKnee, desiredHipToKnee);
      applyWorldRotationToLocal(upperNode, upperSwing);
      upperNode.updateWorldMatrix(false, true);
    }

    // --- Step 2: Pole constraint — twist upper leg to keep knee forward ---
    applyPoleConstraint(upperNode, lowerNode, hipPos, animPoleDir);

    // --- Step 3: Swing lower leg to point at target ---
    lowerNode.getWorldPosition(kneePos);
    footNode.getWorldPosition(footPos);

    const currentKneeToFoot = footPos.clone().sub(kneePos).normalize();
    const desiredKneeToFoot = targetPos.clone().sub(kneePos).normalize();

    if (currentKneeToFoot.distanceTo(desiredKneeToFoot) > 0.0001) {
      const lowerSwing = new THREE.Quaternion().setFromUnitVectors(currentKneeToFoot, desiredKneeToFoot);
      applyWorldRotationToLocal(lowerNode, lowerSwing);
      lowerNode.updateWorldMatrix(false, true);
    }

    // --- Step 4: Restore foot orientation ---
    restoreFootOrientation(footNode, footWorldQuatBefore);

    // Debug
    const finalFootPos = new THREE.Vector3();
    footNode.getWorldPosition(finalFootPos);
    (window as any).__ikDebug = {
      applied: true,
      leg: upperBoneName === VRMHumanBoneName.RightUpperLeg ? "right" : "left",
      footAfterY: finalFootPos.y,
      targetDist,
      chainLen,
      hipAngleDeg: hipAngle * 180 / Math.PI,
    };
  }

  /**
   * Pole constraint: twists the upper leg bone around its own axis so that
   * the knee (child bone) points in the desired forward direction.
   * This prevents knee pop-out caused by setFromUnitVectors introducing unwanted roll.
   */
  function applyPoleConstraint(
    upperNode: THREE.Object3D,
    lowerNode: THREE.Object3D,
    hipPos: THREE.Vector3,
    desiredPoleDir: THREE.Vector3
  ): void {
    // Get current knee position and upper leg axis
    const currentKneePos = new THREE.Vector3();
    lowerNode.getWorldPosition(currentKneePos);

    const boneAxis = currentKneePos.clone().sub(hipPos).normalize();

    // Project current knee offset onto the plane perpendicular to bone axis
    // (This gives us the direction the knee is currently pointing)
    const hipToKnee = currentKneePos.clone().sub(hipPos);
    const axisProj = boneAxis.clone().multiplyScalar(hipToKnee.dot(boneAxis));
    const currentPoleVec = hipToKnee.clone().sub(axisProj);

    // Project desired pole direction onto the same perpendicular plane
    const desiredProj = desiredPoleDir.clone().sub(
      boneAxis.clone().multiplyScalar(desiredPoleDir.dot(boneAxis))
    );

    if (currentPoleVec.lengthSq() < 0.00001 || desiredProj.lengthSq() < 0.00001) {
      // Leg is perfectly straight or pole is along bone axis — no correction possible
      return;
    }

    currentPoleVec.normalize();
    desiredProj.normalize();

    // Compute the twist angle between current and desired pole direction
    const dot = Math.max(-1, Math.min(1, currentPoleVec.dot(desiredProj)));
    if (dot > 0.9999) return; // Already aligned

    // Determine twist direction using cross product
    const cross = currentPoleVec.clone().cross(desiredProj);
    const sign = Math.sign(cross.dot(boneAxis));
    const angle = sign * Math.acos(dot);

    // Apply twist around the bone axis (in world space)
    const twistQuat = new THREE.Quaternion().setFromAxisAngle(boneAxis, angle);
    applyWorldRotationToLocal(upperNode, twistQuat);
    upperNode.updateWorldMatrix(false, true);
  }

  /** Converts a world-space rotation to local space and premultiplies onto the bone. */
  function applyWorldRotationToLocal(bone: THREE.Object3D, worldRot: THREE.Quaternion): void {
    const parentWorldQuat = new THREE.Quaternion();
    if (bone.parent) {
      bone.parent.getWorldQuaternion(parentWorldQuat);
    }
    const parentInv = parentWorldQuat.clone().invert();
    // localSwing = inv(parentWorld) * worldRot * parentWorld
    const localSwing = parentInv.multiply(worldRot).multiply(parentWorldQuat);
    bone.quaternion.premultiply(localSwing);
  }

  /**
   * After leg IK adjusts upper/lower leg, the foot's world orientation drifts because
   * it's a child of the rotated chain. This restores the foot's original world orientation
   * (preserving toe-out angle from the animation).
   */
  function restoreFootOrientation(footNode: THREE.Object3D, targetWorldQuat: THREE.Quaternion): void {
    const currentWorldQuat = new THREE.Quaternion();
    footNode.getWorldQuaternion(currentWorldQuat);

    // World-space correction: from current → target
    const correction = currentWorldQuat.clone().invert().premultiply(targetWorldQuat);
    // correction = targetWorldQuat * inv(currentWorldQuat) — applied in world space

    // Convert to local space and apply
    applyWorldRotationToLocal(footNode, correction);
  }

  function createRigOverlayState(avatar: LoadedAvatar): RigOverlayState | null {
    if (!avatar.vrm) {
      return null;
    }

    const segments: RigOverlaySegment[] = [];
    const overlayJoints: RigOverlayJoint[] = [];
    const seenJointBones = new Set<VRMHumanBoneNameValue>();

    for (const definition of RIG_OVERLAY_SEGMENTS) {
      const startNode = resolveRigOverlayBoneNode(avatar.vrm, definition.startBoneName);
      const endNode = resolveRigOverlayBoneNode(avatar.vrm, definition.endBoneName);

      if (!startNode || !endNode) {
        continue;
      }

      segments.push({
        startNode,
        endNode,
        color: new THREE.Color(definition.color)
      });

      if (!seenJointBones.has(definition.startBoneName)) {
        seenJointBones.add(definition.startBoneName);
        overlayJoints.push({
          boneName: definition.startBoneName,
          node: startNode,
          color: resolveRigOverlayJointColor(definition.startBoneName),
          markerRoot: new THREE.Group()
        });
      }

      if (!seenJointBones.has(definition.endBoneName)) {
        seenJointBones.add(definition.endBoneName);
        overlayJoints.push({
          boneName: definition.endBoneName,
          node: endNode,
          color: resolveRigOverlayJointColor(definition.endBoneName),
          markerRoot: new THREE.Group()
        });
      }
    }

    if (segments.length === 0 || overlayJoints.length === 0) {
      return null;
    }

    const lineGeometry = new THREE.BufferGeometry();
    const linePositionAttribute = new THREE.BufferAttribute(new Float32Array(segments.length * 2 * 3), 3);
    const lineColorAttribute = new THREE.BufferAttribute(new Float32Array(segments.length * 2 * 3), 3);
    linePositionAttribute.setUsage(THREE.DynamicDrawUsage);
    lineGeometry.setAttribute("position", linePositionAttribute);
    lineGeometry.setAttribute("color", lineColorAttribute);

    const jointGeometry = new THREE.BufferGeometry();
    const jointPositionAttribute = new THREE.BufferAttribute(new Float32Array(overlayJoints.length * 3), 3);
    const jointColorAttribute = new THREE.BufferAttribute(new Float32Array(overlayJoints.length * 3), 3);
    jointPositionAttribute.setUsage(THREE.DynamicDrawUsage);
    jointGeometry.setAttribute("position", jointPositionAttribute);
    jointGeometry.setAttribute("color", jointColorAttribute);

    const lineMaterial = createRigOverlayLineMaterial();
    const jointMaterial = createRigOverlayJointMaterial();
    const markerGeometry = createRigOverlayMarkerGeometry();
    const markerMaterials = [
      createRigOverlayMarkerMaterial(0xff6f61),
      createRigOverlayMarkerMaterial(0x73d86b),
      createRigOverlayMarkerMaterial(0x5aa9ff)
    ] as const;
    const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
    const joints = new THREE.Points(jointGeometry, jointMaterial);
    const root = new THREE.Group();

    root.name = "avatar_rig_overlay";
    lines.renderOrder = 10_000;
    joints.renderOrder = 10_001;
    lines.frustumCulled = false;
    joints.frustumCulled = false;
    root.add(lines, joints);

    segments.forEach((segment, segmentIndex) => {
      const attributeOffset = segmentIndex * 2;
      lineColorAttribute.setXYZ(attributeOffset, segment.color.r, segment.color.g, segment.color.b);
      lineColorAttribute.setXYZ(attributeOffset + 1, segment.color.r, segment.color.g, segment.color.b);
    });

    overlayJoints.forEach((joint, jointIndex) => {
      jointColorAttribute.setXYZ(jointIndex, joint.color.r, joint.color.g, joint.color.b);
      joint.markerRoot = createRigOverlayJointMarker(joint.boneName, markerGeometry, markerMaterials);
      root.add(joint.markerRoot);
    });

    return {
      avatarRoot: avatar.root,
      root,
      lineGeometry,
      lineMaterial,
      linePositionAttribute,
      lineColorAttribute,
      jointGeometry,
      jointMaterial,
      jointPositionAttribute,
      jointColorAttribute,
      markerGeometry,
      markerMaterials: [...markerMaterials],
      segments,
      joints: overlayJoints
    };
  }

  function updateRigOverlayState(overlayState: RigOverlayState): void {
    const worldPosition = new THREE.Vector3();
    const worldQuaternion = new THREE.Quaternion();
    let lineOffset = 0;

    overlayState.avatarRoot.updateWorldMatrix(true, true);

    for (const segment of overlayState.segments) {
      segment.startNode.getWorldPosition(worldPosition);
      overlayState.linePositionAttribute.setXYZ(lineOffset, worldPosition.x, worldPosition.y, worldPosition.z);
      lineOffset += 1;

      segment.endNode.getWorldPosition(worldPosition);
      overlayState.linePositionAttribute.setXYZ(lineOffset, worldPosition.x, worldPosition.y, worldPosition.z);
      lineOffset += 1;
    }

    let jointOffset = 0;

    for (const joint of overlayState.joints) {
      joint.node.getWorldPosition(worldPosition);
      overlayState.jointPositionAttribute.setXYZ(jointOffset, worldPosition.x, worldPosition.y, worldPosition.z);
      joint.markerRoot.position.copy(worldPosition);
      joint.node.getWorldQuaternion(worldQuaternion);
      joint.markerRoot.quaternion.copy(worldQuaternion);
      jointOffset += 1;
    }

    overlayState.linePositionAttribute.needsUpdate = true;
    overlayState.jointPositionAttribute.needsUpdate = true;
  }

  function syncRigOverlayHelper(): void {
    if (!scene || !currentAvatar || !rigOverlayEnabled) {
      removeRigOverlayHelper();
      return;
    }

    if (!rigOverlayState || rigOverlayState.avatarRoot !== currentAvatar.root) {
      removeRigOverlayHelper();
      rigOverlayState = createRigOverlayState(currentAvatar);

      if (!rigOverlayState) {
        return;
      }

      scene.add(rigOverlayState.root);
    }

    updateRigOverlayState(rigOverlayState);
    rigOverlayState.root.visible = true;
  }

  function getHumanoidPlaybackDebugSnapshot(): AvatarHumanoidPlaybackDebugSnapshot {
    if (!activeBaseAnimation) {
      return {
        activeAnimationId: null,
        hasActiveBaseAnimation: false,
        hasHumanoidPlayback: false,
        playbackPath: null,
        channelSpace: null,
        elapsedSeconds: null,
        currentPose: null,
        finalFramePose: null,
        boundChannels: [],
        quaternionBoundChannels: [],
        targetedBones: []
      };
    }

    const currentPose = activeBaseAnimation.humanoidPlayback?.getPoseSnapshot(activeBaseAnimation.elapsedSeconds) ?? null;
    const finalFramePose =
      activeBaseAnimation.humanoidPlayback?.getPoseSnapshot(
        resolveFinalFrameElapsedSeconds(activeBaseAnimation.payload)
      ) ?? null;

    return {
      activeAnimationId: activeBaseAnimation.command.id,
      hasActiveBaseAnimation: true,
      hasHumanoidPlayback: Boolean(activeBaseAnimation.humanoidPlayback),
      playbackPath: activeBaseAnimation.playbackPath,
      channelSpace: activeBaseAnimation.payload.channelSpace ?? null,
      elapsedSeconds: activeBaseAnimation.elapsedSeconds,
      currentPose,
      finalFramePose,
      boundChannels:
        currentPose?.boundChannels.map((binding) => ({
          channelName: binding.channelName,
          normalizedName: binding.normalizedName,
          boneName: binding.boneName,
          axis: binding.axis,
          scale: binding.scale,
          sampledDelta: binding.sampledDelta
        })) ?? [],
      quaternionBoundChannels:
        currentPose?.quaternionBoundChannels.map((binding) => ({
          normalizedNamePrefix: binding.normalizedNamePrefix,
          boneName: binding.boneName,
          sampledRotation: binding.sampledRotation
        })) ?? [],
      targetedBones: currentPose?.targetedBones.map((boneName) => boneName) ?? []
    };
  }

  if (import.meta.env.DEV) {
    const debugApi: AvatarRuntimeDebugApi = Object.freeze({
      getProfileOrientationSnapshot: () => getProfileOrientationSnapshot(),
      getHumanoidPlayback: () => getHumanoidPlaybackDebugSnapshot()
    });

    Object.defineProperty(window, "__NIKOF_AVATAR_DEBUG__", {
      configurable: true,
      value: debugApi,
      writable: false
    });
  }

  function emitChange(): void {
    listeners.forEach((listener) => listener());
  }

  function isTexture(value: unknown): value is THREE.Texture {
    return value instanceof THREE.Texture;
  }

  function updateSnapshot(nextValues: Partial<AvatarRuntimeSnapshot>): void {
    snapshot = {
      ...snapshot,
      ...nextValues
    };

    emitChange();
  }

  function getSpeechOverlayChannel(): AvatarOverlayChannelSnapshot {
    return snapshot.overlayChannels.find((channel) => channel.channelId === "speech") ?? createSpeechOverlayChannel();
  }

  function buildSpeechOverlaySnapshot(
    values: Partial<AvatarOverlayChannelSnapshot>
  ): Pick<AvatarRuntimeSnapshot, "overlayChannels" | "speechReactionMode" | "activeViseme"> {
    const speechOverlay = createSpeechOverlayChannel({
      ...getSpeechOverlayChannel(),
      ...values,
      channelId: "speech"
    });

    return {
      overlayChannels: snapshot.overlayChannels.some((channel) => channel.channelId === "speech")
        ? snapshot.overlayChannels.map((channel) => (channel.channelId === "speech" ? speechOverlay : channel))
        : [...snapshot.overlayChannels, speechOverlay],
      speechReactionMode: speechOverlay.mode,
      activeViseme: speechOverlay.mode === "viseme" ? speechOverlay.label : null
    };
  }

  function clearSpeechReactionTimers(): void {
    speechReactionTimeoutIds.forEach((timeoutId) => {
      window.clearTimeout(timeoutId);
    });
    speechReactionTimeoutIds = [];
  }

  function getExpressionManager() {
    return currentAvatar?.vrm?.expressionManager ?? null;
  }

  function setActiveEmotion(emotion: AvatarRuntimeEmotionName | null): void {
    passiveEmotion?.setEmotion(emotion);
    updateSnapshot({
      activeEmotion: emotion
    });
  }

  function resetSpeechExpressions(): void {
    const expressionManager = getExpressionManager();

    if (!expressionManager) {
      activeSpeechExpressionName = null;
      return;
    }

    VRM_MOUTH_EXPRESSION_NAMES.forEach((expressionName) => {
      expressionManager.setValue(expressionName, 0);
    });

    if (activeSpeechExpressionName && !VRM_MOUTH_EXPRESSION_NAME_SET.has(activeSpeechExpressionName)) {
      expressionManager.setValue(activeSpeechExpressionName, 0);
    }

    expressionManager.update();
    activeSpeechExpressionName = null;
  }

  function resolveSpeechExpressionName(viseme: string): string | null {
    const expressionManager = getExpressionManager();
    const trimmedViseme = viseme.trim();

    if (!expressionManager || trimmedViseme.length === 0) {
      return null;
    }

    const normalizedViseme = trimmedViseme.toLowerCase().replace(/[\s_-]+/g, "");
    const aliasExpressionName = VRM_MOUTH_EXPRESSION_ALIASES[normalizedViseme];
    const candidateNames = [trimmedViseme, trimmedViseme.toLowerCase(), aliasExpressionName].filter(
      (value): value is string => Boolean(value)
    );

    for (const candidateName of candidateNames) {
      if (expressionManager.getExpression(candidateName)) {
        return candidateName;
      }
    }

    return null;
  }

  function buildSpeechReactionVisemes(input: AvatarSpeechReactionInput): AvatarSpeechReactionViseme[] {
    const visemeSlots = input.visemeSlots ?? [];
    const utteranceDurationMs =
      typeof input.utteranceDurationMs === "number" && input.utteranceDurationMs > 0 ? input.utteranceDurationMs : null;

    return visemeSlots.flatMap((slot) => {
      if (!Number.isFinite(slot.start_ms) || !Number.isFinite(slot.end_ms)) {
        return [];
      }

      const startMs = Math.max(0, slot.start_ms);
      const unclampedEndMs = Math.max(startMs, slot.end_ms);
      const endMs = utteranceDurationMs === null ? unclampedEndMs : Math.min(unclampedEndMs, utteranceDurationMs);
      const expressionName = resolveSpeechExpressionName(slot.viseme);

      if (!expressionName || endMs <= startMs) {
        return [];
      }

      return [
        {
          expressionName,
          label: slot.viseme.trim() || expressionName,
          startMs,
          endMs
        }
      ];
    });
  }

  function activateSpeechViseme(expressionName: string, label: string): void {
    const expressionManager = getExpressionManager();

    if (!expressionManager) {
      updateSnapshot({
        currentState: "speak",
        ...buildSpeechOverlaySnapshot({
          mode: "coarse"
        })
      });
      return;
    }

    if (activeSpeechExpressionName !== expressionName) {
      resetSpeechExpressions();
      expressionManager.setValue(expressionName, 1);
      expressionManager.update();
      activeSpeechExpressionName = expressionName;
    }

    updateSnapshot({
      currentState: "speak",
      ...buildSpeechOverlaySnapshot({
        mode: "viseme",
        label
      })
    });
  }

  function beginSpeechReaction(input: AvatarSpeechReactionInput): void {
    clearSpeechReactionTimers();
    resetSpeechExpressions();
    passiveMouth?.suppressForSpeech();

    const speechReactionVisemes = buildSpeechReactionVisemes(input);

    if (speechReactionVisemes.length === 0) {
      updateSnapshot({
        currentState: "speak",
        ...buildSpeechOverlaySnapshot({
          mode: "coarse"
        })
      });
      return;
    }

    updateSnapshot({
      currentState: "speak",
      ...buildSpeechOverlaySnapshot({
        mode: "viseme"
      })
    });

    speechReactionVisemes.forEach((viseme) => {
      speechReactionTimeoutIds.push(
        window.setTimeout(() => {
          activateSpeechViseme(viseme.expressionName, viseme.label);
        }, viseme.startMs)
      );

      speechReactionTimeoutIds.push(
        window.setTimeout(() => {
          if (activeSpeechExpressionName !== viseme.expressionName) {
            return;
          }

          resetSpeechExpressions();
          updateSnapshot({
            currentState: "speak",
            ...buildSpeechOverlaySnapshot({
              mode: "viseme"
            })
          });
        }, viseme.endMs)
      );
    });
  }

  function clearSpeechReaction(): void {
    clearSpeechReactionTimers();
    resetSpeechExpressions();
    passiveMouth?.releaseFromSpeech();
    updateSnapshot({
      currentState: "idle",
      ...buildSpeechOverlaySnapshot({
        mode: "idle"
      })
    });
  }

  function resolveBaseAnimationPayload(command: SemanticAnimationCommand): SemanticAnimationRuntimePayload | null {
    return resolveSharedSemanticAnimationPayload(command);
  }

  function resolveHumanoidPlayback(
    vrm: VRM | null,
    payload: SemanticAnimationRuntimePayload
  ): ResolvedAnimationPlayback {
    return resolveAvatarRuntimePlayback(vrm, payload, animationPlaybackPath);
  }

  function restoreBaseAnimationPose(baseAnimationState: ActiveBaseAnimationState): void {
    baseAnimationState.humanoidPlayback?.reset();
    baseAnimationState.root.position.copy(baseAnimationState.baselinePosition);
    baseAnimationState.root.quaternion.copy(baseAnimationState.baselineQuaternion);
  }

  function stopBaseAnimation(): void {
    if (!activeBaseAnimation) {
      return;
    }

    restoreBaseAnimationPose(activeBaseAnimation);
    activeBaseAnimation = null;
  }

  function updateBaseAnimation(deltaSeconds: number): void {
    if (!activeBaseAnimation) {
      return;
    }

    // VRMA path: let the VRMA mixer handle playback directly
    if (activeBaseAnimation.playbackPath === "vrma" && vrmaPlayback) {
      vrmaPlayback.update(deltaSeconds);
      return;
    }

    if (activeBaseAnimation.command.playback === "loop") {
      // Let elapsed time grow continuously; the mixer's LoopRepeat handles wrapping internally.
      activeBaseAnimation.elapsedSeconds += deltaSeconds;
    } else {
      const cycleDurationSeconds = Math.max(resolveFinalFrameElapsedSeconds(activeBaseAnimation.payload), 1 / 30);
      activeBaseAnimation.elapsedSeconds = Math.min(activeBaseAnimation.elapsedSeconds + deltaSeconds, cycleDurationSeconds);
    }

    activeBaseAnimation.humanoidPlayback?.apply(activeBaseAnimation.elapsedSeconds);
  }

  function activateBaseAnimation(command: SemanticAnimationCommand): void {
    const resolvedPayload = resolveBaseAnimationPayload(command);

    if (!resolvedPayload || !currentAvatar) {
      stopBaseAnimation();
      updateSnapshot({
        pendingAnimation: command,
        baseAnimation: resolvedPayload ? command : snapshot.baseAnimation,
        error: resolvedPayload
          ? null
          : `Semantic animation '${command.id}' is not yet backed by a web runtime payload.`
      });
      return;
    }

    stopBaseAnimation();
    const resolvedPlayback = resolveHumanoidPlayback(currentAvatar.vrm, resolvedPayload);
    activeBaseAnimation = {
      command,
      payload: resolvedPayload,
      playbackPath: resolvedPlayback.playbackPath,
      root: currentAvatar.root,
      baselinePosition: currentAvatar.root.position.clone(),
      baselineQuaternion: currentAvatar.root.quaternion.clone(),
      humanoidPlayback: resolvedPlayback.playback,
      elapsedSeconds: 0
    };

    // VRMA path: load and play the .vrma file via three-vrm-animation
    if (resolvedPlayback.playbackPath === "vrma" && vrmaPlayback) {
      const candidates = resolveVrmaAssetCandidates(command.id);
      const vrmaUrl = candidates[0]?.url;
      if (vrmaUrl) {
        vrmaPlayback.loadVrma(vrmaUrl, command.id).then(() => {
          vrmaPlayback!.play(command.id, {
            loop: command.playback === "loop"
          });
        }).catch((err) => {
          console.warn(`[activateBase] VRMA load failed for ${command.id}:`, err);
        });
      }
      // Ground immediately based on current pose
      activeBaseAnimation.root.updateMatrixWorld(true);
      groundAvatarRootToFloor(activeBaseAnimation.root, currentAvatar.vrm, "animStart");
      activeBaseAnimation.baselinePosition.copy(activeBaseAnimation.root.position);
    } else {
      // Mixer/feetAnchored path: apply frame 0 so skeleton is in posed position, then ground
      activeBaseAnimation.humanoidPlayback?.apply(0);
      activeBaseAnimation.root.updateMatrixWorld(true);
      groundAvatarRootToFloor(activeBaseAnimation.root, currentAvatar.vrm, "animStart");
      activeBaseAnimation.baselinePosition.copy(activeBaseAnimation.root.position);
    }

    updateBaseAnimation(0);

    updateSnapshot({
      pendingAnimation: null,
      baseAnimation: command,
      error: null
    });
  }

  function disposeMaterial(material: THREE.Material): void {
    for (const value of Object.values(material as unknown as Record<string, unknown>)) {
      if (isTexture(value)) {
        value.dispose();
      }
    }

    material.dispose();
  }

  function clearCurrentAvatar(): void {
    if (!scene || !currentAvatar) {
      removeRigOverlayHelper();
      stopBaseAnimation();
      if (vrmaPlayback) { vrmaPlayback.dispose(); vrmaPlayback = null; }
      if (passiveBlink) { passiveBlink.dispose(); passiveBlink = null; }
      if (passiveMouth) { passiveMouth.dispose(); passiveMouth = null; }
      if (passiveEyeDrift) { passiveEyeDrift.dispose(); passiveEyeDrift = null; }
      if (passiveEmotion) { passiveEmotion.dispose(); passiveEmotion = null; }
      currentAvatar = null;
      return;
    }

    removeRigOverlayHelper();
    stopBaseAnimation();
    if (vrmaPlayback) { vrmaPlayback.dispose(); vrmaPlayback = null; }
    if (passiveBlink) { passiveBlink.dispose(); passiveBlink = null; }
    if (passiveMouth) { passiveMouth.dispose(); passiveMouth = null; }
    if (passiveEyeDrift) { passiveEyeDrift.dispose(); passiveEyeDrift = null; }
    if (passiveEmotion) { passiveEmotion.dispose(); passiveEmotion = null; }
    scene.remove(currentAvatar.anchorRoot);
    currentAvatar.root.traverse((node: THREE.Object3D) => {
      const mesh = node as THREE.Mesh;

      if (mesh.geometry) {
        mesh.geometry.dispose();
      }

      if (Array.isArray(mesh.material)) {
        mesh.material.forEach(disposeMaterial);
      } else if (mesh.material) {
        disposeMaterial(mesh.material);
      }
    });

    currentAvatar = null;
  }

  function handleResize(): void {
    if (!renderer || !camera || !viewportElement) {
      return;
    }

    const width = Math.max(viewportElement.clientWidth, 1);
    const height = Math.max(viewportElement.clientHeight, 1);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    if (currentAvatar) {
      fitCameraToAvatar(currentAvatar.anchorRoot);
      return;
    }

    orbitControls?.update();
  }

  function startRenderLoop(): void {
    if (!renderer || !scene || !camera || animationFrameId !== null) {
      return;
    }

    const activeRenderer = renderer;
    const activeScene = scene;
    const activeCamera = camera;

    const renderFrame = (): void => {
      animationFrameId = window.requestAnimationFrame(renderFrame);

      const deltaSeconds = clock.getDelta();

      updateBaseAnimation(deltaSeconds);

      // Passive blink runs independently of body animation
      passiveBlink?.update(deltaSeconds);

      // Passive mouth idle runs independently; suppressed during speech
      passiveMouth?.update(deltaSeconds);

      // Passive eye drift — natural micro-saccades and gaze wandering
      passiveEyeDrift?.update(deltaSeconds);

      // Passive emotion layer for smooth facial state transitions
      passiveEmotion?.update(deltaSeconds);

      if (currentAvatar?.vrm) {
        currentAvatar.vrm.update(deltaSeconds);
      }

      // Per-frame floor grounding: root clamp + per-leg IK (Unity "Foot IK" equivalent)
      if (currentAvatar?.vrm && activeBaseAnimation) {
        applyFloorGrounding(currentAvatar.root, currentAvatar.vrm);
      }

      if (rigOverlayEnabled) {
        syncRigOverlayHelper();
      }

      orbitControls?.update();

      activeRenderer.render(activeScene, activeCamera);
    };

    renderFrame();
  }

  function stopRenderLoop(): void {
    if (animationFrameId !== null) {
      window.cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
  }

  function syncOrbitControlsInteraction(mountPoints: AvatarRuntimeMountPoints | null): void {
    if (!orbitControls) {
      return;
    }

    const isDisplayViewer = mountPoints?.viewerVariant === "display";

    orbitControls.enablePan = isDisplayViewer;
    orbitControls.mouseButtons.RIGHT = isDisplayViewer ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
  }

  function ensureRenderer(mountPoints: AvatarRuntimeMountPoints | null): void {
    if (renderer || !viewportElement) {
      syncOrbitControlsInteraction(mountPoints);
      return;
    }

    scene = new THREE.Scene();
    scene.background = new THREE.Color("#09111a");
    camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
    camera.position.set(0, 1.3, 3.2);

    const ambientLight = new THREE.HemisphereLight("#f8fbff", "#16202d", 1.65);
    const keyLight = new THREE.DirectionalLight("#ffffff", 1.2);
    keyLight.position.set(1.6, 2.2, 2.8);
    const fillLight = new THREE.DirectionalLight("#86c8ff", 0.55);
    fillLight.position.set(-1.8, 1.1, -1.2);

    scene.add(ambientLight, keyLight, fillLight);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = "avatar-stage__canvas avatar-stage__canvas--interactive";
    renderer.domElement.style.touchAction = "none";
    orbitControls = new OrbitControls(camera, renderer.domElement);
    orbitControls.enableDamping = true;
    orbitControls.dampingFactor = 0.08;
    orbitControls.rotateSpeed = 0.72;
    orbitControls.zoomSpeed = 0.9;
    orbitControls.minDistance = 0.05;
    orbitControls.minPolarAngle = THREE.MathUtils.degToRad(70);
    orbitControls.maxPolarAngle = THREE.MathUtils.degToRad(110);
    orbitControls.minAzimuthAngle = Number.NEGATIVE_INFINITY;
    orbitControls.maxAzimuthAngle = Number.POSITIVE_INFINITY;
    syncOrbitControlsInteraction(mountPoints);
    viewportElement.replaceChildren(renderer.domElement);
    handleResize();
    startRenderLoop();
  }

  function fitCameraToAvatar(root: THREE.Object3D): void {
    if (!camera) {
      return;
    }

    root.updateWorldMatrix(true, true);

    const bounds = new THREE.Box3().setFromObject(root);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const verticalHalfFovRadians = THREE.MathUtils.degToRad(camera.fov * 0.5);
    const horizontalHalfFovRadians = Math.atan(Math.tan(verticalHalfFovRadians) * camera.aspect);
    const horizontalSpan = Math.max(size.x, size.z, 0.7);
    const verticalDistance = (Math.max(size.y, 1.4) * 0.58 + 0.28) / Math.tan(verticalHalfFovRadians);
    const horizontalDistance = (horizontalSpan * 0.68 + 0.2) / Math.tan(horizontalHalfFovRadians);
    const lookTargetY = Math.max(center.y, 0.9);
    const cameraDistance = Math.max(verticalDistance, horizontalDistance, 2.6);
    const lookTarget = new THREE.Vector3(center.x, lookTargetY, center.z);

    camera.position.set(center.x, lookTargetY + size.y * 0.02, center.z - cameraDistance * 1.04);

    if (orbitControls) {
      orbitControls.target.copy(lookTarget);
      orbitControls.minDistance = 0.05;
      orbitControls.maxDistance = Math.max(cameraDistance * 1.55, orbitControls.minDistance + 0.8);
      orbitControls.update();
      return;
    }

    camera.lookAt(lookTarget);
  }

  function frameLoadedAvatar(avatar: LoadedAvatar): void {
    avatar.vrm?.update(0);
    applyDebugProfileView(avatar);
    fitCameraToAvatar(avatar.anchorRoot);
  }

  async function loadMountedCharacter(character: CharacterManifestSummary, requestId: number): Promise<void> {
    if (!scene) {
      return;
    }

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser, { autoUpdateHumanBones: true }));

    updateSnapshot({
      currentCharacterId: character.characterId,
      currentModelUrl: character.assets.modelUrl,
      loadState: "loading",
      error: null
    });

    try {
      const gltf = await loader.loadAsync(character.assets.modelUrl);

      const activeScene = scene;

      if (requestId !== activeLoadRequestId || !activeScene) {
        return;
      }

      const vrm = (gltf.userData.vrm as VRM | undefined) ?? null;
      const root = vrm?.scene ?? gltf.scene;
      const anchorRoot = new THREE.Group();

  vrm?.update(0);

      anchorRoot.name = root.name ? `${root.name}_anchor` : "avatar_anchor";
      anchorRoot.add(root);
  groundAvatarRootToFloor(root, vrm, "load");

      clearCurrentAvatar();
      activeScene.add(anchorRoot);
      const frontProfileQuaternion = resolveFrontProfileQuaternion({
        anchorRoot,
        anchorBaselineQuaternion: anchorRoot.quaternion.clone(),
        root,
        vrm
      });
      currentAvatar = {
        anchorRoot,
        anchorBaselineQuaternion: anchorRoot.quaternion.clone(),
        frontProfileQuaternion,
        root,
        vrm
      };

      // Create VRMA playback bridge for this VRM
      if (vrmaPlayback) {
        vrmaPlayback.dispose();
        vrmaPlayback = null;
      }
      if (vrm) {
        vrmaPlayback = createVrmaPlayback(vrm, root);
      }

      // Create passive blink controller for this VRM
      if (passiveBlink) {
        passiveBlink.dispose();
        passiveBlink = null;
      }
      if (vrm) {
        passiveBlink = createPassiveBlinkController(vrm);
      }

      // Create passive mouth controller for this VRM
      if (passiveMouth) {
        passiveMouth.dispose();
        passiveMouth = null;
      }
      if (vrm) {
        passiveMouth = createPassiveMouthController(vrm);
      }

      // Create passive eye drift controller for this VRM
      if (passiveEyeDrift) {
        passiveEyeDrift.dispose();
        passiveEyeDrift = null;
      }
      if (vrm) {
        passiveEyeDrift = createPassiveEyeDriftController(vrm);
      }

      // Create passive emotion controller for this VRM
      if (passiveEmotion) {
        passiveEmotion.dispose();
        passiveEmotion = null;
      }
      if (vrm) {
        passiveEmotion = createPassiveEmotionController(vrm);
        passiveEmotion.setEmotion(snapshot.activeEmotion);
      }

      syncRigOverlayHelper();
      frameLoadedAvatar(currentAvatar);

      const nextBaseAnimation = snapshot.pendingAnimation ?? snapshot.baseAnimation ?? DEFAULT_BASE_ANIMATION_COMMAND;

      if (nextBaseAnimation) {
        activateBaseAnimation(nextBaseAnimation);
      }

      updateSnapshot({
        loadState: "ready",
        error: null
      });
    } catch (error: unknown) {
      if (requestId !== activeLoadRequestId) {
        return;
      }

      clearCurrentAvatar();
      updateSnapshot({
        loadState: "error",
        error: error instanceof Error ? error.message : "The default VRM could not be loaded."
      });
    }
  }

  function loadCurrentCharacterIfMounted(): Promise<void> {
    if (!snapshot.mounted || !currentCharacter) {
      return Promise.resolve();
    }

    const requestedCharacter = currentCharacter;
    const requestedLoadTargetKey = createCharacterLoadTargetKey(requestedCharacter);

    if (
      snapshot.loadState === "ready" &&
      snapshot.currentCharacterId === requestedCharacter.characterId &&
      snapshot.currentModelUrl === requestedCharacter.assets.modelUrl
    ) {
      return Promise.resolve();
    }

    if (snapshot.loadState === "loading" && activeLoadTargetKey === requestedLoadTargetKey && activeLoadPromise) {
      return activeLoadPromise;
    }

    const requestId = activeLoadRequestId + 1;
    activeLoadRequestId = requestId;

    activeLoadTargetKey = requestedLoadTargetKey;

    const loadPromise = loadMountedCharacter(requestedCharacter, requestId).finally(() => {
      if (requestId !== activeLoadRequestId) {
        return;
      }

      activeLoadPromise = null;
      activeLoadTargetKey = null;
    });

    activeLoadPromise = loadPromise;

    return loadPromise;
  }

  return {
    mount(mountPoints) {
      viewportElement = document.getElementById(mountPoints.viewportElementId);

      if (!viewportElement) {
        updateSnapshot({
          mounted: false,
          mountPoints,
          loadState: "error",
          error: `Avatar viewport '${mountPoints.viewportElementId}' was not found.`
        });
        return;
      }

      ensureRenderer(mountPoints);
      window.addEventListener("resize", handleResize);
      updateSnapshot({
        mounted: true,
        mountPoints,
        error: null
      });

      void loadCurrentCharacterIfMounted();
    },

    unmount() {
      window.removeEventListener("resize", handleResize);
      stopRenderLoop();
      clearCurrentAvatar();

      if (viewportElement) {
        viewportElement.replaceChildren();
      }

      renderer?.dispose();
      orbitControls?.dispose();
      orbitControls = null;
      renderer = null;
      scene = null;
      camera = null;
      viewportElement = null;
      updateSnapshot({
        mounted: false,
        mountPoints: null,
        pendingAnimation: null,
        baseAnimation: null,
        loadState: currentCharacter ? "idle" : snapshot.loadState
      });
    },

    async loadCharacter(character) {
      currentCharacter = character;
      updateSnapshot({
        currentCharacterId: character.characterId,
        currentModelUrl: character.assets.modelUrl,
        pendingAnimation: null,
        baseAnimation: null,
        error: null
      });

      await loadCurrentCharacterIfMounted();
    },

    setState(state) {
      updateSnapshot({
        currentState: state
      });
    },

    setDebugProfileView(profileView) {
      debugProfileView = profileView;
      syncDebugProfileView();
    },

    setRigOverlayEnabled(enabled) {
      rigOverlayEnabled = enabled;
      syncRigOverlayHelper();
    },

    setAnimationPlaybackPath(playbackPath) {
      if (animationPlaybackPath === playbackPath) {
        return;
      }

      animationPlaybackPath = playbackPath;

      if (currentAvatar && activeBaseAnimation) {
        activateBaseAnimation(activeBaseAnimation.command);
      }
    },

    setEmotion(emotion) {
      setActiveEmotion(emotion);
    },

    beginSpeechReaction(input) {
      beginSpeechReaction(input);
    },

    clearSpeechReaction() {
      clearSpeechReaction();
    },

    play(command) {
      if (!command) {
        stopBaseAnimation();
        updateSnapshot({
          pendingAnimation: null,
          baseAnimation: null,
          error: null
        });
        return;
      }

      activateBaseAnimation(command);
    },

    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    snapshot() {
      return {
        ...snapshot
      };
    }
  };
}