import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { loadMixamoAnimation } from './loadMixamoAnimation.js';
import GUI from 'lil-gui';

// --- PATHS (using Vite /@fs/ to access repo assets) ---
const REPO_ROOT = '/@fs/c:/Users/jason.HQ/Source/NikoF-1';
const MODEL_URL = `${REPO_ROOT}/assets/characters/maria/model.vrm`;
const ANIMATION_URL = `${REPO_ROOT}/assets/animations/raw/IdleNeutral.fbx`;

// --- RENDERER ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

// --- CAMERA ---
const camera = new THREE.PerspectiveCamera(30.0, window.innerWidth / window.innerHeight, 0.1, 20.0);
camera.position.set(0.0, 1.0, 5.0);

// --- CONTROLS ---
const controls = new OrbitControls(camera, renderer.domElement);
controls.screenSpacePanning = true;
controls.target.set(0.0, 1.0, 0.0);
controls.update();

// --- SCENE ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x222222);

// --- LIGHTS ---
const light = new THREE.DirectionalLight(0xffffff, Math.PI);
light.position.set(1.0, 1.0, 1.0).normalize();
scene.add(light);
scene.add(new THREE.AmbientLight(0x404040, 2));

// --- HELPERS ---
const gridHelper = new THREE.GridHelper(10, 10);
scene.add(gridHelper);

// --- STATE ---
let currentVrm = undefined;
let currentMixer = undefined;
let currentAction = undefined;
let retargetDebugInfo = null;
let frameCount = 0;
let lastDiagTime = 0;

// --- DEBUG PANEL ---
const debugPanel = document.getElementById('debug-panel');

// Per-frame lower-body diagnostics buffer
const diagHistory = [];
const MAX_DIAG_HISTORY = 500; // ~16s at 30fps

// --- BONE HELPERS (visual skeleton overlay) ---
const boneHelperGroup = new THREE.Group();
boneHelperGroup.renderOrder = 10000;
scene.add(boneHelperGroup);

// --- FLOOR MARKER (shows Y=0 plane contact) ---
const floorMarkerLeft = new THREE.Mesh(
  new THREE.SphereGeometry(0.015, 8, 8),
  new THREE.MeshBasicMaterial({ color: 0xff0000 })
);
const floorMarkerRight = new THREE.Mesh(
  new THREE.SphereGeometry(0.015, 8, 8),
  new THREE.MeshBasicMaterial({ color: 0x0000ff })
);
scene.add(floorMarkerLeft, floorMarkerRight);

// --- HIP POSITION MARKER ---
const hipMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.02, 8, 8),
  new THREE.MeshBasicMaterial({ color: 0x00ff00 })
);
scene.add(hipMarker);

// --- KNEE MARKERS ---
const kneeMarkerLeft = new THREE.Mesh(
  new THREE.SphereGeometry(0.012, 8, 8),
  new THREE.MeshBasicMaterial({ color: 0xff8800 })
);
const kneeMarkerRight = new THREE.Mesh(
  new THREE.SphereGeometry(0.012, 8, 8),
  new THREE.MeshBasicMaterial({ color: 0x8800ff })
);
scene.add(kneeMarkerLeft, kneeMarkerRight);

// -----------------------------------------------------------
// LOAD VRM MODEL
// -----------------------------------------------------------
function loadVRM(modelUrl) {
  const loader = new GLTFLoader();
  loader.crossOrigin = 'anonymous';

  loader.register((parser) => {
    return new VRMLoaderPlugin(parser, { autoUpdateHumanBones: true });
  });

  loader.load(
    modelUrl,
    (gltf) => {
      const vrm = gltf.userData.vrm;

      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineSkeletons(gltf.scene);

      if (currentVrm) {
        scene.remove(currentVrm.scene);
        VRMUtils.deepDispose(currentVrm.scene);
      }

      currentVrm = vrm;
      scene.add(vrm.scene);

      currentMixer = new THREE.AnimationMixer(vrm.scene);

      vrm.scene.traverse((obj) => { obj.frustumCulled = false; });

      // Rotate VRM0 model to face camera
      VRMUtils.rotateVRM0(vrm);

      console.log('[DEBUG] VRM loaded:', vrm);
      console.log('[DEBUG] VRM meta version:', vrm.meta?.metaVersion);
      console.log('[DEBUG] Normalized rest pose:', vrm.humanoid.normalizedRestPose);

      // Log the entire lower body skeleton structure
      logSkeletonStructure(vrm);

      // Now load animation
      loadAnimation(ANIMATION_URL);
    },
    (progress) => {
      debugPanel.textContent = `Loading model... ${(100 * progress.loaded / progress.total).toFixed(1)}%`;
    },
    (error) => {
      console.error('[DEBUG] VRM load error:', error);
      debugPanel.textContent = `ERROR loading model: ${error.message}`;
    },
  );
}

