import { createGpuTraffic, type GpuTraffic, pxPerRadian } from '@city/render';
import { Frustum, Matrix4, type PerspectiveCamera, type Scene, Vector3 } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { loadVehicle } from './load-vehicle.ts';
import {
  CONTROL,
  CONTROL_WORDS,
  type FromTrafficWorker,
  TICK_MS,
  type ToTrafficWorker,
} from './protocol.ts';

export interface TrafficStats {
  cars: number;
  roadKm: number;
  /** Cars drawn per mesh LOD, then as boxes. */
  drawn: number[];
  /** Traffic worker time per tick, ms. */
  stepMs: number;
}

export interface TrafficLayer {
  frame(camera: PerspectiveCamera, drawingBufferHeight: number): void;
  setTimeScale(scale: number): void;
  /** The car drawn nearest a screen point (normalised device coordinates) within `maxPx`, or null. */
  pickCar(
    viewProjection: Matrix4,
    ndcX: number,
    ndcY: number,
    width: number,
    height: number,
    maxPx: number,
  ): { car: number; px: number } | null;
  /** Where a car is (Three coordinates), its speed, heading (clockwise from north) and paint. */
  carInfo(car: number): CarInfo | null;
  /** The cars within `radius` metres of (x, z), nearest first, at most `max` (Map XR on WebGL). */
  carsNear(x: number, z: number, radius: number, max: number): number[];
  /** A car's position and yaw about +Y (model forward +Z) into `out`, from the latest snapshot. */
  carPose(car: number, out: { x: number; y: number; z: number; yaw: number }): boolean;
  /** A car's paint colour (linear RGB). */
  carPaint(car: number): [number, number, number];
  stats(): TrafficStats;
  dispose(): void;
}

export interface CarInfo {
  position: Vector3;
  speedMps: number;
  headingRad: number;
  colour: string;
}

/** Names for the paint palette below, in order. */
const PAINT_NAMES = [
  'silver',
  'black',
  'grey',
  'red',
  'blue',
  'white',
  'gold',
  'green',
  'brown',
  'teal',
  'orange',
  'purple',
  'pale silver',
  'charcoal',
  'maroon',
  'navy',
];

/** The cars project's LOD policy (src/config/lodConfig.ts) and paint palette. */
const MIN_PIXELS = [220, 70, 18, 5, 1.5];
const CAPS = [20, 300, 1500, 8000];
const BOUNDING_RADIUS = 2.6;
const PALETTE: [number, number, number][] = [
  [0.85, 0.85, 0.85],
  [0.05, 0.05, 0.06],
  [0.35, 0.37, 0.42],
  [0.55, 0.05, 0.04],
  [0.04, 0.12, 0.45],
  [0.9, 0.9, 0.92],
  [0.6, 0.45, 0.08],
  [0.06, 0.28, 0.12],
  [0.5, 0.2, 0.05],
  [0.02, 0.35, 0.45],
  [0.7, 0.3, 0.02],
  [0.25, 0.02, 0.3],
  [0.75, 0.75, 0.8],
  [0.12, 0.12, 0.14],
  [0.4, 0.05, 0.1],
  [0.02, 0.2, 0.3],
];

/**
 * Cars on the region's roads: the road traffic model in a worker (10 Hz snapshots in shared
 * memory), drawn by the GPU traffic passes in the city scene.
 */
