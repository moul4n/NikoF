import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMHumanBoneName, VRMLoaderPlugin, type VRM } from "@pixiv/three-vrm";
import type {
  SemanticAnimationCommand,
  SemanticAnimationRuntimePayload
} from "../../shared/types/animation";
import type {
  BackendSpeechMouthCueTrackDocument,
  BackendSpeechVisemeSlotDocument,
  CharacterId,
  CharacterManifestSummary,
  CharacterRuntimeState
} from "../../shared/types/character";
import {
  isIdleSemanticAnimationPayload,
  resolveCanonicalSharedSemanticAnimationId,
  resolveSharedSemanticAnimationPayload,
  DEFAULT_BASE_ANIMATION_COMMAND,
  SHARED_SEMANTIC_ANIMATION_SOURCE_FALLBACKS
} from "./defaultBaseAnimation";
import {
  createAnimationPlayback,
  resolveAnimationClipSourceKind,
  type AnimationClipSourceKind,
  type AnimationPlaybackBridge,
  type AnimationPlaybackDebugSnapshot
} from "./animationPlayback";
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
const SPEECH_SILENCE_EXPRESSION_NAME = "__nikof_silence__";
const SPEECH_EXPRESSION_BLEND_WINDOW_MS = 64;
const SPEECH_EXPRESSION_MIN_WEIGHT = 0.001;
const SPEECH_SHORT_SILENCE_SKIP_MS = 120;
const SPEECH_SHORT_GAP_BRIDGE_MS = 90;
const MIN_BASE_ANIMATION_TRANSITION_MS = 260;
const MAX_BASE_ANIMATION_TRANSITION_MS = 520;
const LOOP_BASE_ANIMATION_TRANSITION_MS = 320;
const MIN_RETURN_TO_IDLE_TRANSITION_MS = 500;
const MAX_RETURN_TO_IDLE_TRANSITION_MS = 760;
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
const VRM_MOUTH_EXPRESSION_ALIASES: Record<string, string> = {
  a: "aa",
  aa: "aa",
  i: "ih",
  ih: "ih",
  u: "ou",
  ou: "ou",
  e: "ee",
  ee: "ee",
  o: "oh",
  oh: "oh",
  sil: SPEECH_SILENCE_EXPRESSION_NAME,
  x: SPEECH_SILENCE_EXPRESSION_NAME,
  rest: SPEECH_SILENCE_EXPRESSION_NAME,
  idle: SPEECH_SILENCE_EXPRESSION_NAME,
  pause: SPEECH_SILENCE_EXPRESSION_NAME,
  neutral: SPEECH_SILENCE_EXPRESSION_NAME,
  closed: SPEECH_SILENCE_EXPRESSION_NAME,
  bmp: SPEECH_SILENCE_EXPRESSION_NAME,
  fv: "ee",
  th: "ih",
  l: "ee",
  wq: "ou",
  smile: "ee"
};
const VRM_MOUTH_EXPRESSION_RUNTIME_VARIANTS: Record<string, string[]> = {
  aa: ["aa", "A"],
  ih: ["ih", "I"],
  ou: ["ou", "U"],
  ee: ["ee", "E"],
  oh: ["oh", "O"]
};

interface AvatarSpeechReactionViseme {
  expressionName: string;
  label: string;
  startMs: number;
  endMs: number;
}