function logSkeletonStructure(vrm) {
  const bones = [
    'hips', 'spine', 'chest', 'upperChest',
    'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
    'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
  ];

  console.group('[DEBUG] VRM Lower Body Skeleton (Normalized Bones)');
  for (const boneName of bones) {
    const node = vrm.humanoid.getNormalizedBoneNode(boneName);
    if (node) {
      const worldPos = new THREE.Vector3();
      const worldQuat = new THREE.Quaternion();
      node.getWorldPosition(worldPos);
      node.getWorldQuaternion(worldQuat);
      console.log(`  ${boneName}:`, {
        localPos: [node.position.x.toFixed(4), node.position.y.toFixed(4), node.position.z.toFixed(4)],
        localQuat: [node.quaternion.x.toFixed(4), node.quaternion.y.toFixed(4), node.quaternion.z.toFixed(4), node.quaternion.w.toFixed(4)],
        worldPos: [worldPos.x.toFixed(4), worldPos.y.toFixed(4), worldPos.z.toFixed(4)],
        worldQuat: [worldQuat.x.toFixed(4), worldQuat.y.toFixed(4), worldQuat.z.toFixed(4), worldQuat.w.toFixed(4)],
      });
    }
  }
  console.groupEnd();

  // Also store as accessible debug data
  window.__VRM_DEBUG__ = window.__VRM_DEBUG__ || {};
  window.__VRM_DEBUG__.skeleton = {};
  for (const boneName of bones) {
    const node = vrm.humanoid.getNormalizedBoneNode(boneName);
    if (node) {
      const worldPos = new THREE.Vector3();
      const worldQuat = new THREE.Quaternion();
      node.getWorldPosition(worldPos);
      node.getWorldQuaternion(worldQuat);
      window.__VRM_DEBUG__.skeleton[boneName] = {
        node,
        localPos: node.position.clone(),
        localQuat: node.quaternion.clone(),
        worldPos,
        worldQuat,
      };
    }
  }
}

// -----------------------------------------------------------
// LOAD ANIMATION
// -----------------------------------------------------------
async function loadAnimation(animationUrl) {
  if (!currentMixer || !currentVrm) return;

  debugPanel.textContent = 'Loading animation...';

  try {
    const { clip, debug } = await loadMixamoAnimation(animationUrl, currentVrm);
    retargetDebugInfo = debug;

    console.group('[DEBUG] Animation Retarget Info');
    console.log('Source hips height:', debug.sourceHipsHeight);
    console.log('VRM hips height:', debug.vrmHipsHeight);
    console.log('Position scale factor:', debug.hipsPositionScale);
    console.log('Total tracks:', debug.trackSummary.length);
    console.log('Lower body retarget data:', debug.boneRetargetData);
    console.log('Source skeleton:', debug.sourceSkeleton);
    console.groupEnd();

    window.__VRM_DEBUG__ = window.__VRM_DEBUG__ || {};
    window.__VRM_DEBUG__.retarget = debug;

    const newAction = currentMixer.clipAction(clip);
    newAction.reset().play();

    if (currentAction && currentAction !== newAction) {
      currentAction.crossFadeTo(newAction, 0.5, false);
    }
    currentAction = newAction;

    debugPanel.textContent = 'Animation loaded. Monitoring...';
  } catch (error) {
    console.error('[DEBUG] Animation load error:', error);
    debugPanel.textContent = `ERROR loading animation: ${error.message}`;
  }
}