export async function startTraffic(
  renderer: WebGPURenderer,
  scene: Scene,
  roadsUrl: string,
  options: { count: number; seed: number },
  progress: (message: string) => void,
): Promise<TrafficLayer> {
  progress('Loading cars…');
  const [vehicle, roads] = await Promise.all([
    loadVehicle('/vehicles/porsche'),
    fetch(roadsUrl).then(async (response) => {
      if (!response.ok) throw new Error(`${roadsUrl}: HTTP ${response.status}`);
      return response.arrayBuffer();
    }),
  ]);
  const count = options.count;
  const shared = {
    control: new SharedArrayBuffer(CONTROL_WORDS * 4),
    snapshots: new SharedArrayBuffer(count * 2 * 4 * 4),
  };
  const control = new Int32Array(shared.control);
  const snapshots = new Float32Array(shared.snapshots);
  const worker = new Worker(new URL('./traffic-worker.ts', import.meta.url), { type: 'module' });
  const post = (message: ToTrafficWorker, transfer: Transferable[] = []) => {
    worker.postMessage(message, transfer);
  };
  progress('Starting traffic…');
  const ready = await new Promise<Extract<FromTrafficWorker, { kind: 'ready' }>>(
    (resolve, reject) => {
      worker.onmessage = (event: MessageEvent<FromTrafficWorker>) => {
        if (event.data.kind === 'ready') resolve(event.data);
        else reject(new Error(event.data.message));
      };
      post({ kind: 'start', roads, count, seed: options.seed, shared }, [roads]);
    },
  );

  const gpu: GpuTraffic = createGpuTraffic({
    scene,
    capacity: count,
    lods: vehicle.lods,
    minPixels: MIN_PIXELS,
    caps: CAPS,
    boundingRadius: BOUNDING_RADIUS,
    palette: PALETTE,
  });
  gpu.setColours(ready.colours);

  const frustum = new Frustum();
  const viewProjection = new Matrix4();
  let sequence = -1;
  let arrived = performance.now();
  const drawn = new Array<number>(vehicle.lods.length + 1).fill(0);
  let reading = false;
  let lastRead = 0;
  let timeScale = 1;
  return {
    frame(camera, drawingBufferHeight) {
      const seen = Atomics.load(control, CONTROL.sequence);
      if (seen !== sequence) {
        sequence = seen;
        const slot = Atomics.load(control, CONTROL.slot);
        const n = Atomics.load(control, CONTROL.count);
        gpu.pushSnapshot(snapshots.subarray(slot * count * 4, (slot * count + n) * 4), n);
        arrived = performance.now();
      }
      gpu.uniforms.alpha.value = Math.min(1, (performance.now() - arrived) / TICK_MS);
      viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(viewProjection, camera.coordinateSystem);
      frustum.planes.forEach((plane, i) => {
        gpu.uniforms.planeValues[i]?.set(
          plane.normal.x,
          plane.normal.y,
          plane.normal.z,
          plane.constant,
        );
      });
      gpu.uniforms.cameraPosition.value.copy(camera.position);
      gpu.uniforms.pxPerRadian.value = pxPerRadian(
        drawingBufferHeight,
        (camera.fov * Math.PI) / 180,
      );
      void renderer.compute(gpu.passes);
      const now = performance.now();
      if (!reading && now - lastRead > 500) {
        reading = true;
        lastRead = now;
        void renderer
          .getArrayBufferAsync(gpu.stats)
          .then((buffer) => {
            new Uint32Array(buffer).forEach((n, i) => {
              drawn[i] = n;
            });
          })
          .finally(() => {
            reading = false;
          });
      }
    },
    setTimeScale(scale) {
      timeScale = scale;
      post({ kind: 'timeScale', scale });
    },
    pickCar(viewProjection, ndcX, ndcY, width, height, maxPx) {
      const slot = Atomics.load(control, CONTROL.slot);
      const n = Atomics.load(control, CONTROL.count);
      const s = snapshots.subarray(slot * count * 4, (slot * count + n) * 4);
      const e = viewProjection.elements;
      let best = -1;
      let bestPx = maxPx;
      let bestDepth = Infinity;
      for (let car = 0; car < n; car++) {
        // The body's middle, 0.7 m up.
        const x = s[car * 4] ?? 0;
        const y = (s[car * 4 + 1] ?? 0) + 0.7;
        const z = s[car * 4 + 2] ?? 0;
        const w = e[3] * x + e[7] * y + e[11] * z + e[15];
        if (w <= 0) continue;
        const cx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w;
        const cy = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
        const px = Math.hypot(((cx - ndcX) * width) / 2, ((cy - ndcY) * height) / 2);
        if (px < bestPx - 4 || (px < bestPx + 4 && px <= maxPx && w < bestDepth)) {
          best = car;
          bestPx = Math.min(bestPx, px);
          bestDepth = w;
        }
      }
      return best < 0 ? null : { car: best, px: bestPx };
    },
    carsNear(x, z, radius, max) {
      const slot = Atomics.load(control, CONTROL.slot);
      const n = Atomics.load(control, CONTROL.count);
      const s = snapshots.subarray(slot * count * 4, (slot * count + n) * 4);
      const near: [number, number][] = [];
      const r2 = radius * radius;
      for (let car = 0; car < n; car++) {
        const dx = (s[car * 4] ?? 0) - x;
        const dz = (s[car * 4 + 2] ?? 0) - z;
        const d2 = dx * dx + dz * dz;
        if (d2 < r2) near.push([d2, car]);
      }
      near.sort((a, b) => a[0] - b[0]);
      return near.slice(0, max).map(([, car]) => car);
    },
    carPaint: (car) => PALETTE[ready.colours[car] ?? 0] ?? [0.8, 0.8, 0.8],
    carPose(car, out) {
      if (car < 0 || car >= count) return false;
      const slot = Atomics.load(control, CONTROL.slot);
      const o = (slot * count + car) * 4;
      out.x = snapshots[o] ?? 0;
      out.y = snapshots[o + 1] ?? 0;
      out.z = snapshots[o + 2] ?? 0;
      // Model forward is +Z; heading is clockwise from north (−Z): yaw = π − heading.
      out.yaw = Math.PI - (snapshots[o + 3] ?? 0);
      return true;
    },
    carInfo(car) {
      if (car < 0 || car >= count) return null;
      const slot = Atomics.load(control, CONTROL.slot);
      const now = snapshots.subarray(slot * count * 4);
      const before = snapshots.subarray((1 - slot) * count * 4);
      const o = car * 4;
      const position = new Vector3(now[o] ?? 0, now[o + 1] ?? 0, now[o + 2] ?? 0);
      // The two snapshots are one tick apart, which covers TICK_MS × the time scale of driving.
      const moved = Math.hypot(
        (now[o] ?? 0) - (before[o] ?? 0),
        (now[o + 2] ?? 0) - (before[o + 2] ?? 0),
      );
      const heading = now[o + 3] ?? 0;
      return {
        position,
        speedMps: timeScale > 0 ? moved / ((TICK_MS / 1000) * timeScale) : 0,
        // The road network's heading is already clockwise from north (atan2(dx, −dz)).
        headingRad: ((heading % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI),
        colour: PAINT_NAMES[ready.colours[car] ?? 0] ?? 'silver',
      };
    },
    stats: () => ({
      cars: count,
      roadKm: ready.roadKm,
      drawn: [...drawn],
      stepMs: Atomics.load(control, CONTROL.stepMicros) / 1000,
    }),
    dispose() {
      worker.terminate();
      gpu.dispose();
    },
  };
}
