import {
  BoxGeometry,
  type BufferGeometry,
  Color,
  type Material,
  MeshStandardMaterial,
  Vector3,
  Vector4,
} from 'three';
import {
  atomicAdd,
  atomicLoad,
  atomicStore,
  atomicSub,
  cos,
  float,
  Fn,
  If,
  instancedArray,
  instanceIndex,
  length,
  max,
  mix,
  normalLocal,
  positionLocal,
  select,
  sin,
  storage,
  uint,
  uniform,
  uniformArray,
  varyingProperty,
  vec3,
  vec4,
} from 'three/tsl';
import {
  type ComputeNode,
  IndirectStorageBufferAttribute,
  Mesh,
  MeshStandardNodeMaterial,
  type Node,
  type Scene,
} from 'three/webgpu';

/**
 * Cars on the GPU, after the 3d-city-million-cars project's instanced vehicles, drawn in this
 * project's WebGPU scene so they occlude and are occluded by buildings and robots correctly.
 *
 * The traffic simulation publishes snapshots (x, y, z, heading) at 10 Hz. Each frame one compute
 * pass interpolates every car between the last two snapshots, culls it against the frustum,
 * picks a LOD from its projected size (the cars project's thresholds and caps; a full band sends
 * the car to the box bucket) and appends it to that bucket's list; a second pass writes the
 * indirect draw counts. Every material part of every LOD is one indirect draw; the "paint"
 * part takes the car's palette colour.
 */
export interface VehiclePart {
  /** Canonical material name from the asset pipeline (paint, window, …). */
  material: string;
  geometry: BufferGeometry;
  source: Material;
}

export interface GpuTrafficOptions {
  scene: Scene;
  capacity: number;
  /** Mesh LODs, best first (the cars project has four); each is a list of material parts. */
  lods: VehiclePart[][];
  /** Projected-diameter thresholds in pixels for each mesh LOD, then the far box. */
  minPixels: readonly number[];
  /** Instance caps per mesh LOD (the box is uncapped). */
  caps: readonly number[];
  boundingRadius: number;
  /** Body paint, linear RGB, indexed by the car's colour. */
  palette: readonly (readonly [number, number, number])[];
  /** The part tinted by the palette. */
  tinted?: string;
}

export interface GpuTraffic {
  readonly uniforms: {
    planeValues: Vector4[];
    cameraPosition: { value: Vector3 };
    pxPerRadian: { value: number };
    /** 0 at the previous snapshot, 1 at the latest. */
    alpha: { value: number };
  };
  /** Latest snapshot: count × (x, y, z, heading clockwise from north), Three frame. */
  pushSnapshot(packed: Float32Array, count: number): void;
  setColours(colours: Uint8Array): void;
  readonly passes: ComputeNode[];
  /** Cars per bucket (LODs, box) as of the last pass, for the panel; filled by the caller. */
  readonly stats: IndirectStorageBufferAttribute;
  dispose(): void;
}

const INDIRECT_WORDS = 5;
/** Snapshots further apart than this (m) are a respawn: no interpolation across them. */
const TELEPORT_M = 40;