// -----------------------------------------------------------
// PER-FRAME DIAGNOSTICS
// -----------------------------------------------------------
function collectFrameDiagnostics(vrm, elapsed) {
  const bones = {};
  const lowerBodyNames = [
    'hips', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
    'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
  ];

  for (const boneName of lowerBodyNames) {
    const node = vrm.humanoid.getNormalizedBoneNode(boneName);
    if (node) {
      const worldPos = new THREE.Vector3();
      const worldQuat = new THREE.Quaternion();
      node.getWorldPosition(worldPos);
      node.getWorldQuaternion(worldQuat);
      bones[boneName] = {
        worldPos: { x: worldPos.x, y: worldPos.y, z: worldPos.z },
        worldQuat: { x: worldQuat.x, y: worldQuat.y, z: worldQuat.z, w: worldQuat.w },
        localQuat: { x: node.quaternion.x, y: node.quaternion.y, z: node.quaternion.z, w: node.quaternion.w },
        localPos: { x: node.position.x, y: node.position.y, z: node.position.z },
      };
    }
  }

  // Compute derived metrics
  const hips = bones.hips;
  const leftFoot = bones.leftFoot;
  const rightFoot = bones.rightFoot;
  const leftKnee = bones.leftLowerLeg;
  const rightKnee = bones.rightLowerLeg;

  const metrics = {
    hipsY: hips?.worldPos.y ?? 0,
    hipsX: hips?.worldPos.x ?? 0,
    leftFootY: leftFoot?.worldPos.y ?? 0,
    rightFootY: rightFoot?.worldPos.y ?? 0,
    leftKneeZ: leftKnee?.worldPos.z ?? 0,
    rightKneeZ: rightKnee?.worldPos.z ?? 0,
    leftKneeX: leftKnee?.worldPos.x ?? 0,
    rightKneeX: rightKnee?.worldPos.x ?? 0,
    // Leg chain lengths (world space distance)
    leftUpperLegLen: 0,
    leftLowerLegLen: 0,
    rightUpperLegLen: 0,
    rightLowerLegLen: 0,
    // Compression ratio (current reach / max reach)
    leftCompression: 0,
    rightCompression: 0,
  };

  // Compute leg lengths and compression
  if (hips && leftKnee && leftFoot) {
    const hipPos = new THREE.Vector3(hips.worldPos.x, hips.worldPos.y, hips.worldPos.z);
    const lKneePos = new THREE.Vector3(leftKnee.worldPos.x, leftKnee.worldPos.y, leftKnee.worldPos.z);
    const lFootPos = new THREE.Vector3(leftFoot.worldPos.x, leftFoot.worldPos.y, leftFoot.worldPos.z);

    metrics.leftUpperLegLen = hipPos.distanceTo(lKneePos);
    metrics.leftLowerLegLen = lKneePos.distanceTo(lFootPos);
    const maxReach = metrics.leftUpperLegLen + metrics.leftLowerLegLen;
    const currentReach = hipPos.distanceTo(lFootPos);
    metrics.leftCompression = maxReach > 0 ? currentReach / maxReach : 0;
  }

  if (hips && rightKnee && rightFoot) {
    const hipPos = new THREE.Vector3(hips.worldPos.x, hips.worldPos.y, hips.worldPos.z);
    const rKneePos = new THREE.Vector3(rightKnee.worldPos.x, rightKnee.worldPos.y, rightKnee.worldPos.z);
    const rFootPos = new THREE.Vector3(rightFoot.worldPos.x, rightFoot.worldPos.y, rightFoot.worldPos.z);

    metrics.rightUpperLegLen = hipPos.distanceTo(rKneePos);
    metrics.rightLowerLegLen = rKneePos.distanceTo(rFootPos);
    const maxReach = metrics.rightUpperLegLen + metrics.rightLowerLegLen;
    const currentReach = hipPos.distanceTo(rFootPos);
    metrics.rightCompression = maxReach > 0 ? currentReach / maxReach : 0;
  }

  // Knee bend angle (dot product of upper→knee and knee→foot vectors)
  if (hips && leftKnee && leftFoot) {
    const hipToKnee = new THREE.Vector3().subVectors(
      new THREE.Vector3(leftKnee.worldPos.x, leftKnee.worldPos.y, leftKnee.worldPos.z),
      new THREE.Vector3(hips.worldPos.x, hips.worldPos.y, hips.worldPos.z),
    );
    const kneeToFoot = new THREE.Vector3().subVectors(
      new THREE.Vector3(leftFoot.worldPos.x, leftFoot.worldPos.y, leftFoot.worldPos.z),
      new THREE.Vector3(leftKnee.worldPos.x, leftKnee.worldPos.y, leftKnee.worldPos.z),
    );
    const angle = hipToKnee.angleTo(kneeToFoot);
    metrics.leftKneeAngleDeg = THREE.MathUtils.radToDeg(angle);
  }

  if (hips && rightKnee && rightFoot) {
    const hipToKnee = new THREE.Vector3().subVectors(
      new THREE.Vector3(rightKnee.worldPos.x, rightKnee.worldPos.y, rightKnee.worldPos.z),
      new THREE.Vector3(hips.worldPos.x, hips.worldPos.y, hips.worldPos.z),
    );
    const kneeToFoot = new THREE.Vector3().subVectors(
      new THREE.Vector3(rightFoot.worldPos.x, rightFoot.worldPos.y, rightFoot.worldPos.z),
      new THREE.Vector3(rightKnee.worldPos.x, rightKnee.worldPos.y, rightKnee.worldPos.z),
    );
    const angle = hipToKnee.angleTo(kneeToFoot);
    metrics.rightKneeAngleDeg = THREE.MathUtils.radToDeg(angle);
  }

  return { time: elapsed, bones, metrics };
}

