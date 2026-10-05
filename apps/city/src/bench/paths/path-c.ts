import { GpuPassTimer, type MetricsBus } from '@city/metrics';
import { Color, Frustum, Matrix4, Vector3, WebGPUCoordinateSystem } from 'three';
import { type Texture, WebGPURenderer } from 'three/webgpu';
import {
  bakeImpostors,
  HUMAN_HEIGHT_VARIATION,
  IMPOSTOR_THRESHOLD,
  type LoadedFamily,
  LOD_FADE_MS,
  LOD_THRESHOLDS,
  pxPerRadian,
} from '@city/render';
import { RenderPathKind } from '../harness/scenario.ts';
import { CameraRig } from './camera-rig.ts';
import { createRawCrowd, type RawCrowd, type RawFamily } from './raw/raw-crowd.ts';
import { verifyIntegrateKernel } from './raw/verify-kernel.ts';
import type { GpuTimeSink, LodControls, RenderPath } from './render-path.ts';
import {
  STAGE_BACKGROUND,
  STAGE_GROUND_COLOUR,
  STAGE_GROUND_LIGHT,
  STAGE_HEMISPHERE_INTENSITY,
  STAGE_SKY,
  STAGE_SUN_INTENSITY,
  STAGE_SUN_POSITION,
} from './stage.ts';
import { publishVisibleCounts, READBACK_INTERVAL_MS } from './visible-stats.ts';
import { layoutLineup, layoutWalkers } from './walkers.ts';

const MIN_CAPACITY = 1024;
const LOD_AUTO = 0xff;

/**
 * Path C (implementation plan §I.3, §30): the Path B crowd in hand-written WebGPU, to measure
 * what Three.js costs. Same agent records, bakes, LOD chains, layout and kernels (WGSL ports of
 * the TSL); rendering is one static render bundle, so the per-frame CPU work is a uniform write,
 * one compute pass and one render pass.
 *
 * Three.js is used only at load time, to bake the impostor atlases on the same device.
 */
