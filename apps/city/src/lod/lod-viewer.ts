import { type CharacterSource, buildLodChain } from '@city/render';
import {
  AnimationMixer,
  Box3,
  Color,
  DirectionalLight,
  GridHelper,
  HemisphereLight,
  type Material,
  MeshBasicMaterial,
  type Object3D,
  PerspectiveCamera,
  Scene,
  SkinnedMesh,
  Vector3,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { WebGPURenderer } from 'three/webgpu';

export interface LodLabel {
  lod: number;
  x: number;
  y: number;
  visible: boolean;
}

export interface ViewerStats {
  fps: number;
  drawCalls: number;
  triangles: number;
}

export interface LodViewer {
  /** Shows a character's LOD chain side by side (LOD0 on the left), playing `clip`. */
  show(source: CharacterSource, targets: readonly number[], clip: string): Promise<number[]>;
  setClip(clip: string): void;
  setWireframe(on: boolean): void;
  setSpeed(speed: number): void;
  dispose(): void;
}

/** Spacing between the LODs, metres. */
const SPACING = 1.3;

/**
 * The LOD test scene: every mesh LOD of one character as a real skinned mesh (the same simplified
 * geometry the crowd bakes and instances), animated in step, with orbit controls.
 */
export async function startLodViewer(
  canvas: HTMLCanvasElement,
  onLabels: (labels: LodLabel[]) => void,
  onStats: (stats: ViewerStats) => void,
): Promise<LodViewer> {
  const renderer = new WebGPURenderer({ canvas, antialias: true });
  await renderer.init();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new Scene();
  scene.background = new Color(0x1a222c);
  scene.add(new HemisphereLight(0xe8eeff, 0x3a3f46, 1.8));
  const sun = new DirectionalLight(0xffffff, 2.2);
  sun.position.set(3, 6, 5);
  scene.add(sun);
  const grid = new GridHelper(20, 20, 0x4a5868, 0x2c3642);
  scene.add(grid);

  const camera = new PerspectiveCamera(40, 1, 0.05, 200);
  // Aimed left of the line-up, so the models clear the panel on the left.
  camera.position.set(-1.2, 1.4, 7.5);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(-1.2, 0.9, 0);
  controls.enableDamping = true;
  controls.update();

  let models: { root: Object3D; mixer: AnimationMixer; head: Vector3 }[] = [];
  let source: CharacterSource | null = null;
  let wireframe = false;
  let speed = 1;
  /**
   * Wireframe draws every LOD with one plain line material: drawn with the model's own (textured)
   * materials, a dense mesh's lines show the texture instead of the triangles.
   */
  const wire = new MeshBasicMaterial({ color: 0x7fe3ec, wireframe: true });
  let meshes: { mesh: SkinnedMesh; own: Material | Material[] }[] = [];
  const applyWireframe = () => {
    for (const { mesh, own } of meshes)
      mesh.material = !wireframe ? own : Array.isArray(own) ? own.map(() => wire) : wire;
  };

  const play = (clip: string) => {
    const animation = source?.clips.find((c) => c.name === clip) ?? source?.clip;
    if (animation === undefined) return;
    for (const model of models) {
      model.mixer.stopAllAction();
      model.mixer.clipAction(animation).play();
      model.mixer.setTime(0);
    }
  };

  let width = 0;
  let height = 0;
  let frames = 0;
  let last = performance.now();
  let previous = performance.now();
  const projected = new Vector3();
  void renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - previous) / 1000);
    previous = now;
    if (canvas.clientWidth !== width || canvas.clientHeight !== height) {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix();
    }
    for (const model of models) model.mixer.update(dt * speed);
    controls.update();
    renderer.info.reset();
    renderer.render(scene, camera);
    frames++;
    if (frames % 3 === 0)
      onLabels(
        models.map((model, lod) => {
          projected.copy(model.head).project(camera);
          return {
            lod,
            x: ((projected.x + 1) / 2) * width,
            y: ((1 - projected.y) / 2) * height,
            visible: projected.z < 1,
          };
        }),
      );
    if (now - last >= 500) {
      onStats({
        fps: (frames * 1000) / (now - last),
        drawCalls: renderer.info.render.drawCalls,
        triangles: renderer.info.render.triangles,
      });
      frames = 0;
      last = now;
    }
  });

  return {
    async show(next, targets, clip) {
      for (const model of models) scene.remove(model.root);
      models = [];
      meshes = [];
      source = next;
      const chain = await buildLodChain(next, targets);
      const bounds = new Box3().setFromObject(next.template, true);
      const top = bounds.max.y;
      const count = chain.geometries.length;
      chain.geometries.forEach((level, lod) => {
        const root = cloneSkinned(next.template);
        let k = 0;
        root.traverse((node) => {
          if (!(node instanceof SkinnedMesh)) return;
          const mesh = node as SkinnedMesh;
          if (k < level.length) mesh.geometry = level[k];
          k++;
          mesh.frustumCulled = false;
          meshes.push({ mesh, own: mesh.material });
        });
        const x = (lod - (count - 1) / 2) * SPACING;
        root.position.x = x;
        scene.add(root);
        models.push({ root, mixer: new AnimationMixer(root), head: new Vector3(x, top + 0.12, 0) });
      });
      applyWireframe();
      play(clip);
      return chain.triangles;
    },
    setClip: play,
    setWireframe(on) {
      wireframe = on;
      applyWireframe();
    },
    setSpeed(next) {
      speed = next;
    },
    dispose() {
      void renderer.setAnimationLoop(null);
      controls.dispose();
      wire.dispose();
      void renderer.dispose();
    },
  };
}