function updateDebugPanel(diag) {
  const m = diag.metrics;
  const lines = [
    `=== Frame ${frameCount} | t=${diag.time.toFixed(2)}s ===`,
    ``,
    `--- HIPS ---`,
    `  pos: X=${m.hipsX.toFixed(4)} Y=${m.hipsY.toFixed(4)}`,
    ``,
    `--- LEFT LEG ---`,
    `  foot Y: ${m.leftFootY.toFixed(4)}`,
    `  knee Z: ${m.leftKneeZ.toFixed(4)} X: ${m.leftKneeX.toFixed(4)}`,
    `  upper len: ${m.leftUpperLegLen.toFixed(4)}`,
    `  lower len: ${m.leftLowerLegLen.toFixed(4)}`,
    `  compression: ${(m.leftCompression * 100).toFixed(1)}%`,
    `  knee angle: ${(m.leftKneeAngleDeg ?? 0).toFixed(1)}°`,
    ``,
    `--- RIGHT LEG ---`,
    `  foot Y: ${m.rightFootY.toFixed(4)}`,
    `  knee Z: ${m.rightKneeZ.toFixed(4)} X: ${m.rightKneeX.toFixed(4)}`,
    `  upper len: ${m.rightUpperLegLen.toFixed(4)}`,
    `  lower len: ${m.rightLowerLegLen.toFixed(4)}`,
    `  compression: ${(m.rightCompression * 100).toFixed(1)}%`,
    `  knee angle: ${(m.rightKneeAngleDeg ?? 0).toFixed(1)}°`,
    ``,
    `--- FLOOR CONTACT ---`,
    `  L offset: ${(m.leftFootY * 1000).toFixed(1)}mm`,
    `  R offset: ${(m.rightFootY * 1000).toFixed(1)}mm`,
    ``,
    `--- RETARGET SCALE ---`,
    `  hipsScale: ${retargetDebugInfo?.hipsPositionScale?.toFixed(4) ?? 'n/a'}`,
    `  src hips Y: ${retargetDebugInfo?.sourceHipsHeight?.toFixed(4) ?? 'n/a'}`,
    `  vrm hips Y: ${retargetDebugInfo?.vrmHipsHeight?.toFixed(4) ?? 'n/a'}`,
  ];

  debugPanel.textContent = lines.join('\n');
}