interface ActiveSpeechReactionState {
  visemes: AvatarSpeechReactionViseme[];
  elapsedMs: number;
  totalDurationMs: number;
  tailMs: number;
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
  mouthCueTrack?: BackendSpeechMouthCueTrackDocument | null;
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

interface GazeDebugMarkerState {
  root: THREE.Group;
  lineGeometry: THREE.BufferGeometry;
  lineMaterial: THREE.LineBasicMaterial;
  linePositionAttribute: THREE.BufferAttribute;
  markerGeometry: THREE.SphereGeometry;
  headMaterial: THREE.MeshBasicMaterial;
  targetMaterial: THREE.MeshBasicMaterial;
  headMarker: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  targetMarker: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
}

interface ActiveBaseAnimationState {
  command: SemanticAnimationCommand;
  payload: SemanticAnimationRuntimePayload;
  root: THREE.Object3D;
  baselinePosition: THREE.Vector3;
  baselineQuaternion: THREE.Quaternion;
  asyncBridgeReady: boolean;
  elapsedSeconds: number;
  sourceKind: AnimationClipSourceKind | null;
}

interface AvatarHumanoidPlaybackDebugSnapshot {
  activeAnimationId: string | null;
  hasActiveBaseAnimation: boolean;
  bridgeReady: boolean;
  sourceKind: AnimationClipSourceKind | null;
  channelSpace: string | null;
  elapsedSeconds: number | null;
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
  sourceKind: AnimationClipSourceKind | null;
  elapsedSeconds: number | null;
  playback: AnimationPlaybackDebugSnapshot | null;
}

interface AvatarRuntimeDebugApi {
  getProfileOrientationSnapshot: () => AvatarProfileOrientationSnapshot | null;
  getHumanoidPlayback: () => AvatarHumanoidPlaybackDebugSnapshot;
  getLowerBodySnapshot: () => AvatarLowerBodyDebugSnapshot | null;
  getLowerBodyRange: (sampleCount?: number) => AvatarLowerBodyRangeDebugSnapshot;
  getLowerBodyRotationSnapshot: () => AvatarLowerBodyRotationDebugSnapshot | null;
  getLowerBodyRotationRange: (sampleCount?: number) => AvatarLowerBodyRotationRangeDebugSnapshot;
  getPlaybackProgress: () => AvatarPlaybackProgressDebugSnapshot;
  getAttentionDebugSnapshot: () => {
    attentionTarget: { normalizedX: number; normalizedY: number; confidence: number | null } | null;
    hasPassiveEyeDrift: boolean;
    hasVrmLookAt: boolean;
    lookAtAutoUpdate: boolean | null;
    lookAtYawDegrees: number | null;
    lookAtPitchDegrees: number | null;
    lookAtApplierType: string | null;
    lookAtRangeMapHorizontalInner: number | null;
    lookAtRangeMapHorizontalOuter: number | null;
    lookAtRangeMapVerticalDown: number | null;
    lookAtRangeMapVerticalUp: number | null;
    leftEyeQuaternion: [number, number, number, number] | null;
    rightEyeQuaternion: [number, number, number, number] | null;
    lookExpressionValues: {
      lookLeft: number | null;
      lookRight: number | null;
      lookUp: number | null;
      lookDown: number | null;
    };
    lookAtTargetPosition: { x: number; y: number; z: number } | null;
  };
}

declare global {
  interface Window {
    __NIKOF_AVATAR_DEBUG__?: AvatarRuntimeDebugApi;
  }
}

function cloneSemanticAnimationCommand(command: SemanticAnimationCommand): SemanticAnimationCommand {
  return { ...command };
}

function resolveCanonicalAnimationCommand(command: SemanticAnimationCommand): SemanticAnimationCommand {
  return command.source === "shared"
    ? {
        ...command,
        id: resolveCanonicalSharedSemanticAnimationId(command.id)
      }
    : command;
}

function isIdleAnimationCommand(command: SemanticAnimationCommand): boolean {
  return resolveCanonicalAnimationCommand(command).id.startsWith("idle.");
}

function resolveIdleAnimationCommand(command: SemanticAnimationCommand): SemanticAnimationCommand {
  const canonicalCommand = resolveCanonicalAnimationCommand(command);
  return canonicalCommand.playback === "loop"
    ? canonicalCommand
    : {
        ...canonicalCommand,
        playback: "loop"
      };
}

export interface AvatarRuntimeSnapshot {
  mounted: boolean;
  currentCharacterId: CharacterId | null;
  currentState: CharacterRuntimeState;
  mountPoints: AvatarRuntimeMountPoints | null;
  pendingAnimation: SemanticAnimationCommand | null;
  baseAnimation: SemanticAnimationCommand | null;
  idleAnimation: SemanticAnimationCommand | null;
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
  setEmotion: (emotion: AvatarRuntimeEmotionName | null) => void;
  setAttentionTarget: (target: { normalizedX: number; normalizedY: number; confidence?: number | null } | null) => void;
  setAttentionDebugMarkerEnabled: (enabled: boolean) => void;
  beginSpeechReaction: (input: AvatarSpeechReactionInput) => void;
  clearSpeechReaction: () => void;
  setIdleAnimation: (
    command: SemanticAnimationCommand,
    options?: { source?: "manual" | "system" }
  ) => void;
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
    idleAnimation: cloneSemanticAnimationCommand(DEFAULT_BASE_ANIMATION_COMMAND),
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
  let selectedIdleAnimation = cloneSemanticAnimationCommand(DEFAULT_BASE_ANIMATION_COMMAND);
  let debugProfileView: AvatarDebugProfileView = "front";
  let rigOverlayEnabled = false;
  let rigOverlayState: RigOverlayState | null = null;
  let gazeDebugMarkerState: GazeDebugMarkerState | null = null;
  let attentionDebugMarkerEnabled = false;
  let animationPlayback: AnimationPlaybackBridge | null = null;
  let passiveBlink: PassiveBlinkController | null = null;
  let passiveMouth: PassiveMouthController | null = null;
  let passiveEyeDrift: PassiveEyeDriftController | null = null;
  let passiveEmotion: PassiveEmotionController | null = null;
  let activeLoadRequestId = 0;
  let activeLoadTargetKey: string | null = null;
  let activeLoadPromise: Promise<void> | null = null;
  let activeSpeechReaction: ActiveSpeechReactionState | null = null;
  let attentionTarget: { normalizedX: number; normalizedY: number; confidence: number | null } | null = null;
  let activeSpeechExpressionName: string | null = null;
  let activeSpeechExpressionNames = new Set<string>();
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
  const attentionForward = new THREE.Vector3();
  const attentionHeadPosition = new THREE.Vector3();
  const attentionRight = new THREE.Vector3();
  const attentionTowardCamera = new THREE.Vector3();
  const attentionUp = new THREE.Vector3();
  const attentionWorldPoint = new THREE.Vector3();
  let trackedAttentionLookAtOverrideActive = false;
  let trackedAttentionYawDegrees = 0;
  let trackedAttentionPitchDegrees = 0;
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

  function resolveAttentionWeight(): number {
    if (snapshot.speechReactionMode === "viseme") {
      return 0.9;
    }
    if (snapshot.speechReactionMode === "coarse") {
      return 0.82;
    }
    return 0.72;
  }

  function clearTrackedAttentionLookAtOverride(): void {
    if (!trackedAttentionLookAtOverrideActive) {
      trackedAttentionYawDegrees = 0;
      trackedAttentionPitchDegrees = 0;
      return;
    }

    const lookAt = currentAvatar?.vrm?.lookAt as unknown as {
      autoUpdate?: boolean;
      reset?: () => void;
      yaw?: number;
      pitch?: number;
    } | null;

    if (lookAt) {
      lookAt.autoUpdate = true;

      if (typeof lookAt.reset === "function") {
        lookAt.reset();
      } else {
        if (typeof lookAt.yaw === "number") {
          lookAt.yaw = 0;
        }
        if (typeof lookAt.pitch === "number") {
          lookAt.pitch = 0;
        }
      }
    }

    trackedAttentionLookAtOverrideActive = false;
    trackedAttentionYawDegrees = 0;
    trackedAttentionPitchDegrees = 0;
  }

