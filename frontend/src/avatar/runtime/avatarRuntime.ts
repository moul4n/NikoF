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
import {
  resolveCanonicalSharedSemanticAnimationId,
  resolveSharedSemanticAnimationPayload,
  DEFAULT_BASE_ANIMATION_COMMAND
} from "./defaultBaseAnimation";
import {
  type HumanoidChannelPlayback,
  type HumanoidChannelPlaybackDebugPoseSnapshot
} from "./humanoidChannelPlayback";
import {
  isIdleSemanticAnimationPayload,
  resolveAvatarRuntimePlayback,
  type AvatarRuntimeResolvedPlayback
} from "./avatarRuntimePlaybackRoute";
import { createVrmaPlayback, type VrmaPlaybackBridge, type VrmaPlaybackDebugSnapshot } from "./vrmaPlayback";
import {
  createOfficialMixamoPlayback,
  type OfficialMixamoPlaybackBridge,
  type OfficialMixamoPlaybackDebugSnapshot
} from "./officialMixamoPlayback";
import { probeVrmaAsset } from "./vrmaAssetResolution";
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
export type AvatarAnimationPlaybackPath = "mixer" | "vrma" | "official";
export type AvatarRuntimeEmotionName = PassiveEmotionName;
type VRMHumanBoneNameValue = (typeof VRMHumanBoneName)[keyof typeof VRMHumanBoneName];
type AvatarLowerBodyRotationBoneName =
  | "hips"
  | "leftUpperLeg"
  | "leftLowerLeg"
  | "leftFoot"
  | "rightUpperLeg"
  | "rightLowerLeg"
  | "rightFoot";

type AvatarRuntimeListener = () => void;

const VRM_MOUTH_EXPRESSION_NAMES = ["aa", "ih", "ou", "ee", "oh"] as const;
const VRM_MOUTH_EXPRESSION_NAME_SET = new Set<string>(VRM_MOUTH_EXPRESSION_NAMES);
const LOWER_BODY_ROTATION_BONES: Array<{
  debugName: AvatarLowerBodyRotationBoneName;
  vrmBoneName: VRMHumanBoneNameValue;
}> = [
  { debugName: "hips", vrmBoneName: VRMHumanBoneName.Hips },
  { debugName: "leftUpperLeg", vrmBoneName: VRMHumanBoneName.LeftUpperLeg },
  { debugName: "leftLowerLeg", vrmBoneName: VRMHumanBoneName.LeftLowerLeg },
  { debugName: "leftFoot", vrmBoneName: VRMHumanBoneName.LeftFoot },
  { debugName: "rightUpperLeg", vrmBoneName: VRMHumanBoneName.RightUpperLeg },
  { debugName: "rightLowerLeg", vrmBoneName: VRMHumanBoneName.RightLowerLeg },
  { debugName: "rightFoot", vrmBoneName: VRMHumanBoneName.RightFoot }
];
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

interface AvatarLowerBodyDebugSnapshot {
  elapsedSeconds: number | null;
  rootPosition: [number, number, number] | null;
  anchorPosition: [number, number, number] | null;
  hipsPosition: [number, number, number] | null;
  leftFootPosition: [number, number, number] | null;
  rightFootPosition: [number, number, number] | null;
  leftToesPosition: [number, number, number] | null;
  rightToesPosition: [number, number, number] | null;
}

interface AvatarLowerBodyRangeDebugSnapshot {
  sampleCount: number;
  hipsY: { min: number; max: number; range: number } | null;
  leftFootY: { min: number; max: number; range: number } | null;
  rightFootY: { min: number; max: number; range: number } | null;
  leftToesY: { min: number; max: number; range: number } | null;
  rightToesY: { min: number; max: number; range: number } | null;
}

interface AvatarLowerBodyRotationBoneSnapshot {
  localQuaternion: [number, number, number, number] | null;
  worldQuaternion: [number, number, number, number] | null;
}

interface AvatarLowerBodyRotationDebugSnapshot {
  elapsedSeconds: number | null;
  bones: Record<AvatarLowerBodyRotationBoneName, AvatarLowerBodyRotationBoneSnapshot>;
}