function updateMarkers(diag) {
  const b = diag.bones;
  if (b.leftFoot) {
    floorMarkerLeft.position.set(b.leftFoot.worldPos.x, 0, b.leftFoot.worldPos.z);
  }
  if (b.rightFoot) {
    floorMarkerRight.position.set(b.rightFoot.worldPos.x, 0, b.rightFoot.worldPos.z);
  }
  if (b.hips) {
    hipMarker.position.set(b.hips.worldPos.x, b.hips.worldPos.y, b.hips.worldPos.z);
  }
  if (b.leftLowerLeg) {
    kneeMarkerLeft.position.set(b.leftLowerLeg.worldPos.x, b.leftLowerLeg.worldPos.y, b.leftLowerLeg.worldPos.z);
  }
  if (b.rightLowerLeg) {
    kneeMarkerRight.position.set(b.rightLowerLeg.worldPos.x, b.rightLowerLeg.worldPos.y, b.rightLowerLeg.worldPos.z);
  }
}

// -----------------------------------------------------------
// ANIMATION LOOP
// -----------------------------------------------------------
const clock = new THREE.Clock();
let elapsed = 0;

function animate() {
  const deltaTime = clock.getDelta();
  elapsed += deltaTime;

  if (currentMixer) {
    currentMixer.update(deltaTime);
  }

  if (currentVrm) {
    currentVrm.update(deltaTime);

    // Collect per-frame diagnostics (every frame)
    frameCount++;
    const diag = collectFrameDiagnostics(currentVrm, elapsed);
    diagHistory.push(diag);
    if (diagHistory.length > MAX_DIAG_HISTORY) diagHistory.shift();

    // Update panel at ~10fps to avoid layout thrashing
    if (elapsed - lastDiagTime > 0.1) {
      lastDiagTime = elapsed;
      updateDebugPanel(diag);
      updateMarkers(diag);
    }
  }

  renderer.render(scene, camera);
}

// Use both rAF and setInterval to ensure animation runs even when tab is hidden
function rafLoop() {
  requestAnimationFrame(rafLoop);
  animate();
}
rafLoop();

// Fallback interval for when rAF is throttled (tab not focused)
setInterval(() => {
  if (diagHistory.length === 0 || (elapsed > 1 && diagHistory.length < 10)) {
    animate();
  }
}, 33);

// -----------------------------------------------------------
// GUI
// -----------------------------------------------------------
const gui = new GUI();
const params = {
  timeScale: 1.0,
  showMarkers: true,
  logSnapshot: () => {
    const diag = diagHistory[diagHistory.length - 1];
    console.log('[SNAPSHOT]', JSON.parse(JSON.stringify(diag)));
  },
  logFullHistory: () => {
    console.log('[FULL HISTORY]', JSON.parse(JSON.stringify(diagHistory)));
  },
  logRetargetInfo: () => {
    console.log('[RETARGET INFO]', retargetDebugInfo);
  },
  logBoneChainLengths: () => {
    if (!currentVrm) return;
    const vrm = currentVrm;
    const bones = ['hips', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];
    const positions = {};
    for (const name of bones) {
      const node = vrm.humanoid.getNormalizedBoneNode(name);
      if (node) {
        const wp = new THREE.Vector3();
        node.getWorldPosition(wp);
        positions[name] = wp;
      }
    }
    console.log('[BONE CHAIN LENGTHS]', {
      leftUpper: positions.hips?.distanceTo(positions.leftLowerLeg),
      leftLower: positions.leftLowerLeg?.distanceTo(positions.leftFoot),
      leftTotal: positions.hips?.distanceTo(positions.leftFoot),
      rightUpper: positions.hips?.distanceTo(positions.rightLowerLeg),
      rightLower: positions.rightLowerLeg?.distanceTo(positions.rightFoot),
      rightTotal: positions.hips?.distanceTo(positions.rightFoot),
      hipsY: positions.hips?.y,
    });
  },
  pauseResume: () => {
    if (currentAction) {
      currentAction.paused = !currentAction.paused;
    }
  },
};