  function syncTrackedAttention(deltaSeconds: number): void {
    if (!passiveEyeDrift || !camera || !attentionTarget) {
      syncGazeDebugMarker(null, null);
      clearTrackedAttentionLookAtOverride();
      passiveEyeDrift?.clearTrackedGaze();
      return;
    }

    const headNode = currentAvatar?.vrm?.humanoid?.getNormalizedBoneNode("head") ?? null;
    if (headNode) {
      headNode.getWorldPosition(attentionHeadPosition);
    } else if (currentAvatar?.vrm?.scene) {
      currentAvatar.vrm.scene.getWorldPosition(attentionHeadPosition);
      attentionHeadPosition.y += 1.45;
    } else {
      syncGazeDebugMarker(null, null);
      passiveEyeDrift.clearTrackedGaze();
      return;
    }

    attentionTowardCamera.copy(camera.position).sub(attentionHeadPosition);
    if (attentionTowardCamera.lengthSq() <= 1e-6) {
      syncGazeDebugMarker(null, null);
      passiveEyeDrift.clearTrackedGaze();
      return;
    }

    attentionTowardCamera.normalize();
    attentionRight.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
    attentionUp.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();

    const horizontalOffset = (0.5 - attentionTarget.normalizedX) * 1.05;
    const verticalOffset = (0.5 - attentionTarget.normalizedY) * 0.7;
    const confidenceWeight = THREE.MathUtils.clamp(attentionTarget.confidence ?? 0.85, 0.55, 1);
    const targetDistance = THREE.MathUtils.lerp(0.18, 0.32, confidenceWeight);
    const lookAt = currentAvatar?.vrm?.lookAt as unknown as {
      autoUpdate?: boolean;
      yaw?: number;
      pitch?: number;
    } | null;

    attentionWorldPoint.copy(attentionHeadPosition)
      .addScaledVector(attentionTowardCamera, targetDistance)
      .addScaledVector(attentionRight, horizontalOffset)
      .addScaledVector(attentionUp, verticalOffset);

    syncGazeDebugMarker(attentionHeadPosition, attentionWorldPoint);

    if (lookAt && typeof lookAt.yaw === "number" && typeof lookAt.pitch === "number") {
      const desiredYawDegrees = THREE.MathUtils.clamp((0.5 - attentionTarget.normalizedX) * 640, -60, 60) * confidenceWeight;
      const desiredPitchDegrees = THREE.MathUtils.clamp((attentionTarget.normalizedY - 0.5) * 460, -40, 40) * confidenceWeight;

      trackedAttentionYawDegrees = THREE.MathUtils.damp(trackedAttentionYawDegrees, desiredYawDegrees, 12, deltaSeconds);
      trackedAttentionPitchDegrees = THREE.MathUtils.damp(trackedAttentionPitchDegrees, desiredPitchDegrees, 12, deltaSeconds);
      lookAt.autoUpdate = false;
      lookAt.yaw = trackedAttentionYawDegrees;
      lookAt.pitch = trackedAttentionPitchDegrees;
      trackedAttentionLookAtOverrideActive = true;
      passiveEyeDrift.clearTrackedGaze();
      return;
    }

    clearTrackedAttentionLookAtOverride();
    passiveEyeDrift.trackGaze(attentionWorldPoint, resolveAttentionWeight() * confidenceWeight);
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
      sourceKind: activeBaseAnimation?.sourceKind ?? null,
      elapsedSeconds: activeBaseAnimation?.elapsedSeconds ?? null,
      playback: animationPlayback?.getDebugSnapshot() ?? null,
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

  function createGazeDebugLineMaterial(): THREE.LineBasicMaterial {
    return new THREE.LineBasicMaterial({
      color: 0xffc857,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.92,
      toneMapped: false,
    });
  }

  function createGazeDebugMarkerMaterial(color: number): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({
      color,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.9,
      toneMapped: false,
    });
  }

  function createGazeDebugMarkerState(): GazeDebugMarkerState {
    const root = new THREE.Group();
    root.name = "gaze_debug_marker";
    root.visible = false;

    const lineGeometry = new THREE.BufferGeometry();
    const linePositionAttribute = new THREE.BufferAttribute(new Float32Array(6), 3);
    lineGeometry.setAttribute("position", linePositionAttribute);
    const lineMaterial = createGazeDebugLineMaterial();
    const line = new THREE.Line(lineGeometry, lineMaterial);
    line.frustumCulled = false;
    line.renderOrder = 1000;
    root.add(line);

    const markerGeometry = new THREE.SphereGeometry(0.026, 18, 18);
    const headMaterial = createGazeDebugMarkerMaterial(0x72d6c9);
    const targetMaterial = createGazeDebugMarkerMaterial(0xff6b6b);
    const headMarker = new THREE.Mesh(markerGeometry, headMaterial);
    headMarker.scale.setScalar(0.75);
    headMarker.frustumCulled = false;
    headMarker.renderOrder = 1001;
    const targetMarker = new THREE.Mesh(markerGeometry, targetMaterial);
    targetMarker.scale.setScalar(1.15);
    targetMarker.frustumCulled = false;
    targetMarker.renderOrder = 1001;
    root.add(headMarker, targetMarker);

    return {
      root,
      lineGeometry,
      lineMaterial,
      linePositionAttribute,
      markerGeometry,
      headMaterial,
      targetMaterial,
      headMarker,
      targetMarker,
    };
  }

  function removeGazeDebugMarkerHelper(): void {
    if (!gazeDebugMarkerState) {
      return;
    }

    scene?.remove(gazeDebugMarkerState.root);
    gazeDebugMarkerState.lineGeometry.dispose();
    gazeDebugMarkerState.lineMaterial.dispose();
    gazeDebugMarkerState.markerGeometry.dispose();
    gazeDebugMarkerState.headMaterial.dispose();
    gazeDebugMarkerState.targetMaterial.dispose();
    gazeDebugMarkerState = null;
  }

  function syncGazeDebugMarker(headPosition: THREE.Vector3 | null, targetPosition: THREE.Vector3 | null): void {
    const isDisplayViewer = snapshot.mountPoints?.viewerVariant === "display";
    if (!attentionDebugMarkerEnabled || !isDisplayViewer || !scene || !headPosition || !targetPosition) {
      if (gazeDebugMarkerState) {
        gazeDebugMarkerState.root.visible = false;
      }
      return;
    }

    if (!gazeDebugMarkerState) {
      gazeDebugMarkerState = createGazeDebugMarkerState();
      scene.add(gazeDebugMarkerState.root);
    }

    const positions = gazeDebugMarkerState.linePositionAttribute.array as Float32Array;
    positions[0] = headPosition.x;
    positions[1] = headPosition.y;
    positions[2] = headPosition.z;
    positions[3] = targetPosition.x;
    positions[4] = targetPosition.y;
    positions[5] = targetPosition.z;
    gazeDebugMarkerState.linePositionAttribute.needsUpdate = true;
    gazeDebugMarkerState.headMarker.position.copy(headPosition);
    gazeDebugMarkerState.targetMarker.position.copy(targetPosition);
    gazeDebugMarkerState.root.visible = true;
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
        bridgeReady: false,
        sourceKind: null,
        channelSpace: null,
        elapsedSeconds: null
      };
    }