export async function createPathC(
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
  const context = canvas.getContext('webgpu');
  if (context === null) throw new Error('Canvas does not support a WebGPU context');
  const colourFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format: colourFormat, alphaMode: 'opaque' });

  const check = await verifyIntegrateKernel(device);
  bus.setGauge('kernel.integrate.maxError', check.maxPositionError);
  bus.setGauge('kernel.integrate.frameMismatches', check.frameMismatches);
  bus.setGauge('kernel.integrate.checked', check.checked);

  // Load-time only: bake impostor atlases with Three on this device, then use its GPU textures.
  const bakeCanvas = document.createElement('canvas');
  const baker = new WebGPURenderer({ canvas: bakeCanvas, device, antialias: false });
  await baker.init();
  const gpuTexture = (texture: Texture | null | undefined): GPUTexture | null => {
    if (texture == null) return null;
    const data = (baker.backend as unknown as { get(o: object): { texture?: GPUTexture } }).get(
      texture,
    );
    return data.texture ?? null;
  };

  const rawFamilies: RawFamily[] = families.map((family) => {
    const lods = family.lodChain?.geometries;
    if (lods === undefined) throw new Error(`Path C needs LODs for ${family.key}`);
    const lod2 = lods[2];
    const atlas =
      lod2 === undefined
        ? null
        : bakeImpostors(baker, {
            template: family.source.template,
            clip: family.source.clip,
            geometries: lod2,
            meshes: family.source.meshes,
            height: family.source.height,
          });
    if (atlas !== null) {
      bus.setGauge(`impostor.${family.key}.bakeMs`, atlas.bakeMs);
      bus.setGauge(`impostor.${family.key}.bytes`, atlas.bytes);
    }
    const albedo = gpuTexture(atlas?.albedo);
    const normal = gpuTexture(atlas?.normal);
    const mask = gpuTexture(atlas?.mask);
    return {
      animation: family.baked.baked,
      lods,
      materials: family.source.meshes.map((mesh) => mesh.material),
      // Albedo maps were uploaded by the bake's albedo pass.
      maps: family.source.meshes.map((mesh) => {
        const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        return gpuTexture((material as { map?: Texture | null } | undefined)?.map);
      }),
      influences: family.source.influences,
      height: family.source.height,
      forwardAngle: Math.atan2(family.baked.forward[0], family.baked.forward[1]),
      robot: family.robot,
      heightVariation: family.robot || !tint ? 0 : HUMAN_HEIGHT_VARIATION,
      impostor:
        atlas !== null && albedo !== null && normal !== null && mask !== null
          ? { atlas, albedo, normal, mask }
          : null,
    };
  });

  const rig = new CameraRig(canvas);
  rig.camera.coordinateSystem = WebGPUCoordinateSystem;
  rig.camera.updateProjectionMatrix();
  const lights = {
    sky: linear(STAGE_SKY),
    ground: linear(STAGE_GROUND_LIGHT),
    hemisphere: STAGE_HEMISPHERE_INTENSITY,
    sun: STAGE_SUN_INTENSITY,
  };
  const sunDirection = new Vector3(...STAGE_SUN_POSITION).normalize();
  const background = new Color(STAGE_BACKGROUND);
  const groundColour = new Color(STAGE_GROUND_COLOUR);

  const walkerFamilies = families.map((family) => ({
    robot: family.robot,
    clipIndex: family.source.clipIndex,
    clipSpeed: family.baked.clipSpeed,
  }));
  const tallest = Math.max(...families.map((family) => family.source.height));
  const startMs = performance.now();
  const simTimeMs = (): number => Math.floor(performance.now() - startMs) >>> 0;

  let crowd: RawCrowd | null = null;
  let count = 0;
  let controls: LodControls = {
    forced: null,
    impostors: true,
    preset: 'brief',
    debugColours: false,
    fade: true,
    fadeMs: LOD_FADE_MS,
  };
  let depth: GPUTexture | null = null;
  let visibleTriangles = 0;

  const statsStaging = device.createBuffer({
    label: 'raw stats readback',
    size: 1024,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  let readbackPending = false;
  let lastReadback = 0;

  const computeTimer = GpuPassTimer.isSupported(device)
    ? new GpuPassTimer(device, 'raw compute')
    : null;
  const renderTimer = GpuPassTimer.isSupported(device)
    ? new GpuPassTimer(device, 'raw render')
    : null;
  let lastComputeMs = 0;

  const frustum = new Frustum();
  const viewProjection = new Matrix4();

  const setAgentCount = (next: number): void => {
    if (crowd === null || next > crowd.capacity) {
      crowd?.dispose();
      crowd = createRawCrowd({
        device,
        colourFormat,
        capacity: Math.max(MIN_CAPACITY, 2 ** Math.ceil(Math.log2(Math.max(1, next)))),
        families: rawFamilies,
        lights,
        groundColour,
      });
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
    const ground = lineup
      ? rig.frameLineup(layout.areaSize, tallest)
      : rig.frameStreet(layout.areaSize, tallest);
    crowd.setGroundExtent(ground);
  };

  return {
    kind: RenderPathKind.C,
    setAgentCount,
    agentCount: () => count,
    resize(cssWidth, cssHeight, pixelRatio) {
      canvas.width = Math.max(1, Math.round(cssWidth * pixelRatio));
      canvas.height = Math.max(1, Math.round(cssHeight * pixelRatio));
      rig.setAspect(cssWidth / Math.max(1, cssHeight));
      depth?.destroy();
      depth = device.createTexture({
        label: 'raw depth',
        size: [canvas.width, canvas.height],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
    },
    setLodControls(next) {
      controls = next;
    },
    frame() {
      const cpuStart = performance.now();
      const active = crowd;
      if (active === null || depth === null) return { animMs: 0, drawCalls: 0, triangles: 0 };

      rig.update();
      const camera = rig.camera;
      viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(viewProjection, WebGPUCoordinateSystem);
      const thresholds = LOD_THRESHOLDS[controls.preset];
      active.writeParams({
        cameraPosition: [camera.position.x, camera.position.y, camera.position.z],
        simTimeMs: simTimeMs(),
        planes: frustum.planes.map(
          (plane) =>
            [plane.normal.x, plane.normal.y, plane.normal.z, plane.constant] as [
              number,
              number,
              number,
              number,
            ],
        ),
        lodThresholds: thresholds,
        pxPerRadian: pxPerRadian(canvas.height, (camera.fov * Math.PI) / 180),
        impostorPx: controls.impostors ? IMPOSTOR_THRESHOLD[controls.preset] : 0,
        fadeMs: controls.fade ? controls.fadeMs : 0,
        forcedLod: controls.forced ?? LOD_AUTO,
        debugColours: controls.debugColours,
        viewProjection: viewProjection.elements,
        sunDirection: [sunDirection.x, sunDirection.y, sunDirection.z],
      });

      const encoder = device.createCommandEncoder({ label: 'raw frame' });
      const computePass = encoder.beginComputePass({
        label: 'raw crowd compute',
        ...(computeTimer === null ? {} : { timestampWrites: computeTimer.timestampWrites }),
      });
      active.encodeCompute(computePass);
      computePass.end();
      computeTimer?.resolve(encoder);

      const renderPass = encoder.beginRenderPass({
        label: 'raw crowd render',
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            clearValue: srgbClear(background),
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
        depthStencilAttachment: {
          view: depth.createView(),
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
        },
        ...(renderTimer === null ? {} : { timestampWrites: renderTimer.timestampWrites }),
      });
      renderPass.executeBundles([active.bundle()]);
      renderPass.end();
      renderTimer?.resolve(encoder);

      const now = performance.now();
      const readStats = !readbackPending && now - lastReadback >= READBACK_INTERVAL_MS;
      if (readStats)
        encoder.copyBufferToBuffer(active.stats, 0, statsStaging, 0, active.statsBytes);
      device.queue.submit([encoder.finish()]);

      computeTimer?.readback((ms) => {
        lastComputeMs = ms;
      });
      renderTimer?.readback((ms) => {
        onGpuMs(ms + lastComputeMs);
      });
      if (readStats) {
        readbackPending = true;
        lastReadback = now;
        const bytes = active.statsBytes;
        statsStaging
          .mapAsync(GPUMapMode.READ, 0, bytes)
          .then(() => {
            const values = new Uint32Array(statsStaging.getMappedRange(0, bytes).slice(0));
            statsStaging.unmap();
            visibleTriangles = publishVisibleCounts(values, families, bus);
          })
          .catch(() => {
            // Device lost mid-readback; nothing to report.
          })
          .finally(() => {
            readbackPending = false;
          });
      }

      return {
        animMs: performance.now() - cpuStart,
        drawCalls: active.drawCount,
        triangles: visibleTriangles,
      };
    },
    dispose() {
      crowd?.dispose();
      depth?.destroy();
      computeTimer?.destroy();
      renderTimer?.destroy();
      statsStaging.destroy();
      rig.dispose();
      void baker.dispose();
      context.unconfigure();
    },
  };
}

function linear(hex: number): [number, number, number] {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
}

/** The canvas is not an sRGB format, so clear with the sRGB-encoded background. */
function srgbClear(colour: Color): GPUColor {
  const encoded = colour.clone().convertLinearToSRGB();
  return { r: encoded.r, g: encoded.g, b: encoded.b, a: 1 };
}