gui.add(params, 'timeScale', 0.0, 2.0, 0.01).onChange((v) => {
  if (currentMixer) currentMixer.timeScale = v;
});
gui.add(params, 'showMarkers').onChange((v) => {
  floorMarkerLeft.visible = v;
  floorMarkerRight.visible = v;
  hipMarker.visible = v;
  kneeMarkerLeft.visible = v;
  kneeMarkerRight.visible = v;
});
gui.add(params, 'pauseResume').name('Pause/Resume');
gui.add(params, 'logSnapshot').name('Log Frame Snapshot');
gui.add(params, 'logFullHistory').name('Log Full History');
gui.add(params, 'logRetargetInfo').name('Log Retarget Data');
gui.add(params, 'logBoneChainLengths').name('Log Bone Chains');

// -----------------------------------------------------------
// GLOBAL DEBUG API
// -----------------------------------------------------------
window.__VRM_DEBUG__ = window.__VRM_DEBUG__ || {};
Object.assign(window.__VRM_DEBUG__, {
  getDiagHistory: () => diagHistory,
  getLatestDiag: () => diagHistory[diagHistory.length - 1],
  getRetargetInfo: () => retargetDebugInfo,
  getVRM: () => currentVrm,
  getMixer: () => currentMixer,
  getAction: () => currentAction,
  // Compare min/max foot heights over last N frames
  getFootRange: (frames = 100) => {
    const recent = diagHistory.slice(-frames);
    let minL = Infinity, maxL = -Infinity;
    let minR = Infinity, maxR = -Infinity;
    for (const d of recent) {
      minL = Math.min(minL, d.metrics.leftFootY);
      maxL = Math.max(maxL, d.metrics.leftFootY);
      minR = Math.min(minR, d.metrics.rightFootY);
      maxR = Math.max(maxR, d.metrics.rightFootY);
    }
    return {
      leftFoot: { min: minL, max: maxL, range: maxL - minL },
      rightFoot: { min: minR, max: maxR, range: maxR - minR },
    };
  },
  // Get compression extremes
  getCompressionRange: (frames = 100) => {
    const recent = diagHistory.slice(-frames);
    let minL = Infinity, maxL = -Infinity;
    let minR = Infinity, maxR = -Infinity;
    for (const d of recent) {
      minL = Math.min(minL, d.metrics.leftCompression);
      maxL = Math.max(maxL, d.metrics.leftCompression);
      minR = Math.min(minR, d.metrics.rightCompression);
      maxR = Math.max(maxR, d.metrics.rightCompression);
    }
    return {
      left: { min: minL, max: maxL },
      right: { min: minR, max: maxR },
    };
  },
  // Get hips lateral range
  getHipsRange: (frames = 100) => {
    const recent = diagHistory.slice(-frames);
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    for (const d of recent) {
      minX = Math.min(minX, d.metrics.hipsX);
      maxX = Math.max(maxX, d.metrics.hipsX);
      minY = Math.min(minY, d.metrics.hipsY);
      maxY = Math.max(maxY, d.metrics.hipsY);
    }
    return {
      x: { min: minX, max: maxX, range: maxX - minX },
      y: { min: minY, max: maxY, range: maxY - minY },
    };
  },
});

// -----------------------------------------------------------
// RESIZE
// -----------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// -----------------------------------------------------------
// DRAG & DROP (for testing other FBX files)
// -----------------------------------------------------------
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = e.dataTransfer.files;
  if (!files || !files[0]) return;
  const file = files[0];
  const ext = file.name.split('.').pop().toLowerCase();
  const url = URL.createObjectURL(new Blob([file], { type: 'application/octet-stream' }));
  if (ext === 'fbx') {
    loadAnimation(url);
  } else if (ext === 'vrm') {
    loadVRM(url);
  }
});

// -----------------------------------------------------------
// KICK OFF
// -----------------------------------------------------------
loadVRM(MODEL_URL);