    return {
      activeAnimationId: activeBaseAnimation.command.id,
      hasActiveBaseAnimation: true,
      bridgeReady: activeBaseAnimation.asyncBridgeReady,
      sourceKind: activeBaseAnimation.sourceKind,
      channelSpace: activeBaseAnimation.payload.channelSpace ?? null,
      elapsedSeconds: activeBaseAnimation.elapsedSeconds
    };
  }

  function getAttentionDebugSnapshot(): {
    attentionTarget: { normalizedX: number; normalizedY: number; confidence: number | null } | null;
    hasPassiveEyeDrift: boolean;
    hasVrmLookAt: boolean;
    lookAtAutoUpdate: boolean | null;
    lookAtYawDegrees: number | null;
    lookAtPitchDegrees: number | null;
    lookAtApplierType: string | null;
    lookAtRangeMapHorizontalInner: number | null;
    lookAtRangeMapHorizontalOuter: number | null;
    lookAtRangeMapVerticalDown: number | null;
    lookAtRangeMapVerticalUp: number | null;
    leftEyeQuaternion: [number, number, number, number] | null;
    rightEyeQuaternion: [number, number, number, number] | null;
    lookExpressionValues: {
      lookLeft: number | null;
      lookRight: number | null;
      lookUp: number | null;
      lookDown: number | null;
    };
    lookAtTargetPosition: { x: number; y: number; z: number } | null;
  } {
    const lookAt = currentAvatar?.vrm?.lookAt ?? null;
    const lookAtTarget = lookAt?.target ?? null;
    const lookAtApplier = lookAt ? (lookAt as unknown as { applier?: Record<string, unknown> }).applier ?? null : null;
    const leftEyeNode = currentAvatar?.vrm?.humanoid?.getRawBoneNode("leftEye") ?? null;
    const rightEyeNode = currentAvatar?.vrm?.humanoid?.getRawBoneNode("rightEye") ?? null;
    const expressionManager = currentAvatar?.vrm?.expressionManager ?? null;

    function resolveRangeMapOutputScale(name: string): number | null {
      if (!lookAtApplier) {
        return null;
      }

      const rangeMap = (lookAtApplier as Record<string, unknown>)[name] as { outputScale?: unknown } | undefined;
      return typeof rangeMap?.outputScale === "number" ? roundComparisonNumber(rangeMap.outputScale) : null;
    }

    function resolveExpressionValue(name: string): number | null {
      if (!expressionManager?.getExpression(name)) {
        return null;
      }

      const value = expressionManager.getValue(name);
      return typeof value === "number" ? roundComparisonNumber(value) : null;
    }

    return {
      attentionTarget: attentionTarget
        ? {
            normalizedX: attentionTarget.normalizedX,
            normalizedY: attentionTarget.normalizedY,
            confidence: attentionTarget.confidence,
          }
        : null,
      hasPassiveEyeDrift: passiveEyeDrift !== null,
      hasVrmLookAt: Boolean(lookAt),
      lookAtAutoUpdate: lookAt ? Boolean((lookAt as unknown as { autoUpdate?: boolean }).autoUpdate) : null,
      lookAtYawDegrees: lookAt ? roundComparisonNumber((lookAt as unknown as { yaw?: number }).yaw ?? 0) : null,
      lookAtPitchDegrees: lookAt ? roundComparisonNumber((lookAt as unknown as { pitch?: number }).pitch ?? 0) : null,
      lookAtApplierType:
        lookAtApplier && typeof (lookAtApplier as { type?: unknown }).type === "string"
          ? (lookAtApplier as { type: string }).type
          : lookAtApplier && typeof (lookAtApplier as { constructor?: { type?: unknown } }).constructor?.type === "string"
            ? String((lookAtApplier as { constructor: { type: string } }).constructor.type)
            : null,
      lookAtRangeMapHorizontalInner: resolveRangeMapOutputScale("rangeMapHorizontalInner"),
      lookAtRangeMapHorizontalOuter: resolveRangeMapOutputScale("rangeMapHorizontalOuter"),
      lookAtRangeMapVerticalDown: resolveRangeMapOutputScale("rangeMapVerticalDown"),
      lookAtRangeMapVerticalUp: resolveRangeMapOutputScale("rangeMapVerticalUp"),
      leftEyeQuaternion: leftEyeNode ? roundQuaternionValues(leftEyeNode.quaternion) : null,
      rightEyeQuaternion: rightEyeNode ? roundQuaternionValues(rightEyeNode.quaternion) : null,
      lookExpressionValues: {
        lookLeft: resolveExpressionValue("lookLeft"),
        lookRight: resolveExpressionValue("lookRight"),
        lookUp: resolveExpressionValue("lookUp"),
        lookDown: resolveExpressionValue("lookDown"),
      },
      lookAtTargetPosition: lookAtTarget
        ? {
            x: roundComparisonNumber(lookAtTarget.position.x),
            y: roundComparisonNumber(lookAtTarget.position.y),
            z: roundComparisonNumber(lookAtTarget.position.z),
          }
        : null,
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
      getAttentionDebugSnapshot: () => getAttentionDebugSnapshot(),
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
    activeSpeechReaction = null;
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

  function getSupportedSpeechExpressionNames(expressionManager: NonNullable<ReturnType<typeof getExpressionManager>>): Set<string> {
    const supportedExpressionNames = new Set<string>();
    const registeredMouthExpressionNames = Array.isArray(expressionManager.mouthExpressionNames)
      ? expressionManager.mouthExpressionNames
      : [];

    registeredMouthExpressionNames.forEach((expressionName) => {
      if (typeof expressionName !== "string") {
        return;
      }

      const trimmedExpressionName = expressionName.trim();

      if (trimmedExpressionName.length === 0 || !expressionManager.getExpression(trimmedExpressionName)) {
        return;
      }

      supportedExpressionNames.add(trimmedExpressionName);
    });

    if (supportedExpressionNames.size > 0) {
      return supportedExpressionNames;
    }

    const fallbackCandidateNames = new Set<string>();
    Object.keys(VRM_MOUTH_EXPRESSION_ALIASES).forEach((expressionName) => {
      fallbackCandidateNames.add(expressionName);
    });
    Object.values(VRM_MOUTH_EXPRESSION_RUNTIME_VARIANTS).forEach((expressionNames) => {
      expressionNames.forEach((expressionName) => {
        fallbackCandidateNames.add(expressionName);
      });
    });

    fallbackCandidateNames.forEach((expressionName) => {
      if (expressionName === SPEECH_SILENCE_EXPRESSION_NAME || !expressionManager.getExpression(expressionName)) {
        return;
      }

      supportedExpressionNames.add(expressionName);
    });

    return supportedExpressionNames;
  }

  function applySpeechExpressionWeights(weightByExpressionName: Map<string, number>): void {
    const expressionManager = getExpressionManager();

    if (!expressionManager) {
      activeSpeechExpressionName = null;
      activeSpeechExpressionNames = new Set<string>();
      return;
    }

    const trackedExpressionNames = new Set<string>(getSupportedSpeechExpressionNames(expressionManager));
    activeSpeechExpressionNames.forEach((expressionName) => {
      trackedExpressionNames.add(expressionName);
    });
    weightByExpressionName.forEach((_weight, expressionName) => {
      trackedExpressionNames.add(expressionName);
    });

    trackedExpressionNames.forEach((expressionName) => {
      if (!expressionManager.getExpression(expressionName)) {
        return;
      }

      expressionManager.setValue(expressionName, THREE.MathUtils.clamp(weightByExpressionName.get(expressionName) ?? 0, 0, 1));
    });

    expressionManager.update();

    activeSpeechExpressionNames = new Set<string>(
      Array.from(weightByExpressionName.entries())
        .filter(([, weight]) => weight > SPEECH_EXPRESSION_MIN_WEIGHT)
        .map(([expressionName]) => expressionName)
    );

    const dominantExpressionEntry = Array.from(weightByExpressionName.entries()).reduce<readonly [string, number] | null>(
      (dominantEntry, candidateEntry) => {
        if (dominantEntry === null || candidateEntry[1] > dominantEntry[1]) {
          return candidateEntry;
        }

        return dominantEntry;
      },
      null
    );

    activeSpeechExpressionName = dominantExpressionEntry && dominantExpressionEntry[1] > SPEECH_EXPRESSION_MIN_WEIGHT
      ? dominantExpressionEntry[0]
      : null;
  }

  function resetSpeechExpressions(): void {
    const expressionManager = getExpressionManager();

    if (!expressionManager) {
      activeSpeechExpressionName = null;
      activeSpeechExpressionNames = new Set<string>();
      return;
    }

    const trackedExpressionNames = new Set<string>(getSupportedSpeechExpressionNames(expressionManager));
    VRM_MOUTH_EXPRESSION_NAMES.forEach((expressionName) => {
      trackedExpressionNames.add(expressionName);
    });

    activeSpeechExpressionNames.forEach((expressionName) => {
      trackedExpressionNames.add(expressionName);
    });

    if (activeSpeechExpressionName) {
      trackedExpressionNames.add(activeSpeechExpressionName);
    }

    trackedExpressionNames.forEach((expressionName) => {
      if (!expressionManager.getExpression(expressionName)) {
        return;
      }

      expressionManager.setValue(expressionName, 0);
    });

    expressionManager.update();
    activeSpeechExpressionName = null;
    activeSpeechExpressionNames = new Set<string>();
  }

  function resolveSpeechExpressionBinding(viseme: string): Pick<AvatarSpeechReactionViseme, "expressionName" | "label"> | null {
    const expressionManager = getExpressionManager();
    const trimmedViseme = viseme.trim();

    if (!expressionManager || trimmedViseme.length === 0) {
      return null;
    }

    const normalizedViseme = trimmedViseme.toLowerCase().replace(/[\s_-]+/g, "");
    const aliasExpressionName = VRM_MOUTH_EXPRESSION_ALIASES[normalizedViseme];

    if (aliasExpressionName === SPEECH_SILENCE_EXPRESSION_NAME) {
      return {
        expressionName: SPEECH_SILENCE_EXPRESSION_NAME,
        label: "sil"
      };
    }

    const supportedExpressionNames = getSupportedSpeechExpressionNames(expressionManager);
    const candidateNames = Array.from(
      new Set(
        [
          trimmedViseme,
          trimmedViseme.toLowerCase(),
          aliasExpressionName,
          ...(aliasExpressionName ? VRM_MOUTH_EXPRESSION_RUNTIME_VARIANTS[aliasExpressionName] ?? [] : [])
        ].filter((value): value is string => Boolean(value))
      )
    );

    for (const candidateName of candidateNames) {
      if (supportedExpressionNames.has(candidateName) || expressionManager.getExpression(candidateName)) {
        return {
          expressionName: candidateName,
          label: candidateName
        };
      }
    }

    return null;
  }

  function appendSpeechReactionViseme(
    visemes: AvatarSpeechReactionViseme[],
    nextViseme: AvatarSpeechReactionViseme
  ): void {
    const previousViseme = visemes[visemes.length - 1] ?? null;
    const nextDurationMs = Math.max(0, nextViseme.endMs - nextViseme.startMs);

    if (
      previousViseme &&
      nextViseme.expressionName === SPEECH_SILENCE_EXPRESSION_NAME &&
      previousViseme.expressionName !== SPEECH_SILENCE_EXPRESSION_NAME &&
      nextDurationMs <= SPEECH_SHORT_SILENCE_SKIP_MS
    ) {
      // Tiny silence spans read as hard mouth snaps, so absorb them into the
      // previous mouth shape instead of forcing a visible full close.
      previousViseme.endMs = Math.max(previousViseme.endMs, nextViseme.endMs);
      return;
    }

    if (
      previousViseme &&
      previousViseme.expressionName === nextViseme.expressionName &&
      nextViseme.startMs <= previousViseme.endMs + 1
    ) {
      previousViseme.endMs = Math.max(previousViseme.endMs, nextViseme.endMs);
      previousViseme.label = nextViseme.label;
      return;
    }

    if (
      previousViseme &&
      previousViseme.expressionName !== SPEECH_SILENCE_EXPRESSION_NAME &&
      nextViseme.expressionName !== SPEECH_SILENCE_EXPRESSION_NAME
    ) {
      const gapMs = nextViseme.startMs - previousViseme.endMs;

      if (gapMs > 0 && gapMs <= SPEECH_SHORT_GAP_BRIDGE_MS) {
        const midpointMs = previousViseme.endMs + gapMs * 0.5;
        previousViseme.endMs = Math.max(previousViseme.endMs, midpointMs);
        nextViseme.startMs = Math.min(nextViseme.startMs, midpointMs);
      }
    }

    visemes.push(nextViseme);
  }

  function buildResolvedSpeechReactionVisemes<T extends { start_ms: number; end_ms: number }>(
    slots: readonly T[],
    utteranceDurationMs: number | null,
    getCueValue: (slot: T) => string
  ): AvatarSpeechReactionViseme[] {
    const visemes: AvatarSpeechReactionViseme[] = [];

    slots.forEach((slot) => {
      if (!Number.isFinite(slot.start_ms) || !Number.isFinite(slot.end_ms)) {
        return;
      }

      const startMs = Math.max(0, slot.start_ms);
      const unclampedEndMs = Math.max(startMs, slot.end_ms);
      const endMs = utteranceDurationMs === null ? unclampedEndMs : Math.min(unclampedEndMs, utteranceDurationMs);
      const speechExpressionBinding = resolveSpeechExpressionBinding(getCueValue(slot));

      if (!speechExpressionBinding || endMs <= startMs) {
        return;
      }

      appendSpeechReactionViseme(visemes, {
        expressionName: speechExpressionBinding.expressionName,
        label: speechExpressionBinding.label,
        startMs,
        endMs
      });
    });

    return visemes;
  }

  function buildSpeechReactionVisemes(input: AvatarSpeechReactionInput): AvatarSpeechReactionViseme[] {
    const mouthCueSlots = input.mouthCueTrack?.cues ?? [];
    const visemeSlots = input.visemeSlots ?? [];
    const utteranceDurationMs =
      typeof input.utteranceDurationMs === "number" && input.utteranceDurationMs > 0 ? input.utteranceDurationMs : null;

    if (mouthCueSlots.length > 0) {
      const resolvedMouthCueVisemes = buildResolvedSpeechReactionVisemes(mouthCueSlots, utteranceDurationMs, (slot) => slot.cue);

      if (resolvedMouthCueVisemes.length > 0) {
        return resolvedMouthCueVisemes;
      }
    }

    return buildResolvedSpeechReactionVisemes(visemeSlots, utteranceDurationMs, (slot) => slot.viseme);
  }

  function computeSpeechVisemeWeight(viseme: AvatarSpeechReactionViseme, elapsedMs: number): number {
    if (viseme.expressionName === SPEECH_SILENCE_EXPRESSION_NAME) {
      return 0;
    }

    const durationMs = Math.max(0, viseme.endMs - viseme.startMs);

    if (durationMs === 0) {
      return 0;
    }

    const blendWindowMs = Math.min(SPEECH_EXPRESSION_BLEND_WINDOW_MS, Math.max(24, durationMs * 0.35));
    const attackStartMs = Math.max(0, viseme.startMs - blendWindowMs * 0.5);
    const attackEndMs = viseme.startMs + blendWindowMs * 0.5;
    const releaseStartMs = Math.max(viseme.startMs, viseme.endMs - blendWindowMs * 0.5);
    const releaseEndMs = viseme.endMs + blendWindowMs * 0.5;
    const attackWeight =
      attackEndMs <= attackStartMs ? (elapsedMs >= viseme.startMs ? 1 : 0) : THREE.MathUtils.smoothstep(elapsedMs, attackStartMs, attackEndMs);
    const releaseWeight =
      releaseEndMs <= releaseStartMs ? (elapsedMs <= viseme.endMs ? 1 : 0) : 1 - THREE.MathUtils.smoothstep(elapsedMs, releaseStartMs, releaseEndMs);

    return THREE.MathUtils.clamp(attackWeight * releaseWeight, 0, 1);
  }

  function updateSpeechReaction(deltaSeconds: number): void {
    if (!activeSpeechReaction) {
      return;
    }

    activeSpeechReaction.elapsedMs += deltaSeconds * 1000;

    const expressionManager = getExpressionManager();

    if (!expressionManager) {
      if (snapshot.currentState !== "speak" || snapshot.speechReactionMode !== "coarse") {
        updateSnapshot({
          currentState: "speak",
          ...buildSpeechOverlaySnapshot({
            mode: "coarse"
          })
        });
      }

      return;
    }

    const weightByExpressionName = new Map<string, number>();
    let dominantViseme: AvatarSpeechReactionViseme | null = null;
    let dominantWeight = 0;

    for (const viseme of activeSpeechReaction.visemes) {
      const visemeWeight = computeSpeechVisemeWeight(viseme, activeSpeechReaction?.elapsedMs ?? 0);

      if (visemeWeight <= SPEECH_EXPRESSION_MIN_WEIGHT) {
        continue;
      }

      const currentWeight = weightByExpressionName.get(viseme.expressionName) ?? 0;
      weightByExpressionName.set(viseme.expressionName, Math.max(currentWeight, visemeWeight));

      if (visemeWeight > dominantWeight) {
        dominantWeight = visemeWeight;
        dominantViseme = viseme;
      }
    }

    const totalWeight = Array.from(weightByExpressionName.values()).reduce((sum, weight) => sum + weight, 0);

    if (totalWeight > 1) {
      weightByExpressionName.forEach((weight, expressionName) => {
        weightByExpressionName.set(expressionName, weight / totalWeight);
      });
    }

    applySpeechExpressionWeights(weightByExpressionName);

    const nextOverlayLabel = dominantViseme === null ? null : dominantViseme.label;

    if (
      snapshot.currentState !== "speak" ||
      snapshot.speechReactionMode !== "viseme" ||
      snapshot.activeViseme !== nextOverlayLabel
    ) {
      updateSnapshot({
        currentState: "speak",
        ...buildSpeechOverlaySnapshot({
          mode: "viseme",
          label: nextOverlayLabel
        })
      });
    }

    if (
      weightByExpressionName.size === 0 &&
      activeSpeechReaction.elapsedMs > activeSpeechReaction.totalDurationMs + activeSpeechReaction.tailMs
    ) {
      clearSpeechReaction();
      return;
    }
  }

  function beginSpeechReaction(input: AvatarSpeechReactionInput): void {
    clearSpeechReactionTimers();
    resetSpeechExpressions();
    passiveMouth?.suppressForSpeech();

    const speechReactionVisemes = buildSpeechReactionVisemes(input);

    if (speechReactionVisemes.length === 0) {
      activeSpeechReaction = null;
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

    activeSpeechReaction = {
      visemes: speechReactionVisemes,
      elapsedMs: 0,
      totalDurationMs: Math.max(...speechReactionVisemes.map((viseme) => viseme.endMs), 0),
      tailMs: SPEECH_EXPRESSION_BLEND_WINDOW_MS
    };
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

  function resolveAnimationDurationMs(payload: SemanticAnimationRuntimePayload): number {
    return Math.max(payload.durationMs, resolveFinalFrameElapsedSeconds(payload) * 1000, 1000 / 30);
  }

  function resolveAdaptiveBaseAnimationTransitionMs(
    command: SemanticAnimationCommand,
    payload: SemanticAnimationRuntimePayload
  ): number {
    if (command.playback === "loop") {
      return LOOP_BASE_ANIMATION_TRANSITION_MS;
    }

    return Math.round(
      THREE.MathUtils.clamp(
        resolveAnimationDurationMs(payload) * 0.22,
        MIN_BASE_ANIMATION_TRANSITION_MS,
        MAX_BASE_ANIMATION_TRANSITION_MS
      )
    );
  }

  function resolveReturnToIdleTransitionMs(baseAnimationState: ActiveBaseAnimationState): number {
    return Math.round(
      THREE.MathUtils.clamp(
        resolveAnimationDurationMs(baseAnimationState.payload) * 0.28,
        MIN_RETURN_TO_IDLE_TRANSITION_MS,
        MAX_RETURN_TO_IDLE_TRANSITION_MS
      )
    );
  }

  function resolveReturnToIdleLeadMs(_baseAnimationState: ActiveBaseAnimationState): number {
    // Let one-shots reach their authored final pose before starting the idle blend.
    return 0;
  }

  function applySelectedIdleAnimation(source: "manual" | "system"): void {
    if (!activeBaseAnimation) {
      activateBaseAnimation(selectedIdleAnimation);
      return;
    }

    if (activeBaseAnimation.command.playback !== "loop") {
      return;
    }

    if (source === "manual" || isIdleAnimationCommand(activeBaseAnimation.command)) {
      activateBaseAnimation(selectedIdleAnimation);
    }
  }

  function restoreSelectedIdleAnimation(baseAnimationState: ActiveBaseAnimationState): void {
    activateBaseAnimation(selectedIdleAnimation, {
      transitionMs: resolveReturnToIdleTransitionMs(baseAnimationState),
      resumeExistingLoop: true
    });
  }

  function restoreBaseAnimationPose(baseAnimationState: ActiveBaseAnimationState): void {
    baseAnimationState.root.position.copy(baseAnimationState.baselinePosition);
    baseAnimationState.root.quaternion.copy(baseAnimationState.baselineQuaternion);
  }

  function stopBaseAnimation(): void {
    if (!activeBaseAnimation) {
      return;
    }

    animationPlayback?.stopAll();
    restoreBaseAnimationPose(activeBaseAnimation);
    activeBaseAnimation = null;
  }

  function updateBaseAnimation(deltaSeconds: number): void {
    if (!activeBaseAnimation) {
      return;
    }

    // Keep the shared mixer advancing even while the next clip streams in so
    // the previous animation continues instead of freezing mid-pose.
    animationPlayback?.update(deltaSeconds);

    if (!activeBaseAnimation.asyncBridgeReady) {
      return;
    }

    if (activeBaseAnimation.command.playback === "loop") {
      // Let elapsed time grow continuously; the mixer's LoopRepeat handles wrapping internally.
      activeBaseAnimation.elapsedSeconds += deltaSeconds;
      return;
    }

    const cycleDurationSeconds = Math.max(resolveAnimationDurationMs(activeBaseAnimation.payload) / 1000, 1 / 30);
    const restoreIdleAtElapsedSeconds = Math.max(
      0,
      cycleDurationSeconds - resolveReturnToIdleLeadMs(activeBaseAnimation) / 1000
    );

    activeBaseAnimation.elapsedSeconds = Math.min(activeBaseAnimation.elapsedSeconds + deltaSeconds, cycleDurationSeconds);

    if (activeBaseAnimation.elapsedSeconds >= restoreIdleAtElapsedSeconds) {
      restoreSelectedIdleAnimation(activeBaseAnimation);
    }
  }

  interface ResolvedBaseAnimationSource {
    url: string;
    sourceKind: AnimationClipSourceKind;
  }

  function resolvePlayableSourceUrl(payload: SemanticAnimationRuntimePayload | null): string | null {
    const sourcePath = payload?.sourceAsset?.path?.trim() ?? "";

    if (resolveAnimationClipSourceKind(sourcePath) !== "mixamo_fbx") {
      return null;
    }

    return sourcePath.startsWith("/") ? sourcePath : `/${sourcePath}`;
  }

  /**
   * Resolution order for the single official playback core:
   *   1. character/shared .vrma asset for the semantic id
   *   2. the payload's Mixamo .fbx source
   *   3. the same two steps for the semantic's declared source fallback
   * Unity .anim-only semantics resolve through step 3 until dedicated .vrma
   * exports exist; anything else is reported as unplayable.
   */
  async function resolveBaseAnimationSource(
    semanticId: string,
    payload: SemanticAnimationRuntimePayload,
    characterId: string | undefined
  ): Promise<ResolvedBaseAnimationSource | null> {
    const vrmaResolution = await probeVrmaAsset(semanticId, characterId).catch(() => null);

    if (vrmaResolution) {
      return { url: vrmaResolution.url, sourceKind: "vrma" };
    }

    const fbxUrl = resolvePlayableSourceUrl(payload);

    if (fbxUrl) {
      return { url: fbxUrl, sourceKind: "mixamo_fbx" };
    }

    const fallbackSemanticId = SHARED_SEMANTIC_ANIMATION_SOURCE_FALLBACKS[semanticId];

    if (!fallbackSemanticId) {
      return null;
    }

    const fallbackVrmaResolution = await probeVrmaAsset(fallbackSemanticId, characterId).catch(() => null);

    if (fallbackVrmaResolution) {
      return { url: fallbackVrmaResolution.url, sourceKind: "vrma" };
    }

    const fallbackPayload = resolveSharedSemanticAnimationPayload({
      id: fallbackSemanticId,
      source: "shared",
      playback: payload.playback
    });
    const fallbackFbxUrl = resolvePlayableSourceUrl(fallbackPayload);

    if (fallbackFbxUrl) {
      return { url: fallbackFbxUrl, sourceKind: "mixamo_fbx" };
    }

    return null;
  }

  function activateBaseAnimation(
    command: SemanticAnimationCommand,
    options?: {
      transitionMs?: number;
      resumeExistingLoop?: boolean;
    }
  ): void {
    const canonicalCommand = resolveCanonicalAnimationCommand(command);
    if (isIdleAnimationCommand(canonicalCommand)) {
      selectedIdleAnimation = cloneSemanticAnimationCommand(resolveIdleAnimationCommand(canonicalCommand));
      updateSnapshot({
        idleAnimation: cloneSemanticAnimationCommand(selectedIdleAnimation)
      });
    }
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

    const playbackBridge = animationPlayback;

    if (!playbackBridge) {
      stopBaseAnimation();
      updateSnapshot({
        pendingAnimation: canonicalCommand,
        baseAnimation: snapshot.baseAnimation,
        error: "Animation playback is unavailable until a VRM humanoid finishes loading."
      });
      return;
    }

    const previousBaseAnimation = activeBaseAnimation;
    const previousCommandId =
      previousBaseAnimation && previousBaseAnimation.command.id !== canonicalCommand.id
        ? previousBaseAnimation.command.id
        : null;
    const transitionMs = previousBaseAnimation
      ? options?.transitionMs ?? resolveAdaptiveBaseAnimationTransitionMs(canonicalCommand, resolvedPayload)
      : 0;
    const shouldResumeExistingLoop =
      options?.resumeExistingLoop === true &&
      canonicalCommand.playback === "loop" &&
      isIdleSemanticAnimationPayload(resolvedPayload);
    const expectedCommandId = canonicalCommand.id;

    // The previous clip keeps playing in the shared mixer while the next one
    // streams in; the crossfade starts once the new clip is ready.
    activeBaseAnimation = {
      command: canonicalCommand,
      payload: resolvedPayload,
      root: currentAvatar.root,
      baselinePosition: currentAvatar.root.position.clone(),
      baselineQuaternion: currentAvatar.root.quaternion.clone(),
      asyncBridgeReady: false,
      elapsedSeconds: 0,
      sourceKind: null
    };

    resolveBaseAnimationSource(canonicalCommand.id, resolvedPayload, snapshot.currentCharacterId ?? undefined)
      .then(async (source) => {
        if (!activeBaseAnimation || activeBaseAnimation.command.id !== expectedCommandId || !currentAvatar) {
          return;
        }

        if (!source) {
          throw new Error(`Semantic animation '${canonicalCommand.id}' has no playable VRMA or FBX source.`);
        }

        const clipHandle = await playbackBridge.loadClip(source.url, canonicalCommand.id);

        if (!activeBaseAnimation || activeBaseAnimation.command.id !== expectedCommandId || !currentAvatar) {
          return;
        }

        activeBaseAnimation.asyncBridgeReady = true;
        activeBaseAnimation.elapsedSeconds = 0;
        activeBaseAnimation.sourceKind = clipHandle.sourceKind;

        const shouldTransitionFromPrevious = previousCommandId !== null && playbackBridge.hasActiveClip(previousCommandId);

        playbackBridge.play(canonicalCommand.id, {
          loop: canonicalCommand.playback === "loop",
          transitionMs: shouldTransitionFromPrevious ? transitionMs : 0,
          restart: !shouldResumeExistingLoop
        });

        // Stop every other clip (not just the remembered previous one) so
        // overlapping async activations cannot leave a stale clip blended in.
        playbackBridge.stopAllExcept(canonicalCommand.id, {
          fadeOutMs: shouldTransitionFromPrevious ? transitionMs : 0
        });

        // Preserve the load-time ground offset. Re-grounding after frame 0
        // would treat authored hip/foot motion as world motion and lift the
        // entire avatar.
        playbackBridge.update(0);
        currentAvatar.vrm?.update(0);
        activeBaseAnimation.root.updateMatrixWorld(true);
        updateSnapshot({
          pendingAnimation: null,
          baseAnimation: command,
          error: null
        });
      })
      .catch((err) => {
        console.warn(`[activateBase] Animation load failed for ${canonicalCommand.id}:`, err);

        if (!activeBaseAnimation || activeBaseAnimation.command.id !== expectedCommandId) {
          return;
        }

        // Leave whatever is already playing in the mixer untouched and surface the failure.
        updateSnapshot({
          pendingAnimation: null,
          baseAnimation: snapshot.baseAnimation,
          error:
            err instanceof Error
              ? err.message
              : `Semantic animation '${canonicalCommand.id}' could not be loaded.`
        });
      });

    updateSnapshot({
      pendingAnimation: canonicalCommand,
      baseAnimation: snapshot.baseAnimation,
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
      removeGazeDebugMarkerHelper();
      stopBaseAnimation();
      if (animationPlayback) { animationPlayback.dispose(); animationPlayback = null; }
      if (passiveBlink) { passiveBlink.dispose(); passiveBlink = null; }
      if (passiveMouth) { passiveMouth.dispose(); passiveMouth = null; }
      if (passiveEyeDrift) { passiveEyeDrift.dispose(); passiveEyeDrift = null; }
      if (passiveEmotion) { passiveEmotion.dispose(); passiveEmotion = null; }
      currentAvatar = null;
      return;
    }

    removeRigOverlayHelper();
  removeGazeDebugMarkerHelper();
    stopBaseAnimation();
    if (animationPlayback) { animationPlayback.dispose(); animationPlayback = null; }
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

      syncTrackedAttention(deltaSeconds);

      // Passive blink runs independently of body animation
      passiveBlink?.update(deltaSeconds);

      // Passive mouth idle runs independently; suppressed during speech
      passiveMouth?.update(deltaSeconds);

      // Passive eye drift — natural micro-saccades and gaze wandering
      passiveEyeDrift?.update(deltaSeconds);

      // Passive emotion layer for smooth facial state transitions
      passiveEmotion?.update(deltaSeconds);

      updateSpeechReaction(deltaSeconds);

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

      // Create the unified playback bridge (VRMA + Mixamo FBX) for this VRM
      if (animationPlayback) {
        animationPlayback.dispose();
        animationPlayback = null;
      }
      if (vrm) {
        animationPlayback = createAnimationPlayback(vrm, root);
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
      removeGazeDebugMarkerHelper();

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

    setEmotion(emotion) {
      setActiveEmotion(emotion);
    },

    setAttentionTarget(target) {
      attentionTarget = target
        ? {
            normalizedX: THREE.MathUtils.clamp(target.normalizedX, 0, 1),
            normalizedY: THREE.MathUtils.clamp(target.normalizedY, 0, 1),
            confidence: target.confidence ?? null,
          }
        : null;

      if (!attentionTarget) {
        passiveEyeDrift?.clearTrackedGaze();
      }
    },

    setAttentionDebugMarkerEnabled(enabled) {
      attentionDebugMarkerEnabled = enabled;

      if (!enabled && gazeDebugMarkerState) {
        gazeDebugMarkerState.root.visible = false;
      }
    },

    beginSpeechReaction(input) {
      beginSpeechReaction(input);
    },

    clearSpeechReaction() {
      clearSpeechReaction();
    },

    setIdleAnimation(command, options) {
      selectedIdleAnimation = cloneSemanticAnimationCommand(resolveIdleAnimationCommand(command));
      updateSnapshot({
        idleAnimation: cloneSemanticAnimationCommand(selectedIdleAnimation),
        error: null
      });
      applySelectedIdleAnimation(options?.source ?? "manual");
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

      // A backend idle/base reconcile can arrive while a one-shot gesture (e.g.
      // greet.wave.once) is still playing — the session command resolves back to
      // the persistent idle right after the gesture is published. Don't cut the
      // gesture: let it finish and run its own smooth return-to-idle (the same
      // path the dev emote button uses). Non-idle commands still interrupt
      // normally (a genuinely new gesture should take over).
      const incomingIsIdle = isIdleAnimationCommand(resolveCanonicalAnimationCommand(command));
      const activeOneShotPlaying =
        activeBaseAnimation !== null &&
        activeBaseAnimation.command.playback !== "loop" &&
        !isIdleAnimationCommand(activeBaseAnimation.command);
      if (incomingIsIdle && activeOneShotPlaying) {
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
