import type { MetricsBus } from '@city/metrics';
import {
  applyLodControls,
  createGpuCrowd,
  type GpuCrowd,
  type LoadedFamily,
  LOD_FADE_MS,
  prepareCrowdFamilies,
  updateCrowdView,
} from '@city/render';
import { WebGPURenderer } from 'three/webgpu';
import { RenderPathKind } from '../harness/scenario.ts';
import type { GpuTimeSink, LodControls, RenderPath } from './render-path.ts';
import { Stage } from './stage.ts';
import { publishVisibleCounts, READBACK_INTERVAL_MS } from './visible-stats.ts';
import { layoutLineup, layoutWalkers } from './walkers.ts';

const MIN_CAPACITY = 1024;

/**
 * Path B (implementation plan §I.3, §8, §9): the production path on Three.js. See gpu-crowd.ts
 * for the GPU pipeline. The CPU per frame only updates a handful of uniforms and records one
 * compute pass and one indirect draw per (LOD, sub-mesh); nothing scales with agent count.
 */
export async function createPathB(
  canvas: HTMLCanvasElement,
  device: GPUDevice,
  families: readonly LoadedFamily[],
  robotShare: number,
  seed: number,
  tint: boolean,
  lineup: boolean,
  bus: MetricsBus,
  onGpuMs: GpuTimeSink,
): Promise<RenderPath> {
  const trackTimestamp = device.features.has('timestamp-query');
  const renderer = new WebGPURenderer({ canvas, device, antialias: false, trackTimestamp });
  await renderer.init();
  const stage = new Stage(renderer, canvas, trackTimestamp);

  // Impostor atlases are rendered on this renderer's device, once per family (step 0.8).
  const crowdFamilies = prepareCrowdFamilies(renderer, families, tint, bus);
  const startMs = performance.now();
  const simTimeMs = (): number => Math.floor(performance.now() - startMs) >>> 0;
  const walkerFamilies = families.map((family) => ({
    robot: family.robot,
    clipIndex: family.source.clipIndex,
    clipSpeed: family.baked.clipSpeed,
  }));
  const tallest = Math.max(...families.map((family) => family.source.height));

  let crowd: GpuCrowd | null = null;
  let count = 0;
  let controls: LodControls = {
    forced: null,
    impostors: true,
    preset: 'brief',
    debugColours: false,
    fade: true,
    fadeMs: LOD_FADE_MS,
  };
  let visibleTriangles = 0;
  let lastReadback = 0;
  let readbackPending = false;

  const applyControls = (target: GpuCrowd): void => {
    applyLodControls(target, controls);
  };

  const setAgentCount = (next: number): void => {
    if (crowd === null || next > crowd.capacity) {
      crowd?.dispose();
      crowd = createGpuCrowd({
        capacity: Math.max(MIN_CAPACITY, 2 ** Math.ceil(Math.log2(Math.max(1, next)))),
        families: crowdFamilies,
        scene: stage.scene,
      });
      applyControls(crowd);
    }
    count = next;
    const layout = (lineup ? layoutLineup : layoutWalkers)(
      next,
      crowd.capacity,
      seed,
      walkerFamilies,
      robotShare,
      simTimeMs(),
    );
    crowd.setActive(layout.records, layout.edges, next);
    if (lineup) stage.frameLineup(layout.areaSize, tallest);
    else stage.frameStreet(layout.areaSize, tallest);
  };

  const updateView = (target: GpuCrowd): void => {
    updateCrowdView(target, stage.camera, canvas.height, simTimeMs());
  };

  const readVisibleCounts = (target: GpuCrowd): void => {
    const now = performance.now();
    if (readbackPending || now - lastReadback < READBACK_INTERVAL_MS) return;
    readbackPending = true;
    lastReadback = now;
    void renderer
      .getArrayBufferAsync(target.stats)
      .then((buffer) => {
        visibleTriangles = publishVisibleCounts(new Uint32Array(buffer), families, bus);
      })
      .catch(() => {
        // Device lost or the crowd was rebuilt mid-readback; the next readback recovers.
      })
      .finally(() => {
        readbackPending = false;
      });
  };

  return {
    kind: RenderPathKind.B,
    setAgentCount,
    agentCount: () => count,
    resize(cssWidth, cssHeight, pixelRatio) {
      stage.resize(cssWidth, cssHeight, pixelRatio);
    },
    setLodControls(next) {
      controls = next;
      if (crowd !== null) applyControls(crowd);
    },
    frame() {
      const encodeStart = performance.now();
      if (crowd !== null && count > 0) {
        updateView(crowd);
        void renderer.compute(crowd.passes);
      }
      const animMs = performance.now() - encodeStart;
      const drawn = stage.render();
      stage.resolveGpuTime(onGpuMs, true);
      if (crowd !== null && count > 0) readVisibleCounts(crowd);
      // Three counts indirect draws with their CPU-side instance count, so report the GPU's.
      return { animMs, drawCalls: drawn.drawCalls, triangles: visibleTriangles };
    },
    dispose() {
      crowd?.dispose();
      stage.dispose();
      void renderer.dispose();
    },
  };
}