export function createGpuTraffic(options: GpuTrafficOptions): GpuTraffic {
  const { capacity, lods, scene } = options;
  const meshLods = lods.length;
  const boxBucket = meshLods;
  const buckets = meshLods + 1;
  const tinted = options.tinted ?? 'paint';

  const planeValues = Array.from({ length: 6 }, () => new Vector4());
  const frustumPlanes = uniformArray(planeValues, 'vec4' as const);
  const cameraPosition = uniform(new Vector3());
  const pxPerRadian = uniform(1000);
  const alpha = uniform(1);
  const count = uniform(0, 'uint');
  const prevBase = uniform(0, 'uint');
  const nextBase = uniform(0, 'uint');
  const thresholds = uniformArray(
    Array.from({ length: buckets }, (_, b) => options.minPixels[b] ?? 0),
    'float' as const,
  );
  const caps = uniformArray(
    Array.from({ length: buckets }, (_, b) => (b < meshLods ? (options.caps[b] ?? 0) : capacity)),
    'uint' as const,
  );
  const palette = uniformArray(
    options.palette.map(([r, g, b]) => new Color(r, g, b)),
    'color' as const,
  );

  // Two snapshot slots; `nextBase` names the latest, `prevBase` the one before.
  const states = instancedArray(capacity * 2, 'vec4');
  const colours = instancedArray(new Uint32Array(capacity), 'uint');
  const poses = instancedArray(capacity, 'vec4');
  const visible = instancedArray(new Uint32Array(capacity * buckets), 'uint');
  const counters = instancedArray(new Uint32Array(buckets), 'uint').toAtomic();

  const drawsOf: number[][] = Array.from({ length: buckets }, () => []);
  const argsList: number[] = [];
  const box = new BoxGeometry(1.85, 1.35, 4.5).translate(0, 0.7, 0);
  const allGeometries: BufferGeometry[][] = [
    ...lods.map((parts) => parts.map((p) => p.geometry)),
    [box],
  ];
  allGeometries.forEach((level, bucket) => {
    for (const geometry of level) {
      drawsOf[bucket]?.push(argsList.length / INDIRECT_WORDS);
      argsList.push(geometry.index?.count ?? geometry.getAttribute('position').count, 0, 0, 0, 0);
    }
  });
  const argsArray = Uint32Array.from(argsList);
  const argsAttribute = new IndirectStorageBufferAttribute(argsArray, 1);
  const args = storage(argsAttribute, 'uint', argsArray.length);
  const statsAttribute = new IndirectStorageBufferAttribute(new Uint32Array(buckets), 1);
  const stats = storage(statsAttribute, 'uint', buckets);

  const cull = Fn(() => {
    const i = instanceIndex;
    If(i.lessThan(count), () => {
      const prev = states.element(prevBase.add(i));
      const next = states.element(nextBase.add(i));
      const jump = length(next.xyz.sub(prev.xyz)).greaterThan(TELEPORT_M);
      const t = select(jump, float(1), alpha);
      const position = mix(prev.xyz, next.xyz, t);
      // Shortest way round between the two headings.
      const turn = next.w.sub(prev.w);
      const wrapped = turn.sub(
        float(Math.PI * 2).mul(
          turn
            .div(Math.PI * 2)
            .add(0.5)
            .floor(),
        ),
      );
      const heading = prev.w.add(wrapped.mul(t));
      // Model forward is +Z; heading is clockwise from north (−Z): yaw = π − heading.
      poses.element(i).assign(vec4(position, float(Math.PI).sub(heading)));

      const radius = float(options.boundingRadius);
      const centre = position.add(vec3(0, 0.7, 0));
      const inside = uint(1).toVar();
      for (let p = 0; p < 6; p++) {
        const plane = frustumPlanes.element(p);
        If(plane.xyz.dot(centre).add(plane.w).lessThan(radius.negate()), () => {
          inside.assign(0);
        });
      }
      const distance = max(length(cameraPosition.sub(centre)), float(0.1));
      const sizePx = radius.mul(2).mul(pxPerRadian).div(distance);
      const bucket = uint(buckets).toVar();
      for (let b = buckets - 1; b >= 0; b--) {
        If(sizePx.greaterThanEqual(thresholds.element(b)), () => {
          bucket.assign(b);
        });
      }
      If(inside.equal(uint(1)).and(bucket.lessThan(uint(buckets))), () => {
        const slot = atomicAdd(counters.element(bucket), uint(1)).toVar();
        If(slot.lessThan(caps.element(bucket)), () => {
          visible.element(bucket.mul(uint(capacity)).add(slot)).assign(i);
        }).Else(() => {
          // Band full: drawn as the box instead.
          atomicSub(counters.element(bucket), uint(1));
          const boxSlot = atomicAdd(counters.element(uint(boxBucket)), uint(1));
          visible.element(uint(boxBucket * capacity).add(boxSlot)).assign(i);
        });
      });
    });
  })().compute(capacity);

  const writeArgs = Fn(() => {
    const bucket = instanceIndex;
    const n = atomicLoad(counters.element(bucket));
    drawsOf.forEach((draws, b) => {
      If(bucket.equal(uint(b)), () => {
        for (const draw of draws) args.element(uint(draw * INDIRECT_WORDS + 1)).assign(n);
      });
    });
    stats.element(bucket).assign(n);
    atomicStore(counters.element(bucket), uint(0));
  })().compute(buckets);

  const visibleRead = storage(visible.value, 'uint', capacity * buckets).toReadOnly();
  const poseRead = storage(poses.value, 'vec4', capacity).toReadOnly();
  const colourRead = storage(colours.value, 'uint', capacity).toReadOnly();
  const paint = varyingProperty('vec3', 'vPaint');

  const placeFor = (bucket: number) =>
    Fn(() => {
      const car = visibleRead.element(uint(bucket * capacity).add(instanceIndex));
      const pose = poseRead.element(car);
      const c = cos(pose.w);
      const s = sin(pose.w);
      const rotate = (v: Node<'vec3'>) =>
        vec3(c.mul(v.x).add(s.mul(v.z)), v.y, s.negate().mul(v.x).add(c.mul(v.z)));
      positionLocal.assign(rotate(positionLocal).add(pose.xyz));
      normalLocal.assign(rotate(normalLocal));
      paint.assign(palette.element(colourRead.element(car).mod(uint(options.palette.length))));
    }, 'void');

  const meshes: Mesh[] = [];
  const addMesh = (geometry: BufferGeometry, bucket: number, source: Material, tint: boolean) => {
    const material = new TrafficMaterial(placeFor(bucket), bucket);
    if (source instanceof MeshStandardMaterial) {
      material.color.copy(source.color);
      // The scene has no environment map: metal would reflect nothing and render black.
      material.metalness = Math.min(source.metalness, 0.15);
      material.roughness = Math.max(source.roughness, 0.35);
      material.transparent = source.transparent;
      material.opacity = source.opacity;
      material.emissive.copy(source.emissive);
    }
    if (tint) material.colorNode = paint;
    const draw = drawsOf[bucket]?.[meshes.filter((m) => m.userData.bucket === bucket).length] ?? 0;
    geometry.setIndirect(argsAttribute, draw * INDIRECT_WORDS * 4);
    const mesh = new Mesh(geometry, material);
    mesh.name = `traffic_b${bucket}`;
    mesh.userData.bucket = bucket;
    mesh.frustumCulled = false;
    scene.add(mesh);
    meshes.push(mesh);
  };
  lods.forEach((parts, lod) => {
    for (const part of parts) addMesh(part.geometry, lod, part.source, part.material === tinted);
  });
  addMesh(box, boxBucket, new MeshStandardMaterial({ roughness: 0.5, metalness: 0.1 }), true);

  const packedState = states.value.array as Float32Array;
  let latest = 0;
  return {
    uniforms: { planeValues, cameraPosition, pxPerRadian, alpha },
    passes: [cull, writeArgs],
    stats: statsAttribute,
    pushSnapshot(packed, n) {
      // The older slot receives the new snapshot and becomes `next`.
      const slot = 1 - latest;
      const cars = Math.min(n, capacity);
      packedState.set(packed.subarray(0, cars * 4), slot * capacity * 4);
      if (count.value === 0) packedState.set(packed.subarray(0, cars * 4), latest * capacity * 4);
      states.value.clearUpdateRanges();
      states.value.addUpdateRange(slot * capacity * 4, cars * 4);
      if (count.value === 0) states.value.addUpdateRange(latest * capacity * 4, cars * 4);
      states.value.needsUpdate = true;
      prevBase.value = latest * capacity;
      nextBase.value = slot * capacity;
      latest = slot;
      count.value = cars;
    },
    setColours(values) {
      (colours.value.array as Uint32Array).set(values.subarray(0, capacity));
      colours.value.needsUpdate = true;
    },
    dispose() {
      for (const mesh of meshes) {
        scene.remove(mesh);
        mesh.geometry.setIndirect(null);
        (mesh.material as Material).dispose();
      }
      box.dispose();
      cull.dispose();
      writeArgs.dispose();
    },
  };
}

class TrafficMaterial extends MeshStandardNodeMaterial {
  private readonly place: () => unknown;
  private readonly bucket: number;

  constructor(place: () => unknown, bucket: number) {
    super();
    this.place = place;
    this.bucket = bucket;
  }

  /**
   * The vertex stage differs per bucket only inside `place` (which list it reads), which the
   * renderer's program cache cannot see: without this, materials that look alike share the first
   * bucket's program and draw the wrong cars.
   */
  override customProgramCacheKey(): string {
    return `${super.customProgramCacheKey()}|traffic-bucket-${this.bucket}`;
  }

  override setupPosition(): Node {
    this.place();
    return positionLocal;
  }
}