interface AvatarLowerBodyRotationAngleRangeMetric {
  maxAngleDeltaDeg: number | null;
  currentAngleDeltaDeg: number | null;
}

interface AvatarLowerBodyRotationRangeBoneSnapshot {
  local: AvatarLowerBodyRotationAngleRangeMetric;
  world: AvatarLowerBodyRotationAngleRangeMetric;
}

interface AvatarLowerBodyRotationRangeDebugSnapshot {
  sampleCount: number;
  bones: Record<AvatarLowerBodyRotationBoneName, AvatarLowerBodyRotationRangeBoneSnapshot>;
}

interface AvatarPlaybackProgressDebugSnapshot {
  renderFrameCount: number;
  lowerBodySampleCount: number;
  activeAnimationId: string | null;
  playbackPath: AvatarAnimationPlaybackPath | null;
  elapsedSeconds: number | null;
  vrma: VrmaPlaybackDebugSnapshot | null;
  official: OfficialMixamoPlaybackDebugSnapshot | null;
}

interface AvatarRuntimeDebugApi {
  getProfileOrientationSnapshot: () => AvatarProfileOrientationSnapshot | null;
  getHumanoidPlayback: () => AvatarHumanoidPlaybackDebugSnapshot;
  getLowerBodySnapshot: () => AvatarLowerBodyDebugSnapshot | null;
  getLowerBodyRange: (sampleCount?: number) => AvatarLowerBodyRangeDebugSnapshot;
  getLowerBodyRotationSnapshot: () => AvatarLowerBodyRotationDebugSnapshot | null;
  getLowerBodyRotationRange: (sampleCount?: number) => AvatarLowerBodyRotationRangeDebugSnapshot;
  getPlaybackProgress: () => AvatarPlaybackProgressDebugSnapshot;
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
  let animationPlaybackPath: AvatarAnimationPlaybackPath = "vrma";
  let vrmaPlayback: VrmaPlaybackBridge | null = null;
  let officialPlayback: OfficialMixamoPlaybackBridge | null = null;
  let passiveBlink: PassiveBlinkController | null = null;
  let passiveMouth: PassiveMouthController | null = null;
  let passiveEyeDrift: PassiveEyeDriftController | null = null;
  let passiveEmotion: PassiveEmotionController | null = null;
  let activeLoadRequestId = 0;
  let activeLoadTargetKey: string | null = null;
  let activeLoadPromise: Promise<void> | null = null;
  let speechReactionTimeoutIds: number[] = [];
  let activeSpeechExpressionName: string | null = null;
  let renderFrameCount = 0;
  const lowerBodyDebugHistory: Array<{
    elapsedSeconds: number;
    hipsY: number | null;
    leftFootY: number | null;
    rightFootY: number | null;
    leftToesY: number | null;
    rightToesY: number | null;
  }> = [];
  const lowerBodyRotationDebugHistory: Array<{
    elapsedSeconds: number;
    bones: Record<AvatarLowerBodyRotationBoneName, AvatarLowerBodyRotationBoneSnapshot>;
  }> = [];
  const maxLowerBodyDebugHistory = 360;
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

  function roundWorldPosition(node: THREE.Object3D | null | undefined): [number, number, number] | null {
    if (!node) {
      return null;
    }

    return roundVector3(node.getWorldPosition(new THREE.Vector3()));
  }

  function roundQuaternionObject(quaternion: THREE.Quaternion | null | undefined): [number, number, number, number] | null {
    if (!quaternion) {
      return null;
    }

    return [
      roundComparisonNumber(quaternion.x),
      roundComparisonNumber(quaternion.y),
      roundComparisonNumber(quaternion.z),
      roundComparisonNumber(quaternion.w)
    ];
  }

