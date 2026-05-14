import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, type VRM } from "@pixiv/three-vrm";
import type { SemanticAnimationCommand } from "../../shared/types/animation";
import type {
  BackendSpeechVisemeSlotDocument,
  CharacterId,
  CharacterManifestSummary,
  CharacterRuntimeState
} from "../../shared/types/character";
import type { AvatarRuntimeMountPoints } from "./mountPoints";

type AvatarRuntimeLoadState = "idle" | "loading" | "ready" | "error";
type AvatarSpeechReactionMode = "idle" | "coarse" | "viseme";

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

export interface AvatarSpeechReactionInput {
  utteranceDurationMs: number | null;
  visemeSlots?: BackendSpeechVisemeSlotDocument[] | null;
}

interface LoadedAvatar {
  root: THREE.Object3D;
  vrm: VRM | null;
}

export interface AvatarRuntimeSnapshot {
  mounted: boolean;
  currentCharacterId: CharacterId | null;
  currentState: CharacterRuntimeState;
  mountPoints: AvatarRuntimeMountPoints | null;
  pendingAnimation: SemanticAnimationCommand | null;
  currentModelUrl: string | null;
  loadState: AvatarRuntimeLoadState;
  speechReactionMode: AvatarSpeechReactionMode;
  activeViseme: string | null;
  error: string | null;
}

export interface AvatarRuntimeBridge {
  mount: (mountPoints: AvatarRuntimeMountPoints) => void;
  unmount: () => void;
  loadCharacter: (character: CharacterManifestSummary) => Promise<void>;
  setState: (state: CharacterRuntimeState) => void;
  beginSpeechReaction: (input: AvatarSpeechReactionInput) => void;
  clearSpeechReaction: () => void;
  play: (command: SemanticAnimationCommand) => void;
  subscribe: (listener: AvatarRuntimeListener) => () => void;
  snapshot: () => AvatarRuntimeSnapshot;
}

export function createAvatarRuntime(): AvatarRuntimeBridge {
  let snapshot: AvatarRuntimeSnapshot = {
    mounted: false,
    currentCharacterId: null,
    currentState: "idle",
    mountPoints: null,
    pendingAnimation: null,
    currentModelUrl: null,
    loadState: "idle",
    speechReactionMode: "idle",
    activeViseme: null,
    error: null
  };
  let currentCharacter: CharacterManifestSummary | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let viewportElement: HTMLElement | null = null;
  let animationFrameId: number | null = null;
  let currentAvatar: LoadedAvatar | null = null;
  let activeLoadRequestId = 0;
  let speechReactionTimeoutIds: number[] = [];
  let activeSpeechExpressionName: string | null = null;
  const listeners = new Set<AvatarRuntimeListener>();
  const clock = new THREE.Clock();

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

  function clearSpeechReactionTimers(): void {
    speechReactionTimeoutIds.forEach((timeoutId) => {
      window.clearTimeout(timeoutId);
    });
    speechReactionTimeoutIds = [];
  }

  function getExpressionManager() {
    return currentAvatar?.vrm?.expressionManager ?? null;
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
        speechReactionMode: "coarse",
        activeViseme: null
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
      speechReactionMode: "viseme",
      activeViseme: label
    });
  }

  function beginSpeechReaction(input: AvatarSpeechReactionInput): void {
    clearSpeechReactionTimers();
    resetSpeechExpressions();

    const speechReactionVisemes = buildSpeechReactionVisemes(input);

    if (speechReactionVisemes.length === 0) {
      updateSnapshot({
        currentState: "speak",
        speechReactionMode: "coarse",
        activeViseme: null
      });
      return;
    }

    updateSnapshot({
      currentState: "speak",
      speechReactionMode: "viseme",
      activeViseme: null
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
            speechReactionMode: "viseme",
            activeViseme: null
          });
        }, viseme.endMs)
      );
    });
  }

  function clearSpeechReaction(): void {
    clearSpeechReactionTimers();
    resetSpeechExpressions();
    updateSnapshot({
      currentState: "idle",
      speechReactionMode: "idle",
      activeViseme: null
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
      currentAvatar = null;
      return;
    }

    scene.remove(currentAvatar.root);
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

      if (currentAvatar?.vrm) {
        currentAvatar.vrm.update(clock.getDelta());
      } else {
        clock.getDelta();
      }

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

  function ensureRenderer(): void {
    if (renderer || !viewportElement) {
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
    renderer.domElement.className = "avatar-stage__canvas";
    viewportElement.replaceChildren(renderer.domElement);
    handleResize();
    startRenderLoop();
  }

  function frameLoadedAvatar(root: THREE.Object3D): void {
    if (!camera) {
      return;
    }

    const bounds = new THREE.Box3().setFromObject(root);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());

    root.position.x -= center.x;
    root.position.z -= center.z;
    root.position.y -= bounds.min.y;
    root.rotation.y = Math.PI;

    const maxDimension = Math.max(size.x, size.y, size.z, 0.8);
    camera.position.set(maxDimension * 0.15, size.y * 0.62 + 0.45, maxDimension * 2.25);
    camera.lookAt(0, size.y * 0.55, 0);
  }

  async function loadMountedCharacter(character: CharacterManifestSummary, requestId: number): Promise<void> {
    if (!scene) {
      return;
    }

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    updateSnapshot({
      currentCharacterId: character.characterId,
      currentModelUrl: character.assets.modelUrl,
      loadState: "loading",
      error: null
    });

    try {
      const gltf = await loader.loadAsync(character.assets.modelUrl);

      if (requestId !== activeLoadRequestId) {
        return;
      }

      const vrm = (gltf.userData.vrm as VRM | undefined) ?? null;
      const root = vrm?.scene ?? gltf.scene;

      clearCurrentAvatar();
      frameLoadedAvatar(root);
      scene.add(root);
      currentAvatar = {
        root,
        vrm
      };

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

    const requestId = activeLoadRequestId + 1;
    activeLoadRequestId = requestId;

    return loadMountedCharacter(currentCharacter, requestId);
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

      ensureRenderer();
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
      renderer = null;
      scene = null;
      camera = null;
      viewportElement = null;
      updateSnapshot({
        mounted: false,
        mountPoints: null,
        pendingAnimation: null,
        loadState: currentCharacter ? "idle" : snapshot.loadState
      });
    },

    async loadCharacter(character) {
      currentCharacter = character;
      updateSnapshot({
        currentCharacterId: character.characterId,
        currentModelUrl: character.assets.modelUrl,
        error: null
      });

      await loadCurrentCharacterIfMounted();
    },

    setState(state) {
      updateSnapshot({
        currentState: state
      });
    },

    beginSpeechReaction(input) {
      beginSpeechReaction(input);
    },

    clearSpeechReaction() {
      clearSpeechReaction();
    },

    play(command) {
      updateSnapshot({
        pendingAnimation: command
      });
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