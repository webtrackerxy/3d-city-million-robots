import { mulberry32 } from '@city/assets-runtime';
import { AnimationMixer, type Object3D } from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { WebGPURenderer } from 'three/webgpu';
import type { LoadedFamily } from '@city/render';
import { RenderPathKind } from '../harness/scenario.ts';
import type { GpuTimeSink, RenderPath } from './render-path.ts';
import { Stage } from './stage.ts';

interface Character {
  object: Object3D;
  mixer: AnimationMixer;
}

/**
 * Path A, the naive baseline (implementation plan §I.3): every character is a
 * SkeletonUtils.clone with its own AnimationMixer, drawn by Three's WebGPURenderer as ordinary
 * SkinnedMeshes. It exists to document where this approach falls over and to be the visual ground
 * truth for the baked paths. Characters animate in place on a grid.
 *
 * The renderer runs on the engine's device, so the allocation tracker sees everything Three
 * allocates.
 */
export async function createPathA(
  canvas: HTMLCanvasElement,
  device: GPUDevice,
  families: readonly LoadedFamily[],
  robotShare: number,
  seed: number,
  onGpuMs: GpuTimeSink,
): Promise<RenderPath> {
  const trackTimestamp = device.features.has('timestamp-query');
  const renderer = new WebGPURenderer({ canvas, device, antialias: false, trackTimestamp });
  await renderer.init();
  const stage = new Stage(renderer, canvas, trackTimestamp);

  const random = mulberry32(seed);
  const humans = families.filter((family) => !family.robot);
  const robot = families.find((family) => family.robot);
  if (humans.length === 0 && robot === undefined) throw new Error('No character family loaded');
  const tallest = Math.max(...families.map((family) => family.source.height));
  const spacing = Math.max(1, tallest * 0.6);
  const characters: Character[] = [];

  const setAgentCount = (count: number): void => {
    while (characters.length > count) {
      const removed = characters.pop();
      if (removed === undefined) break;
      removed.mixer.stopAllAction();
      removed.mixer.uncacheRoot(removed.object);
      stage.scene.remove(removed.object);
    }
    while (characters.length < count) {
      const useRobot = robot !== undefined && (humans.length === 0 || random() < robotShare);
      const family = useRobot ? robot : humans[Math.floor(random() * humans.length)];
      if (family === undefined) throw new Error('unreachable: no family');
      const character = family.source;
      const object = cloneSkinned(character.template);
      // Stale rest-pose bounds would cull animated characters incorrectly; the camera frames the
      // whole grid anyway.
      object.traverse((node) => {
        node.frustumCulled = false;
      });
      object.rotation.y = (random() - 0.5) * 0.6;
      const mixer = new AnimationMixer(object);
      const action = mixer.clipAction(character.clip);
      action.play();
      action.time = random() * character.clip.duration;
      action.timeScale = 0.9 + random() * 0.2;
      stage.scene.add(object);
      characters.push({ object, mixer });
    }

    const side = Math.max(1, Math.ceil(Math.sqrt(count)));
    const offset = ((side - 1) * spacing) / 2;
    characters.forEach((c, index) => {
      const row = Math.floor(index / side);
      const col = index % side;
      c.object.position.set(col * spacing - offset, 0, row * spacing - offset);
    });
    stage.frame(side * spacing, tallest);
  };

  return {
    kind: RenderPathKind.A,
    setAgentCount,
    agentCount: () => characters.length,
    resize(cssWidth, cssHeight, pixelRatio) {
      stage.resize(cssWidth, cssHeight, pixelRatio);
    },
    frame(dtMs) {
      const animStart = performance.now();
      const dt = dtMs / 1000;
      for (const c of characters) c.mixer.update(dt);
      const animMs = performance.now() - animStart;

      const drawn = stage.render();
      stage.resolveGpuTime(onGpuMs, false);
      return { animMs, ...drawn };
    },
    dispose() {
      setAgentCount(0);
      stage.dispose();
      void renderer.dispose();
    },
  };
}