  function createEmptyLowerBodyRotationBoneRecord(): Record<AvatarLowerBodyRotationBoneName, AvatarLowerBodyRotationBoneSnapshot> {
    return {
      hips: { localQuaternion: null, worldQuaternion: null },
      leftUpperLeg: { localQuaternion: null, worldQuaternion: null },
      leftLowerLeg: { localQuaternion: null, worldQuaternion: null },
      leftFoot: { localQuaternion: null, worldQuaternion: null },
      rightUpperLeg: { localQuaternion: null, worldQuaternion: null },
      rightLowerLeg: { localQuaternion: null, worldQuaternion: null },
      rightFoot: { localQuaternion: null, worldQuaternion: null }
    };
  }

  function collectLowerBodyDebugSnapshot(): AvatarLowerBodyDebugSnapshot | null {
    if (!currentAvatar) {
      return null;
    }

    const vrm = currentAvatar.vrm;
    const hipsNode = vrm?.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Hips) ?? null;
    const leftFootNode = vrm?.humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftFoot) ?? null;
    const rightFootNode = vrm?.humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightFoot) ?? null;
    const leftToesNode = vrm?.humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftToes) ?? null;
    const rightToesNode = vrm?.humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightToes) ?? null;

    return {
      elapsedSeconds: activeBaseAnimation?.elapsedSeconds ?? null,
      rootPosition: roundWorldPosition(currentAvatar.root),
      anchorPosition: roundWorldPosition(currentAvatar.anchorRoot),
      hipsPosition: roundWorldPosition(hipsNode),
      leftFootPosition: roundWorldPosition(leftFootNode),
      rightFootPosition: roundWorldPosition(rightFootNode),
      leftToesPosition: roundWorldPosition(leftToesNode),
      rightToesPosition: roundWorldPosition(rightToesNode)
    };
  }

  function collectLowerBodyRotationDebugSnapshot(): AvatarLowerBodyRotationDebugSnapshot | null {
    if (!currentAvatar?.vrm) {
      return null;
    }

    const bones = createEmptyLowerBodyRotationBoneRecord();

    for (const { debugName, vrmBoneName } of LOWER_BODY_ROTATION_BONES) {
      const node = currentAvatar.vrm.humanoid.getNormalizedBoneNode(vrmBoneName) ?? null;
      const worldQuaternion = node?.getWorldQuaternion(new THREE.Quaternion()) ?? null;
      bones[debugName] = {
        localQuaternion: roundQuaternionObject(node?.quaternion),
        worldQuaternion: roundQuaternionObject(worldQuaternion)
      };
    }

    return {
      elapsedSeconds: activeBaseAnimation?.elapsedSeconds ?? null,
      bones
    };
  }

  function recordLowerBodyDebugSample(): void {
    const snapshot = collectLowerBodyDebugSnapshot();
    const rotationSnapshot = collectLowerBodyRotationDebugSnapshot();

    if (!snapshot) {
      lowerBodyDebugHistory.length = 0;
      lowerBodyRotationDebugHistory.length = 0;
      return;
    }

    lowerBodyDebugHistory.push({
      elapsedSeconds: snapshot.elapsedSeconds ?? 0,
      hipsY: snapshot.hipsPosition?.[1] ?? null,
      leftFootY: snapshot.leftFootPosition?.[1] ?? null,
      rightFootY: snapshot.rightFootPosition?.[1] ?? null,
      leftToesY: snapshot.leftToesPosition?.[1] ?? null,
      rightToesY: snapshot.rightToesPosition?.[1] ?? null
    });

    if (rotationSnapshot) {
      lowerBodyRotationDebugHistory.push({
        elapsedSeconds: rotationSnapshot.elapsedSeconds ?? 0,
        bones: rotationSnapshot.bones
      });
    }

    if (lowerBodyDebugHistory.length > maxLowerBodyDebugHistory) {
      lowerBodyDebugHistory.splice(0, lowerBodyDebugHistory.length - maxLowerBodyDebugHistory);
    }

    if (lowerBodyRotationDebugHistory.length > maxLowerBodyDebugHistory) {
      lowerBodyRotationDebugHistory.splice(0, lowerBodyRotationDebugHistory.length - maxLowerBodyDebugHistory);
    }
  }

  function buildLowerBodyRangeSnapshot(values: Array<number | null>): { min: number; max: number; range: number } | null {
    const numericValues = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));

    if (numericValues.length === 0) {
      return null;
    }

    const min = Math.min(...numericValues);
    const max = Math.max(...numericValues);
    return {
      min: roundComparisonNumber(min),
      max: roundComparisonNumber(max),
      range: roundComparisonNumber(max - min)
    };
  }

  function getLowerBodyRangeDebugSnapshot(sampleCount = 120): AvatarLowerBodyRangeDebugSnapshot {
    const clampedSampleCount = Math.max(1, Math.floor(sampleCount));
    const recentSamples = lowerBodyDebugHistory.slice(-clampedSampleCount);

    return {
      sampleCount: recentSamples.length,
      hipsY: buildLowerBodyRangeSnapshot(recentSamples.map((sample) => sample.hipsY)),
      leftFootY: buildLowerBodyRangeSnapshot(recentSamples.map((sample) => sample.leftFootY)),
      rightFootY: buildLowerBodyRangeSnapshot(recentSamples.map((sample) => sample.rightFootY)),
      leftToesY: buildLowerBodyRangeSnapshot(recentSamples.map((sample) => sample.leftToesY)),
      rightToesY: buildLowerBodyRangeSnapshot(recentSamples.map((sample) => sample.rightToesY))
    };
  }

  function buildLowerBodyRotationAngleRangeMetric(
    values: Array<[number, number, number, number] | null>
  ): AvatarLowerBodyRotationAngleRangeMetric {
    const firstValue = values.find((value): value is [number, number, number, number] => value !== null);
    const currentValue = [...values].reverse().find((value): value is [number, number, number, number] => value !== null);

    if (!firstValue || !currentValue) {
      return {
        maxAngleDeltaDeg: null,
        currentAngleDeltaDeg: null
      };
    }

    const firstQuaternion = new THREE.Quaternion(...firstValue);
    let maxAngleDeltaDeg = 0;

    for (const value of values) {
      if (!value) {
        continue;
      }

      const angleDeltaDeg = THREE.MathUtils.radToDeg(firstQuaternion.angleTo(new THREE.Quaternion(...value)));
      if (angleDeltaDeg > maxAngleDeltaDeg) {
        maxAngleDeltaDeg = angleDeltaDeg;
      }
    }

    return {
      maxAngleDeltaDeg: roundComparisonNumber(maxAngleDeltaDeg),
      currentAngleDeltaDeg: roundComparisonNumber(
        THREE.MathUtils.radToDeg(firstQuaternion.angleTo(new THREE.Quaternion(...currentValue)))
      )
    };
  }

  function createEmptyLowerBodyRotationRangeBoneRecord(): Record<AvatarLowerBodyRotationBoneName, AvatarLowerBodyRotationRangeBoneSnapshot> {
    return {
      hips: { local: { maxAngleDeltaDeg: null, currentAngleDeltaDeg: null }, world: { maxAngleDeltaDeg: null, currentAngleDeltaDeg: null } },
      leftUpperLeg: { local: { maxAngleDeltaDeg: null, currentAngleDeltaDeg: null }, world: { maxAngleDeltaDeg: null, currentAngleDeltaDeg: null } },
      leftLowerLeg: { local: { maxAngleDeltaDeg: null, currentAngleDeltaDeg: null }, world: { maxAngleDeltaDeg: null, currentAngleDeltaDeg: null } },
      leftFoot: { local: { maxAngleDeltaDeg: null, currentAngleDeltaDeg: null }, world: { maxAngleDeltaDeg: null, currentAngleDeltaDeg: null } },
      rightUpperLeg: { local: { maxAngleDeltaDeg: null, currentAngleDeltaDeg: null }, world: { maxAngleDeltaDeg: null, currentAngleDeltaDeg: null } },
      rightLowerLeg: { local: { maxAngleDeltaDeg: null, currentAngleDeltaDeg: null }, world: { maxAngleDeltaDeg: null, currentAngleDeltaDeg: null } },
      rightFoot: { local: { maxAngleDeltaDeg: null, currentAngleDeltaDeg: null }, world: { maxAngleDeltaDeg: null, currentAngleDeltaDeg: null } }
    };
  }

  function getLowerBodyRotationRangeDebugSnapshot(sampleCount = 120): AvatarLowerBodyRotationRangeDebugSnapshot {
    const clampedSampleCount = Math.max(1, Math.floor(sampleCount));
    const recentSamples = lowerBodyRotationDebugHistory.slice(-clampedSampleCount);
    const bones = createEmptyLowerBodyRotationRangeBoneRecord();

    for (const { debugName } of LOWER_BODY_ROTATION_BONES) {
      bones[debugName] = {
        local: buildLowerBodyRotationAngleRangeMetric(
          recentSamples.map((sample) => sample.bones[debugName].localQuaternion)
        ),
        world: buildLowerBodyRotationAngleRangeMetric(
          recentSamples.map((sample) => sample.bones[debugName].worldQuaternion)
        )
      };
    }

    return {
      sampleCount: recentSamples.length,
      bones
    };
  }

  function getPlaybackProgressDebugSnapshot(): AvatarPlaybackProgressDebugSnapshot {
    return {
      renderFrameCount,
      lowerBodySampleCount: lowerBodyDebugHistory.length,
      activeAnimationId: activeBaseAnimation?.command.id ?? null,
      playbackPath: activeBaseAnimation?.playbackPath ?? null,
      elapsedSeconds: activeBaseAnimation?.elapsedSeconds ?? null,
      vrma: activeBaseAnimation?.playbackPath === "vrma" ? vrmaPlayback?.getDebugSnapshot() ?? null : null,
      official: activeBaseAnimation?.playbackPath === "official" ? officialPlayback?.getDebugSnapshot() ?? null : null,
    };
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
      fitCameraToAvatar(currentAvatar);
      emitChange();
      return;
    }

    restoreBaseAnimationPose(activeBaseAnimation);
    applyDebugProfileView(currentAvatar);
    updateBaseAnimation(0);
    fitCameraToAvatar(currentAvatar);
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
    root.updateWorldMatrix(true, true);

    // Use toes as the ground contact point (not ankle bones which sit ~90mm above floor).
    // This matches how the reference three-vrm examples handle grounding — the toe bones
    // are the lowest point of the skeleton and represent actual floor contact.
    const toeBoneNames = [VRMHumanBoneName.LeftToes, VRMHumanBoneName.RightToes] as const;
    const toeHeights = vrm
      ? toeBoneNames
          .map((boneName) => {
            const node = resolveRigOverlayBoneNode(vrm, boneName);
            return node ? node.getWorldPosition(new THREE.Vector3()).y : null;
          })
          .filter((h): h is number => h !== null && Number.isFinite(h))
      : [];

    const floorHeight = toeHeights.length > 0
      ? Math.min(...toeHeights)
      : new THREE.Box3().setFromObject(root).min.y;

    if (!Number.isFinite(floorHeight) || Math.abs(floorHeight) <= 1e-4) {
      return;
    }

    root.position.y -= floorHeight;
    root.updateWorldMatrix(true, true);
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
      getHumanoidPlayback: () => getHumanoidPlaybackDebugSnapshot(),
      getLowerBodySnapshot: () => collectLowerBodyDebugSnapshot(),
      getLowerBodyRange: (sampleCount?: number) => getLowerBodyRangeDebugSnapshot(sampleCount),
      getLowerBodyRotationSnapshot: () => collectLowerBodyRotationDebugSnapshot(),
      getLowerBodyRotationRange: (sampleCount?: number) => getLowerBodyRotationRangeDebugSnapshot(sampleCount),
      getPlaybackProgress: () => getPlaybackProgressDebugSnapshot(),
    });

    Object.defineProperty(window, "__NIKOF_AVATAR_DEBUG__", {
      configurable: true,
      value: debugApi,
      writable: false
    });

    console.info(
      "[vrma:debug] Debug API available at window.__NIKOF_AVATAR_DEBUG__"
    );
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
    const payload = resolveSharedSemanticAnimationPayload(command);
    return payload ?? null;
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

    if (activeBaseAnimation.playbackPath === "vrma") {
      vrmaPlayback?.stopAll();
    }

    if (activeBaseAnimation.playbackPath === "official") {
      officialPlayback?.stopAll();
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
      if (activeBaseAnimation.command.playback === "loop") {
        activeBaseAnimation.elapsedSeconds += deltaSeconds;
      } else {
        const cycleDurationSeconds = Math.max(resolveFinalFrameElapsedSeconds(activeBaseAnimation.payload), 1 / 30);
        activeBaseAnimation.elapsedSeconds = Math.min(activeBaseAnimation.elapsedSeconds + deltaSeconds, cycleDurationSeconds);
      }

      vrmaPlayback.update(deltaSeconds);
      return;
    }

    if (activeBaseAnimation.playbackPath === "official" && officialPlayback) {
      if (activeBaseAnimation.command.playback === "loop") {
        activeBaseAnimation.elapsedSeconds += deltaSeconds;
      } else {
        const cycleDurationSeconds = Math.max(resolveFinalFrameElapsedSeconds(activeBaseAnimation.payload), 1 / 30);
        activeBaseAnimation.elapsedSeconds = Math.min(activeBaseAnimation.elapsedSeconds + deltaSeconds, cycleDurationSeconds);
      }

      officialPlayback.update(deltaSeconds);
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
    const canonicalCommand =
      command.source === "shared"
        ? {
            ...command,
            id: resolveCanonicalSharedSemanticAnimationId(command.id)
          }
        : command;
    const resolvedPayload = resolveBaseAnimationPayload(canonicalCommand);

    if (!resolvedPayload || !currentAvatar) {
      stopBaseAnimation();
      updateSnapshot({
        pendingAnimation: canonicalCommand,
        baseAnimation: resolvedPayload ? canonicalCommand : snapshot.baseAnimation,
        error: resolvedPayload
          ? null
          : `Semantic animation '${canonicalCommand.id}' is not yet backed by a web runtime payload.`
      });
      return;
    }

    stopBaseAnimation();
    const resolvedPlayback = resolveHumanoidPlayback(currentAvatar.vrm, resolvedPayload);
    activeBaseAnimation = {
      command: canonicalCommand,
      payload: resolvedPayload,
      playbackPath: resolvedPlayback.playbackPath,
      root: currentAvatar.root,
      baselinePosition: currentAvatar.root.position.clone(),
      baselineQuaternion: currentAvatar.root.quaternion.clone(),
      humanoidPlayback: resolvedPlayback.playback,
      elapsedSeconds: 0,
    };

    if (resolvedPlayback.playbackPath === "official" && officialPlayback) {
      const playbackBridge = officialPlayback;
      const expectedCommandId = canonicalCommand.id;
      const sourcePath = resolvedPayload.sourceAsset?.path?.trim() ?? "";
      const sourceUrl = sourcePath.startsWith("/") ? sourcePath : `/${sourcePath}`;

      const fallbackToMixer = (): void => {
        if (!activeBaseAnimation || activeBaseAnimation.command.id !== expectedCommandId || !currentAvatar) {
          return;
        }

        const fallbackPlayback = resolveAvatarRuntimePlayback(currentAvatar.vrm, resolvedPayload, "mixer");
        activeBaseAnimation.playbackPath = fallbackPlayback.playbackPath;
        activeBaseAnimation.humanoidPlayback = fallbackPlayback.playback;
        activeBaseAnimation.humanoidPlayback?.apply(0);
        activeBaseAnimation.root.updateMatrixWorld(true);
        activeBaseAnimation.baselinePosition.copy(activeBaseAnimation.root.position);
      };

      if (!sourcePath.toLowerCase().endsWith(".fbx")) {
        fallbackToMixer();
        return;
      }

      playbackBridge.loadClip(sourceUrl, canonicalCommand.id).then(() => {
        if (!activeBaseAnimation || activeBaseAnimation.command.id !== expectedCommandId) {
          return;
        }

        playbackBridge.play(canonicalCommand.id, {
          loop: canonicalCommand.playback === "loop"
        });
      }).catch((err) => {
        console.warn(`[activateBase] Official Mixamo load failed for ${canonicalCommand.id}:`, err);
        fallbackToMixer();
      });

      return;
    }

    // VRMA path: load and play the .vrma file via three-vrm-animation
    if (resolvedPlayback.playbackPath === "vrma" && vrmaPlayback) {
      const playbackBridge = vrmaPlayback;
      const expectedCommandId = canonicalCommand.id;

      const fallbackToMixer = (): void => {
        if (!activeBaseAnimation || activeBaseAnimation.command.id !== expectedCommandId || !currentAvatar) {
          return;
        }

        const fallbackPlayback = resolveAvatarRuntimePlayback(currentAvatar.vrm, resolvedPayload, "mixer");
        activeBaseAnimation.playbackPath = fallbackPlayback.playbackPath;
        activeBaseAnimation.humanoidPlayback = fallbackPlayback.playback;
        activeBaseAnimation.humanoidPlayback?.apply(0);
        activeBaseAnimation.root.updateMatrixWorld(true);
        activeBaseAnimation.baselinePosition.copy(activeBaseAnimation.root.position);
      };

      probeVrmaAsset(canonicalCommand.id, snapshot.currentCharacterId ?? undefined).then((resolution) => {
        if (!resolution) {
          console.warn(`[activateBase] No VRMA asset found for ${canonicalCommand.id}; falling back to mixer playback.`);
          fallbackToMixer();
          return;
        }

        playbackBridge.loadVrma(resolution.url, canonicalCommand.id).then(() => {
          if (!activeBaseAnimation || activeBaseAnimation.command.id !== expectedCommandId || !currentAvatar) {
            return;
          }

          playbackBridge.play(canonicalCommand.id, {
            loop: canonicalCommand.playback === "loop"
          });

          // For in-place VRMA clips, preserve the load-time ground offset.
          // Re-grounding after frame 0 would treat authored hip/foot motion as
          // world motion and lift the entire avatar.
          playbackBridge.update(0);
          currentAvatar.vrm?.update(0);
          activeBaseAnimation.root.updateMatrixWorld(true);
        }).catch((err) => {
          console.warn(`[activateBase] VRMA load failed for ${canonicalCommand.id}:`, err);
          fallbackToMixer();
        });
      }).catch(() => {
        fallbackToMixer();
      });
    } else {
      // Mixer path: apply frame 0 so skeleton is in posed position
      activeBaseAnimation!.humanoidPlayback?.apply(0);
      activeBaseAnimation!.root.updateMatrixWorld(true);
      activeBaseAnimation!.baselinePosition.copy(activeBaseAnimation!.root.position);
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
      if (officialPlayback) { officialPlayback.dispose(); officialPlayback = null; }
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
    if (officialPlayback) { officialPlayback.dispose(); officialPlayback = null; }
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
      fitCameraToAvatar(currentAvatar);
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
      renderFrameCount += 1;

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
        recordLowerBodyDebugSample();
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

  function fitCameraToAvatar(avatar: LoadedAvatar): void {
    if (!camera) {
      return;
    }

    const root = avatar.anchorRoot;
    root.updateWorldMatrix(true, true);

    const bounds = new THREE.Box3().setFromObject(root);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const isDisplayViewer = snapshot.mountPoints?.viewerVariant === "display";
    const verticalHalfFovRadians = THREE.MathUtils.degToRad(camera.fov * 0.5);
    const horizontalHalfFovRadians = Math.atan(Math.tan(verticalHalfFovRadians) * camera.aspect);
    let horizontalSpan = Math.max(size.x, size.z, 0.7);
    let verticalSpan = Math.max(size.y, 1.4);
    let lookTargetY = Math.max(center.y, 0.9);
    let cameraYOffset = size.y * 0.02;
    let cameraDistanceFloor = 2.6;
    let horizontalPadding = 0.68;
    let verticalPadding = 0.58;
    let verticalBias = 0.28;
    let depthMultiplier = 1.04;
    let displayVisibleVerticalSpan: number | null = null;

    if (isDisplayViewer) {
      const hipsNode = avatar.vrm?.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Hips) ?? null;
      const headNode =
        avatar.vrm?.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Head) ??
        avatar.vrm?.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Neck) ??
        avatar.vrm?.humanoid.getNormalizedBoneNode(VRMHumanBoneName.UpperChest) ??
        avatar.vrm?.humanoid.getNormalizedBoneNode(VRMHumanBoneName.Chest) ??
        null;

      if (hipsNode && headNode) {
        const hipsPosition = hipsNode.getWorldPosition(new THREE.Vector3());
        const headPosition = headNode.getWorldPosition(new THREE.Vector3());
        const framedBottomY = hipsPosition.y - 0.06;
        const framedTopY = Math.max(bounds.max.y, headPosition.y) + 0.12;
        const topViewportMargin = 0.045;
        const bottomViewportMargin = 0.02;
        const usableViewportHeight = Math.max(1 - topViewportMargin - bottomViewportMargin, 0.1);

        verticalSpan = Math.max(framedTopY - framedBottomY, 1);
        displayVisibleVerticalSpan = verticalSpan / usableViewportHeight;
        lookTargetY = framedBottomY + displayVisibleVerticalSpan * (0.5 - bottomViewportMargin);
        cameraYOffset = verticalSpan * 0.015;
      } else {
        const topViewportMargin = 0.05;
        const bottomViewportMargin = 0.03;
        const usableViewportHeight = Math.max(1 - topViewportMargin - bottomViewportMargin, 0.1);

        verticalSpan = Math.max(size.y * 0.62, 1);
        displayVisibleVerticalSpan = verticalSpan / usableViewportHeight;
        lookTargetY = bounds.min.y + displayVisibleVerticalSpan * (0.5 - bottomViewportMargin);
        cameraYOffset = verticalSpan * 0.015;
      }

      horizontalSpan = Math.max(size.x * 0.88, size.z, 0.7);
      cameraDistanceFloor = 2;
      horizontalPadding = 0.62;
      verticalPadding = 0.52;
      verticalBias = 0.18;
      depthMultiplier = 1;
    }

    const verticalDistance =
      displayVisibleVerticalSpan !== null
        ? (displayVisibleVerticalSpan * 0.5) / Math.tan(verticalHalfFovRadians)
        : (verticalSpan * verticalPadding + verticalBias) / Math.tan(verticalHalfFovRadians);
    const horizontalDistance = (horizontalSpan * horizontalPadding + 0.2) / Math.tan(horizontalHalfFovRadians);
    const cameraDistance =
      isDisplayViewer && displayVisibleVerticalSpan !== null
        ? Math.max(
            verticalDistance,
            Math.min(
              horizontalDistance,
              verticalDistance * THREE.MathUtils.clamp(1.08 + Math.max(camera.aspect - 1, 0) * 0.08, 1.08, 1.18)
            ),
            cameraDistanceFloor
          )
        : Math.max(verticalDistance, horizontalDistance, cameraDistanceFloor);
    const lookTarget = new THREE.Vector3(center.x, lookTargetY, center.z);

    camera.position.set(center.x, lookTargetY + cameraYOffset, center.z - cameraDistance * depthMultiplier);

    if (orbitControls) {
      orbitControls.target.copy(lookTarget);
      orbitControls.minDistance = 0.05;
      orbitControls.maxDistance = Math.max(cameraDistance * (isDisplayViewer ? 1.45 : 1.55), orbitControls.minDistance + 0.8);
      orbitControls.update();
      return;
    }

    camera.lookAt(lookTarget);
  }

  function frameLoadedAvatar(avatar: LoadedAvatar): void {
    avatar.vrm?.update(0);
    applyDebugProfileView(avatar);
    fitCameraToAvatar(avatar);
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
        vrm,
      };

      // Create VRMA playback bridge for this VRM
      if (vrmaPlayback) {
        vrmaPlayback.dispose();
        vrmaPlayback = null;
      }
      if (officialPlayback) {
        officialPlayback.dispose();
        officialPlayback = null;
      }
      if (vrm) {
        vrmaPlayback = createVrmaPlayback(vrm, root);
        officialPlayback = createOfficialMixamoPlayback(vrm);
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
