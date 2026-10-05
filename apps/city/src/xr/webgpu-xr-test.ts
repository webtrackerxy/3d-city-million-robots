import {
  BoxGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  cos,
  float,
  Fn,
  instancedArray,
  instanceIndex,
  positionLocal,
  sin,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { MeshStandardNodeMaterial, WebGPURenderer } from 'three/webgpu';

export const MAX_WALKERS = 50_000;

/** One VR session of the A/B test. */
export interface XrRun {
  renderer: 'WebGPU' | 'WebGL';
  /** Seconds in the session, frames per second (mean and the slowest one-second window). */
  seconds: number;
  meanFps: number;
  minFps: number;
  walkers: number;
  /** Whether the session rendered through WebGPU (the 'webgpu' feature on a WebGPU backend). */
  webgpu: boolean;
}

/** Either side of the A/B test. */
export interface XrTest {
  renderer: 'WebGPU' | 'WebGL';
  setWalkers(count: number): void;
  /** Starts an immersive-vr session; rejects if the browser refuses it. */
  enterVr(): Promise<void>;
  dispose(): void;
}

/**
 * The walkers both sides draw, identical so the A/B comparison is fair: circle centre (x, z) over
 * a 160 m square around the viewer, radius 2–10 m, start angle.
 */
export function walkerStates(): Float32Array {
  const state = new Float32Array(MAX_WALKERS * 4);
  let seed = 7;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < MAX_WALKERS; i++) {
    state[i * 4] = (random() - 0.5) * 160;
    state[i * 4 + 1] = (random() - 0.5) * 160;
    state[i * 4 + 2] = 2 + random() * 8;
    state[i * 4 + 3] = random() * Math.PI * 2;
  }
  return state;
}

/**
 * The XR plan's Phase 0 WebGPU test: a WebGPU renderer with XR enabled, and up to 50k pillars
 * walking in circles, moved by a compute pass every frame like the crowd. Entering VR asks for the
 * 'webgpu' session feature, so success means this browser can present the city's renderer in XR.
 */
export async function startWebgpuXrTest(
  canvas: HTMLCanvasElement,
  onRun: (run: XrRun) => void,
): Promise<XrTest> {
  const renderer = new WebGPURenderer({ canvas, antialias: true });
  // Before init: three requests an XR-compatible adapter when XR is enabled.
  renderer.xr.enabled = true;
  await renderer.init();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const scene = new Scene();
  scene.background = new Color(0x9fb7cc);
  scene.add(new HemisphereLight(0xdfe8ff, 0x3a3f46, 1.8));
  const sun = new DirectionalLight(0xffffff, 2.2);
  sun.position.set(-30, 60, 20);
  scene.add(sun);
  const ground = new Mesh(
    new PlaneGeometry(400, 400),
    new MeshStandardMaterial({ color: 0x6b7480 }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const walkers = instancedArray(walkerStates(), 'vec4');
  const dt = uniform(0);
  // About 1.3 m/s along each circle.
  const step = Fn(() => {
    const w = walkers.element(instanceIndex);
    w.assign(vec4(w.x, w.y, w.z, w.w.add(dt.mul(1.3).div(w.z))));
  })().compute(MAX_WALKERS);

  const material = new MeshStandardNodeMaterial({ color: 0xd8a24a });
  const w = walkers.element(instanceIndex);
  material.positionNode = positionLocal.add(
    vec3(w.x.add(cos(w.w).mul(w.z)), float(0.85), w.y.add(sin(w.w).mul(w.z))),
  );
  const pillars = new InstancedMesh(new BoxGeometry(0.45, 1.7, 0.3), material, MAX_WALKERS);
  pillars.frustumCulled = false;
  pillars.count = 10_000;
  scene.add(pillars);

  const camera = new PerspectiveCamera(60, 1, 0.05, 1000);
  camera.position.set(0, 12, 30);
  const controls = new OrbitControls(camera, canvas);
  controls.update();

  const resize = () => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  // Frame rate while presenting: whole-session mean and the slowest one-second window.
  let run: {
    start: number;
    frames: number;
    windowStart: number;
    windowFrames: number;
    min: number;
  } | null = null;
  let last = performance.now();
  void renderer.setAnimationLoop(() => {
    const now = performance.now();
    dt.value = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!renderer.xr.isPresenting) controls.update();
    void renderer.compute(step);
    renderer.render(scene, camera);
    if (run !== null) {
      run.frames++;
      run.windowFrames++;
      if (now - run.windowStart >= 1000) {
        run.min = Math.min(run.min, (run.windowFrames * 1000) / (now - run.windowStart));
        run.windowStart = now;
        run.windowFrames = 0;
      }
    }
  });

  return {
    renderer: 'WebGPU',
    setWalkers(count) {
      pillars.count = Math.max(0, Math.min(MAX_WALKERS, Math.round(count)));
    },
    async enterVr() {
      if (navigator.xr === undefined) throw new Error('No WebXR in this browser.');
      const session = await navigator.xr.requestSession('immersive-vr', {
        requiredFeatures: ['webgpu'],
        optionalFeatures: ['local-floor'],
      });
      const now = performance.now();
      run = { start: now, frames: 0, windowStart: now, windowFrames: 0, min: Infinity };
      session.addEventListener('end', () => {
        if (run === null) return;
        const seconds = (performance.now() - run.start) / 1000;
        onRun({
          renderer: 'WebGPU',
          seconds,
          meanFps: run.frames / Math.max(seconds, 1e-3),
          minFps: Number.isFinite(run.min) ? run.min : run.frames / Math.max(seconds, 1e-3),
          walkers: pillars.count,
          webgpu:
            (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true &&
            session.enabledFeatures?.includes('webgpu') === true,
        });
        run = null;
      });
      await renderer.xr.setSession(session);
    },
    dispose() {
      void renderer.setAnimationLoop(null);
      observer.disconnect();
      controls.dispose();
      pillars.geometry.dispose();
      material.dispose();
      ground.geometry.dispose();
      ground.material.dispose();
      void renderer.dispose();
    },
  };
}
