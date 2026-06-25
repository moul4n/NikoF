import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

// Guards the HDR buffer before bloom: a single non-finite fragment (NaN/Inf from
// a degenerate normal or skinning value on some models) would otherwise be blurred
// by UnrealBloomPass across the whole frame, flashing the entire image black for a
// frame. max() drops NaN to 0 (ANGLE/D3D treats NaN as the missing operand) and
// min() clamps Inf / runaway HDR to a sane ceiling. Alpha is preserved so the
// transparent floating mode still composites.
const SanitizeHdrShader = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 rgb = min(max(texel.rgb, vec3(0.0)), vec3(64.0));
      float a = min(max(texel.a, 0.0), 1.0);
      gl_FragColor = vec4(rgb, a);
    }
  `
};

/**
 * Display-only render-quality stack.
 *
 * The avatar runtime renders the same VRM in two contexts: a lightweight
 * embedded/operator preview and the dedicated full-window "display" surface
 * (also what the Tauri desktop shell hosts). Only the display surface pays for
 * the extra fidelity here, so this controller is instantiated ONLY for the
 * display variant and the embedded preview keeps its original lean pipeline.
 *
 * Two layers:
 *   1. Shadows + resolution (always on for display): a ground contact shadow
 *      (the largest perceptual "grounding" win), soft self-shadowing, and a
 *      higher device-pixel-ratio cap. These need no post-processing.
 *   2. Post chain (EffectComposer): tone mapping + subtle rim bloom + SMAA.
 *
 * MToon/NPR caveat: tone mapping can shift the authored toon palette. We default
 * to NeutralToneMapping (Khronos PBR-neutral), which preserves saturation far
 * better than ACES, with gentle bloom — all tunable below and easy to disable.
 * Tone mapping is applied exactly once, by OutputPass at the end of the chain:
 * three skips in-shader tone mapping while rendering into a render target, so
 * there is no double application with the per-material `toneMapped` flag.
 */
export interface RenderQualityOptions {
  /** Master switch for the shadow map + ground catcher + avatar self-shadowing. */
  shadows: boolean;
  /** Opacity of the ground contact-shadow puddle (0 = invisible, 1 = black). */
  groundShadowOpacity: number;
  /** Directional shadow map resolution (square). Higher = softer/crisper, costlier. */
  shadowMapSize: number;
  /** Upper bound on renderer.setPixelRatio for the display surface. */
  maxPixelRatio: number;
  /** Master switch for the EffectComposer post chain (tone mapping + bloom + SMAA). */
  postProcessing: boolean;
  /** Tone-mapping operator. Neutral preserves toon saturation; ACES is more filmic. */
  toneMapping: THREE.ToneMapping;
  /** Tone-mapping exposure multiplier (1.0 = neutral). */
  toneMappingExposure: number;
  /** Rim/highlight bloom. Keep subtle on stylized characters. */
  bloom: boolean;
  /** Bloom intensity. */
  bloomStrength: number;
  /** Bloom spread. */
  bloomRadius: number;
  /** Luminance above which pixels bloom (high = only bright highlights glow). */
  bloomThreshold: number;
}

export const DISPLAY_RENDER_QUALITY: RenderQualityOptions = {
  shadows: true,
  groundShadowOpacity: 0.32,
  shadowMapSize: 2048,
  maxPixelRatio: 3,
  postProcessing: true,
  toneMapping: THREE.NeutralToneMapping,
  toneMappingExposure: 1.0,
  bloom: true,
  bloomStrength: 0.2,
  bloomRadius: 0.4,
  bloomThreshold: 0.85,
};

export class RenderQualityController {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly keyLight: THREE.DirectionalLight;
  private readonly options: RenderQualityOptions;
  private groundCatcher: THREE.Mesh<THREE.PlaneGeometry, THREE.ShadowMaterial> | null = null;
  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private smaaPass: SMAAPass | null = null;

  constructor(params: {
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    keyLight: THREE.DirectionalLight;
    options?: Partial<RenderQualityOptions>;
  }) {
    this.renderer = params.renderer;
    this.scene = params.scene;
    this.camera = params.camera;
    this.keyLight = params.keyLight;
    this.options = { ...DISPLAY_RENDER_QUALITY, ...params.options };
  }

  /** The pixel-ratio ceiling for the display surface. */
  get maxPixelRatio(): number {
    return this.options.maxPixelRatio;
  }

  /** Configure shadows, the ground catcher, and the post-processing chain. */
  configure(): void {
    this.configureShadows();
    this.configurePostProcessing();
  }

  private configureShadows(): void {
    if (!this.options.shadows) {
      this.renderer.shadowMap.enabled = false;
      return;
    }

    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const light = this.keyLight;
    light.castShadow = true;
    light.shadow.mapSize.set(this.options.shadowMapSize, this.options.shadowMapSize);

    // The key light sits at ~(1.6, 2.2, 2.8) aimed at the origin, where the
    // avatar's feet are grounded. A tight orthographic frustum around a single
    // standing character keeps the shadow texels dense (= softer edges).
    const shadowCamera = light.shadow.camera as THREE.OrthographicCamera;
    shadowCamera.near = 0.1;
    shadowCamera.far = 14;
    shadowCamera.left = -2.4;
    shadowCamera.right = 2.4;
    shadowCamera.top = 3.2;
    shadowCamera.bottom = -1.2;
    shadowCamera.updateProjectionMatrix();

    // Bias tuned to suppress acne without obvious peter-panning on a humanoid.
    light.shadow.bias = -0.0004;
    light.shadow.normalBias = 0.02;

    this.addGroundCatcher();
  }

  private configurePostProcessing(): void {
    if (!this.options.postProcessing) {
      return;
    }

    // OutputPass reads renderer.toneMapping/exposure and applies them once, at
    // the end of the chain, then converts to the renderer's output color space.
    this.renderer.toneMapping = this.options.toneMapping;
    this.renderer.toneMappingExposure = this.options.toneMappingExposure;

    const composer = new EffectComposer(this.renderer);
    composer.addPass(new RenderPass(this.scene, this.camera));

    // Sanitize the HDR buffer BEFORE bloom so a stray NaN/Inf can't be smeared
    // into a whole-frame black flash (see SanitizeHdrShader).
    composer.addPass(new ShaderPass(SanitizeHdrShader));

    if (this.options.bloom) {
      const bloomPass = new UnrealBloomPass(
        new THREE.Vector2(1, 1),
        this.options.bloomStrength,
        this.options.bloomRadius,
        this.options.bloomThreshold,
      );
      composer.addPass(bloomPass);
      this.bloomPass = bloomPass;
    }

    // Placeholder size; the first handleResize -> setSize sets the real dims.
    const smaaPass = new SMAAPass(1, 1);
    composer.addPass(smaaPass);
    this.smaaPass = smaaPass;

    composer.addPass(new OutputPass());
    this.composer = composer;
  }

  /** A transparent, shadow-only floor plane at y=0 so contact shadows have somewhere to land. */
  private addGroundCatcher(): void {
    if (this.groundCatcher) {
      return;
    }
    const geometry = new THREE.PlaneGeometry(24, 24);
    const material = new THREE.ShadowMaterial({ opacity: this.options.groundShadowOpacity });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0;
    mesh.receiveShadow = true;
    // Keep it behind the avatar in the sort order; it only ever shows shadow.
    mesh.renderOrder = -1;
    mesh.name = "display_ground_shadow_catcher";
    this.groundCatcher = mesh;
    this.scene.add(mesh);
  }

  /** Enable shadow casting/receiving on every mesh of a freshly loaded avatar. */
  applyToAvatar(root: THREE.Object3D): void {
    if (!this.options.shadows) {
      return;
    }
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
  }

  /**
   * Resize the composer to match the renderer. EffectComposer.setSize already
   * propagates to every pass and setPixelRatio scales the internal render
   * targets, so we don't resize bloom/SMAA passes individually.
   */
  setSize(width: number, height: number, pixelRatio: number): void {
    if (!this.composer) {
      return;
    }
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  /**
   * Render this frame through the post chain. Returns false when there is no
   * composer (post-processing disabled), so the caller falls back to a plain
   * renderer.render().
   */
  render(): boolean {
    if (!this.composer) {
      return false;
    }
    this.composer.render();
    return true;
  }

  dispose(): void {
    if (this.groundCatcher) {
      this.scene.remove(this.groundCatcher);
      this.groundCatcher.geometry.dispose();
      this.groundCatcher.material.dispose();
      this.groundCatcher = null;
    }
    this.composer?.dispose();
    this.composer = null;
    this.bloomPass = null;
    this.smaaPass = null;
    this.keyLight.castShadow = false;
    this.renderer.shadowMap.enabled = false;
  }
}
