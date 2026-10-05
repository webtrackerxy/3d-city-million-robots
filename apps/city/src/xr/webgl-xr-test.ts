import {
  BoxGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MAX_WALKERS, walkerStates, type XrRun, type XrTest } from './webgpu-xr-test.ts';

/**
 * The B side of the XR A/B test: the same walkers as the WebGPU test, in WebGL 2 only. WebGL has
 * no compute pass, so each pillar's place on its circle is computed in the vertex shader from the
 * time (the same motion as the compute version). Entering VR asks for a plain immersive-vr session.
 */
export function startWebglXrTest(canvas: HTMLCanvasElement, onRun: (run: XrRun) => void): XrTest {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');

  const scene = new Scene();
  scene.background = new Color(0x9fb7cc);
  scene.add(new HemisphereLight(0xdfe8ff, 0x3a3f46, 1.8));
  const sun = new DirectionalLight(0xffffff, 2.2);
  sun.position.set(-30, 60, 20);
  scene.add(sun);
  const ground = new Mesh(
    new PlaneGeometry(400, 400),
    new MeshLambertMaterial({ color: 0x6b7480 }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const geometry = new BoxGeometry(0.45, 1.7, 0.3);
  geometry.setAttribute('aWalker', new InstancedBufferAttribute(walkerStates(), 4));
  const time = { value: 0 };
  const material = new MeshLambertMaterial({ color: 0xd8a24a });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime;
// circle centre x, z (m), radius (m), start angle (rad)
attribute vec4 aWalker;`,
      )
      .replace(
        '#include <begin_vertex>',
        `float walkerAngle = aWalker.w + uTime * 1.3 / aWalker.z;
vec3 transformed = position + vec3(aWalker.x + cos(walkerAngle) * aWalker.z, 0.85,
  aWalker.y + sin(walkerAngle) * aWalker.z);`,
      );
  };
  material.customProgramCacheKey = () => 'xr-ab-walkers';
  const pillars = new InstancedMesh(geometry, material, MAX_WALKERS);
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

  const start = performance.now();
  let run: {
    start: number;
    frames: number;
    windowStart: number;
    windowFrames: number;
    min: number;
  } | null = null;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    time.value = (now - start) / 1000;
    if (!renderer.xr.isPresenting) controls.update();
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
    renderer: 'WebGL',
    setWalkers(count) {
      pillars.count = Math.max(0, Math.min(MAX_WALKERS, Math.round(count)));
    },
    async enterVr() {
      if (navigator.xr === undefined) throw new Error('No WebXR in this browser.');
      const session = await navigator.xr.requestSession('immersive-vr', {
        optionalFeatures: ['local-floor'],
      });
      const now = performance.now();
      run = { start: now, frames: 0, windowStart: now, windowFrames: 0, min: Infinity };
      session.addEventListener('end', () => {
        if (run === null) return;
        const seconds = (performance.now() - run.start) / 1000;
        const mean = run.frames / Math.max(seconds, 1e-3);
        onRun({
          renderer: 'WebGL',
          seconds,
          meanFps: mean,
          minFps: Number.isFinite(run.min) ? run.min : mean,
          walkers: pillars.count,
          webgpu: false,
        });
        run = null;
      });
      await renderer.xr.setSession(session);
    },
    dispose() {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      controls.dispose();
      geometry.dispose();
      material.dispose();
      ground.geometry.dispose();
      ground.material.dispose();
      renderer.dispose();
    },
  };
}
