import {
  type BakedAnimation,
  BONE_MATRIX_FLOATS,
  packClipTable,
  TINT_MASK_ATTRIBUTE,
} from '@city/assets-runtime';
import {
  AGENT_RECORD_BYTES,
  AgentFlag,
  GPU_EDGE_FLOATS as EDGE_FLOATS,
  RENDER_LOD_DEBUG_COLOURS,
  RenderLod,
} from '@city/core-types';
import {
  type BufferGeometry,
  Color,
  type Material,
  MeshStandardMaterial,
  PlaneGeometry,
  Vector3,
  Vector4,
} from 'three';
import {
  atomicAdd,
  atomicLoad,
  atomicSub,
  atan,
  atomicStore,
  attribute,
  bitcast,
  cameraViewMatrix,
  cos,
  float,
  floor,
  Fn,
  fract,
  If,
  instancedArray,
  instanceIndex,
  length,
  luminance,
  max,
  min,
  mix,
  mod,
  normalLocal,
  positionLocal,
  screenCoordinate,
  select,
  sin,
  storage,
  texture,
  uint,
  uniform,
  uniformArray,
  uv,
  varyingProperty,
  vec2,
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
import { PALETTES } from './appearance.ts';
import {
  IMPOSTOR_FRAMES,
  IMPOSTOR_PITCHES,
  IMPOSTOR_YAWS,
  type ImpostorAtlas,
} from './bake-impostors.ts';
import type { HiZ } from './hi-z.ts';
import { LOD_HYSTERESIS } from './lod-policy.ts';

const RECORD_WORDS = AGENT_RECORD_BYTES / 4;
const CLIP_WORDS = 6;
const INDIRECT_WORDS = 5; // drawIndexedIndirect: indexCount, instanceCount, firstIndex, baseVertex, firstInstance
const OUTGOING_BIT = 0x80000000;
/** vec4s per family in the family table. */
/**
 * vec4s per family in the family table: [matrix base, bones, first clip, height],
 * [forward angle, cull radius, height variation, 0], then the LOD caps of bands 0–3 and 4–5
 * (floats; exact for the integers used).
 */
const FAMILY_VEC4S = 4;
/** Mesh LODs 0–4, then the impostor (RenderLod.Impostor). */
const IMPOSTOR_BUCKET = RenderLod.Impostor;
/** Mesh LODs 0–4 then the impostor, per family: the stride of the stats buffer. */
export const BUCKETS_PER_FAMILY = IMPOSTOR_BUCKET + 1;
/** LOD state word 0 value for "not chosen yet" (stored LODs are offset by one). */
const LOD_UNSET = 0;
/** forcedLod uniform value meaning automatic selection. */
export const LOD_AUTO = 0xff;

/** Uniforms the host updates each frame. */
export type CrowdUniforms = ReturnType<typeof createUniforms>;

function createUniforms() {
  /** Six frustum planes (normal.xyz, constant); a point is inside when dot(n, p) + w ≥ −r. */
  const planeValues = Array.from({ length: 6 }, () => new Vector4());
  return {
    simTimeMs: uniform(0, 'uint'),
    cameraPosition: uniform(new Vector3()),
    planeValues,
    frustumPlanes: uniformArray(planeValues, 'vec4' as const),
    pxPerRadian: uniform(1000),
    /** LOD thresholds in projected pixels, descending. */
    lodThresholds: uniform(new Vector4(124, 46, 18, 7)),
    /** Below this projected height agents become impostors; 0 disables impostors. */
    impostorPx: uniform(0),
    forcedLod: uniform(LOD_AUTO, 'uint'),
    fadeMs: uniform(300),
    debugColours: uniform(0, 'uint'),
    /**
     * Global LOD bias (plan §17 budget control): projected heights are multiplied by it, so
     * below 1 every agent drops towards coarser LODs. Driven by the host from visible triangles.
     */
    lodBias: uniform(1),
    /**
     * Contribution culling (plan §20.5): agents projected smaller than this many pixels are not
     * drawn at all — at a distance a crowd of sub-pixel impostors costs a lot and shows nothing.
     * 0 disables.
     */
    minPx: uniform(0),
    /**
     * Where roof walkers (AgentFlag.Roof) are drawn: (min x, min z, max x, max z), Three
     * coordinates — where their buildings are loaded, so nobody stands on a roof that is not there.
     */
    roofArea: uniform(new Vector4(-1e9, -1e9, 1e9, 1e9)),
  };
}

export interface GpuCrowd {
  readonly capacity: number;
  readonly uniforms: CrowdUniforms;
  /**
   * Dispatched in order each frame: event scatter → integrate → cull + LOD + bucket scatter →
   * indirect args.
   */
  readonly passes: ComputeNode[];
  /**
   * Visible agents per bucket (family × BUCKETS_PER_FAMILY + lod), then visible agents in total —
   * written by the args pass for asynchronous readback.
   */
  readonly stats: IndirectStorageBufferAttribute;
  setActive(records: DataView<ArrayBuffer>, edges: Float32Array, active: number): void;
  /** Replaces the edge buffer contents (GPU_EDGE_FLOATS per edge). */
  setEdges(edges: Float32Array, heights?: Float32Array): void;
  /**
   * Uploads the records of `ids[0..count)` from `records` (indexed by agent id) as events that
   * the scatter pass writes into place this frame (decision 0002). Call once per frame, before
   * dispatching `passes`.
   */
  writeRecords(records: DataView, ids: Uint32Array, count: number): void;
  /** Agents [0, active) are integrated and drawn. */
  setCount(active: number): void;
  dispose(): void;
}

/**
 * One skeleton family (§4: human_m, human_f, robot …). Everything that differs between humans and
 * robots is in here; the kernels and shaders are identical for all families.
 */
export interface CrowdFamily {
  animation: BakedAnimation;
  /** geometries[lod][subMesh]. */
  lods: BufferGeometry[][];
  /** Source material per sub-mesh, for colour. */
  materials: (Material | Material[])[];
  /** Skin influences per sub-mesh: 1 (rigid) or 4. */
  influences: readonly (1 | 4)[];
  /** Character height, for the culling sphere and projected height. */
  height: number;
  /** Rotation that turns the character's walking direction into +Z. */
  forwardAngle: number;
  robot: boolean;
  /** Per-agent height scale is 1 ± this (seeded); 0 for families that do not vary. */
  heightVariation: number;
  /** Baked impostor atlas (step 0.8); null disables the impostor bucket for this family. */
  impostor: ImpostorAtlas | null;
}

export interface GpuCrowdOptions {
  capacity: number;
  /**
   * Human base meshes first (selected by the record's variant bits), then at most one robot
   * family (selected by the robot bit).
   */
  families: readonly CrowdFamily[];
  scene: Scene;
  /** Edges the edge buffer holds; defaults to `capacity` (one private edge per agent). */
  edgeCapacity?: number;
  /**
   * What an agent does past the end of its edge until its next record arrives: `wrap` back to the
   * start (the Stage 0 test walkers) or `clamp` at the end (simulation-driven agents, whose next
   * record is at most a tick late).
   */
  edgeEnd?: 'wrap' | 'clamp';
  /**
   * Changed records per frame uploaded as events and scattered on the GPU (decision 0002); a
   * frame with more falls back to one full upload. Default min(capacity, 65 536).
   */
  maxEvents?: number;
  /**
   * Per-family instance caps per LOD band (mesh LODs 0–4); an agent whose band is full is drawn
   * as an impostor instead (a safety valve, plan §17). Missing or Infinity = uncapped.
   * (A walk down band by band was tried; TSL miscompiled atomics inside the unrolled loop.)
   */
  lodCaps?: (family: CrowdFamily, index: number) => readonly number[];
  /** Hi-Z occlusion against the static city (§20.4); its `update` must run before `passes`. */
  occlusion?: HiZ;
}

/** Event record: agent id, then its RECORD_WORDS. */
const EVENT_WORDS = RECORD_WORDS + 1;

/**
 * The GPU half of Path B (implementation plan §9):
 *
 *   integrate   per agent:  24 B record → position, heading, absolute bone-matrix frame pair
 *   cullLod     per agent:  frustum test, projected-height LOD with hysteresis and crossfade,
 *               scatter the agent id into its (family, LOD) bucket of `visible` (twice while
 *               fading)
 *   args        per bucket: copy the bucket count into drawIndexedIndirect args, reset counters
 *
 * then one indirect draw per (family, LOD, sub-mesh). `visible` has a fixed segment of `capacity`
 * ids per bucket, so no prefix sum is needed: an agent appears at most once per bucket.
 *
 * Families share every buffer: their bone matrices and clip tables are concatenated, and a small
 * family table (matrix base, bone count, first clip, height, forward angle, cull radius) is the
 * only thing the kernels look up per family.
 */
export function createGpuCrowd(options: GpuCrowdOptions): GpuCrowd {
  const { capacity, families } = options;
  const familyCount = families.length;
  const buckets = familyCount * BUCKETS_PER_FAMILY;
  const visibleCounter = buckets;

  const uniforms = createUniforms();

  // Shared, capacity-independent data: all families' matrices and clips back to back.
  const matrixFloats = families.reduce((n, f) => n + f.animation.matrices.length, 0);
  const allMatrices = new Float32Array(matrixFloats);
  const clipWords: number[] = [];
  const familyTable = new Float32Array(familyCount * FAMILY_VEC4S * 4);
  let matrixOffset = 0;
  families.forEach((family, index) => {
    allMatrices.set(family.animation.matrices, matrixOffset);
    familyTable.set(
      [
        matrixOffset / BONE_MATRIX_FLOATS,
        family.animation.boneCount,
        clipWords.length / CLIP_WORDS,
        family.height,
        family.forwardAngle,
        family.height * 0.6,
        family.heightVariation,
        0,
      ],
      index * FAMILY_VEC4S * 4,
    );
    const caps = options.lodCaps?.(family, index) ?? [];
    for (let band = 0; band < BUCKETS_PER_FAMILY; band++) {
      const cap = caps[band];
      familyTable[index * FAMILY_VEC4S * 4 + 8 + band] =
        cap !== undefined && Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : capacity;
    }
    clipWords.push(...new Uint32Array(packClipTable(family.animation.clips)));
    matrixOffset += family.animation.matrices.length;
  });
  const clipTable = instancedArray(Uint32Array.from(clipWords), 'uint');
  const familyData = instancedArray(familyTable, 'vec4');
  const matrices = storage(
    instancedArray(allMatrices, 'vec4').value,
    'vec4',
    allMatrices.length / 4,
  ).toReadOnly();

  /** Family index from record word 4's kind byte: bit 7 = robot, bits 0–6 = human base. */
  const humanCount = families.filter((family) => !family.robot).length;
  const robotIndex = families.findIndex((family) => family.robot);
  const familyOf = (word4: Node<'uint'>): Node<'uint'> => {
    if (humanCount === 0) return uint(robotIndex);
    const variant = word4.bitAnd(uint(0x7f));
    const base = select(variant.lessThan(uint(humanCount)), variant, uint(humanCount - 1));
    if (robotIndex < 0) return base;
    return select(word4.shiftRight(uint(7)).bitAnd(uint(1)).equal(uint(1)), uint(robotIndex), base);
  };

  /** Mirrors appearanceFromSeed() in appearance/appearance.ts: five chained lowbias32 hashes. */
  const appearanceHashes = (seed: Node<'uint'>) => {
    const hashes: Node<'uint'>[] = [];
    let h = seed;
    for (let i = 0; i < 5; i++) {
      h = lowbias32(h);
      hashes.push(h);
    }
    return hashes as [Node<'uint'>, Node<'uint'>, Node<'uint'>, Node<'uint'>, Node<'uint'>];
  };
  const heightScale = (seed: Node<'uint'>, variation: Node<'float'>) =>
    float(1).add(variation.mul(float(appearanceHashes(seed)[4]).div(4294967296).mul(2).sub(1)));

  // Per-agent state.
  const records = instancedArray(new Uint32Array(capacity * RECORD_WORDS), 'uint');
  const edgeCapacity = options.edgeCapacity ?? capacity;
  const clampAtEnd = options.edgeEnd === 'clamp';
  const edges = instancedArray(new Float32Array(edgeCapacity * EDGE_FLOATS), 'vec4');
  /** Start and end height per edge: roof walks at their roof's height; zero on the ground. */
  const edgeHeights = instancedArray(new Float32Array(edgeCapacity * 2), 'vec2');
  const poses = instancedArray(capacity, 'vec4');
  /** base0, base1, alpha (integrate) and crossfade progress (cullLod). */
  const frames = instancedArray(capacity, 'vec4');
  /** word 0: current LOD + 1 | (previous LOD + 1) << 8; word 1: fade start, sim ms. */
  const lodState = instancedArray(new Uint32Array(capacity * 2), 'uint');
  /**
   * Per-agent appearance, derived once per frame for visible agents by cullLod so the vertex
   * stage does not hash per vertex: word 0 = palette indices (top | bottoms << 8 | skin << 16 |
   * hair << 24), word 1 = height scale as f32 bits.
   */
  const looks = instancedArray(new Uint32Array(capacity * 2), 'uint');
  const visible = instancedArray(new Uint32Array(capacity * buckets), 'uint');
  const counters = instancedArray(new Uint32Array(buckets + 1), 'uint').toAtomic();

  // One drawIndexedIndirect record per (family, LOD, sub-mesh); drawsOf[bucket] lists its records.
  const drawsOf: number[][] = Array.from({ length: buckets }, () => []);
  const argsList: number[] = [];
  const impostorQuad = createImpostorQuad();
  families.forEach((family, f) => {
    family.lods.forEach((level, lod) => {
      for (const geometry of level) {
        drawsOf[f * BUCKETS_PER_FAMILY + lod]?.push(argsList.length / INDIRECT_WORDS);
        argsList.push(geometry.index?.count ?? 0, 0, 0, 0, 0);
      }
    });
    if (family.impostor !== null) {
      drawsOf[f * BUCKETS_PER_FAMILY + IMPOSTOR_BUCKET]?.push(argsList.length / INDIRECT_WORDS);
      argsList.push(impostorQuad.index?.count ?? 6, 0, 0, 0, 0);
    }
  });
  const argsArray = Uint32Array.from(argsList);
  const argsAttribute = new IndirectStorageBufferAttribute(argsArray, 1);
  const args = storage(argsAttribute, 'uint', argsArray.length);
  const statsAttribute = new IndirectStorageBufferAttribute(new Uint32Array(buckets + 1), 1);
  const stats = storage(statsAttribute, 'uint', buckets + 1);

  // Event upload (decision 0002): changed records arrive as (id, record) pairs in one small
  // buffer and a compute pass writes them into place, so the upload is one contiguous write
  // however scattered the changed agents are.
  const maxEvents = Math.max(1, options.maxEvents ?? Math.min(capacity, 65_536));
  const events = instancedArray(new Uint32Array(maxEvents * EVENT_WORDS), 'uint');
  const eventCount = uniform(0, 'uint');
  const scatter = Fn(() => {
    If(instanceIndex.lessThan(eventCount), () => {
      const base = instanceIndex.mul(uint(EVENT_WORDS));
      const target = events.element(base).mul(uint(RECORD_WORDS));
      for (let k = 0; k < RECORD_WORDS; k++)
        records.element(target.add(uint(k))).assign(events.element(base.add(uint(1 + k))));
    });
  })().compute(maxEvents);

  // Mirrors agentPoseAt() in walkers.ts; keep the two in lockstep.
  const integrate = Fn(() => {
    const base = instanceIndex.mul(uint(RECORD_WORDS));
    const halfEdge = records.element(base);
    const word4 = records.element(base.add(uint(4)));
    const familyRow = familyOf(word4).mul(uint(FAMILY_VEC4S));
    const family0 = familyData.element(familyRow);
    const family1 = familyData.element(familyRow.add(uint(1)));
    const s0 = asFloat(records.element(base.add(uint(1))));
    const scale = heightScale(records.element(base.add(uint(5))), family1.z);
    const t0 = records.element(base.add(uint(2)));
    const word3 = records.element(base.add(uint(3)));

    const speed = float(word3.bitAnd(uint(0xffff))).mul(0.001);
    const clipIndex = uint(family0.z).add(word3.shiftRight(uint(24)));
    const phase0 = float(word4.shiftRight(uint(16))).div(65536);

    const edge = edges.element(halfEdge.shiftRight(uint(1)));
    const reverse = halfEdge.bitAnd(uint(1)).equal(uint(1));
    // A record from ahead of the drawn time (it should not arrive, see the renderer's hold-back)
    // stands at s0 rather than wrapping the unsigned difference to ~49 days.
    const elapsed = float(
      select(uniforms.simTimeMs.greaterThanEqual(t0), uniforms.simTimeMs.sub(t0), uint(0)),
    ).mul(0.001);
    const distance = speed.mul(elapsed);
    const s = clampAtEnd ? min(s0.add(distance), edge.w) : mod(s0.add(distance), edge.w);
    const along = select(reverse, edge.w.sub(s), s);
    const heading = edge.z.add(select(reverse, float(Math.PI), float(0)));
    // Lane offset (i8, 2 cm units), positive to the right of the walking direction: for forward
    // (sin h, cos h) in the XZ plane, right is (−cos h, sin h).
    const lateral = float(word3.shiftRight(uint(16)).bitAnd(uint(0xff)).bitXor(uint(0x80)))
      .sub(128)
      .mul(0.02);
    const x = edge.x.add(sin(edge.z).mul(along)).sub(cos(heading).mul(lateral));
    const z = edge.y.add(cos(edge.z).mul(along)).add(sin(heading).mul(lateral));
    // pose = (x, height, z, heading and phase packed): w's integer part is the heading in
    // milliradians, its fraction the walk-cycle phase (see headingOf; the phase is fract(w)).
    const posePhase = poses.element(instanceIndex);
    const heights = edgeHeights.element(halfEdge.shiftRight(uint(1)));
    const y = heights.x.add(heights.y.sub(heights.x).mul(along.div(edge.w.max(0.001))));
    posePhase.assign(vec4(x, y, z, heading.sub(family1.x)));

    const clipBase = clipIndex.mul(uint(CLIP_WORDS));
    const firstFrame = clipTable.element(clipBase);
    const frameCount = clipTable.element(clipBase.add(uint(1)));
    const fps = asFloat(clipTable.element(clipBase.add(uint(2))));
    const stride = asFloat(clipTable.element(clipBase.add(uint(3))));
    const duration = asFloat(clipTable.element(clipBase.add(uint(4))));
    const loop = clipTable
      .element(clipBase.add(uint(5)))
      .bitAnd(uint(1))
      .equal(uint(1));

    const phase = phase0.add(
      // Taller agents take proportionally longer strides, so feet stay planted at any scale.
      select(
        stride.greaterThan(0),
        distance.div(stride.mul(scale)),
        elapsed.div(duration.max(0.001)),
      ),
    );
    posePhase.w.assign(
      floor(heading.sub(family1.x).mul(1000).add(0.5)).add(fract(phase).mul(0.999)),
    );
    const lastFrame = float(frameCount.sub(uint(1)));
    const u = select(loop, fract(phase).mul(float(frameCount)), min(elapsed.mul(fps), lastFrame));
    const f0 = uint(min(floor(u), lastFrame));
    const next = f0.add(uint(1));
    // Loops wrap to frame 0; one-shots hold their last frame.
    const f1 = select(next.lessThan(frameCount), next, select(loop, uint(0), f0));
    // Absolute matrix indices, so the vertex stage needs no family lookup at all.
    const matrixBase = uint(family0.x);
    const boneCount = uint(family0.y);
    frames
      .element(instanceIndex)
      .assign(
        vec4(
          float(matrixBase.add(firstFrame.add(f0).mul(boneCount))),
          float(matrixBase.add(firstFrame.add(f1).mul(boneCount))),
          u.sub(floor(u)),
          1,
        ),
      );
  })().compute(capacity);

  // Occlusion (§20.4): agents whose bounding sphere is hidden behind the city are flagged with
  // frames.w = −1 (integrate writes 1), which cullLod treats like being outside the frustum.
  const hiZ = options.occlusion;
  const occlusion =
    hiZ === undefined
      ? null
      : Fn(() => {
          const i = instanceIndex;
          const word4 = records.element(i.mul(uint(RECORD_WORDS)).add(uint(4)));
          const family = familyOf(word4);
          const family0 = familyData.element(family.mul(uint(FAMILY_VEC4S)));
          const family1 = familyData.element(family.mul(uint(FAMILY_VEC4S)).add(uint(1)));
          const scale = heightScale(
            records.element(i.mul(uint(RECORD_WORDS)).add(uint(5))),
            family1.z,
          );
          const height = family0.w.mul(scale);
          const centre = poses.element(i).xyz.add(vec3(0, height.mul(0.5), 0));
          If(hiZ.occluded(centre, family1.y.mul(scale)), () => {
            frames.element(i).w.assign(-1);
          });
        })().compute(capacity);

  // Mirrors stepLod() in lod/lod-policy.ts; keep the two in lockstep.
  const cullLod = Fn(() => {
    const i = instanceIndex;
    const family = familyOf(records.element(i.mul(uint(RECORD_WORDS)).add(uint(4))));
    const family0 = familyData.element(family.mul(uint(FAMILY_VEC4S)));
    const family1 = familyData.element(family.mul(uint(FAMILY_VEC4S)).add(uint(1)));
    const scale = heightScale(records.element(i.mul(uint(RECORD_WORDS)).add(uint(5))), family1.z);
    const height = family0.w.mul(scale);
    const radius = family1.y.mul(scale);
    const pose = poses.element(i);
    const centre = pose.xyz.add(vec3(0, height.mul(0.5), 0));

    const inside = uint(1).toVar();
    const flags = records.element(i.mul(uint(RECORD_WORDS)).add(uint(4))).shiftRight(uint(8));
    // Agents indoors (AgentFlag.Hidden) are simulated but never drawn.
    If(flags.bitAnd(uint(AgentFlag.Hidden)).notEqual(uint(0)), () => {
      inside.assign(uint(0));
    });
    // Roof walkers only where their buildings are drawn.
    const area = uniforms.roofArea;
    If(
      flags
        .bitAnd(uint(AgentFlag.Roof))
        .notEqual(uint(0))
        .and(
          pose.x
            .lessThan(area.x)
            .or(pose.z.lessThan(area.y))
            .or(pose.x.greaterThan(area.z))
            .or(pose.z.greaterThan(area.w)),
        ),
      () => {
        inside.assign(uint(0));
      },
    );
    // Flagged by the occlusion pass.
    If(frames.element(i).w.lessThan(0), () => {
      inside.assign(uint(0));
    });
    for (let p = 0; p < 6; p++) {
      const plane = uniforms.frustumPlanes.element(p);
      If(plane.xyz.dot(centre).add(plane.w).lessThan(radius.negate()), () => {
        inside.assign(uint(0));
      });
    }

    const distance = max(length(uniforms.cameraPosition.sub(centre)), 0.1);
    const heightPx = height.mul(uniforms.pxPerRadian).div(distance).mul(uniforms.lodBias);
    If(heightPx.lessThan(uniforms.minPx), () => {
      inside.assign(uint(0));
    });
    const t = uniforms.lodThresholds;
    // Monotonic in h: mesh bands 0–4, then the impostor below impostorPx.
    const bandOf = (h: Node<'float'>) =>
      select(
        h.lessThan(uniforms.impostorPx),
        uint(IMPOSTOR_BUCKET),
        uint(select(h.lessThan(t.x), uint(1), uint(0)))
          .add(select(h.lessThan(t.y), uint(1), uint(0)))
          .add(select(h.lessThan(t.z), uint(1), uint(0)))
          .add(select(h.lessThan(t.w), uint(1), uint(0))),
      );

    const word0 = lodState.element(i.mul(uint(2)));
    const fadeStart = lodState.element(i.mul(uint(2)).add(uint(1))).toVar();
    const storedCurrent = word0.bitAnd(uint(0xff));
    const current = storedCurrent.sub(uint(1)).toVar();
    const previous = word0.shiftRight(uint(8)).bitAnd(uint(0xff)).sub(uint(1)).toVar();

    const target = bandOf(heightPx).toVar();
    If(storedCurrent.notEqual(uint(LOD_UNSET)), () => {
      const finer = bandOf(heightPx.div(1 + LOD_HYSTERESIS));
      const coarser = bandOf(heightPx.mul(1 + LOD_HYSTERESIS));
      target.assign(
        select(
          finer.lessThan(current),
          finer,
          select(coarser.greaterThan(current), coarser, current),
        ),
      );
    });
    If(uniforms.forcedLod.notEqual(uint(LOD_AUTO)), () => {
      target.assign(
        select(
          uniforms.forcedLod.lessThan(uint(BUCKETS_PER_FAMILY)),
          uniforms.forcedLod,
          uint(BUCKETS_PER_FAMILY - 1),
        ),
      );
    });

    If(storedCurrent.equal(uint(LOD_UNSET)), () => {
      current.assign(target);
      previous.assign(target);
    }).ElseIf(target.notEqual(current), () => {
      previous.assign(current);
      current.assign(target);
      fadeStart.assign(uniforms.simTimeMs);
    });

    const elapsed = float(uniforms.simTimeMs.sub(fadeStart));
    const fading = uniforms.fadeMs
      .greaterThan(0)
      .and(previous.notEqual(current))
      .and(elapsed.lessThan(uniforms.fadeMs));
    If(fading.not(), () => {
      previous.assign(current);
    });

    lodState
      .element(i.mul(uint(2)))
      .assign(current.add(uint(1)).bitOr(previous.add(uint(1)).shiftLeft(uint(8))));
    lodState.element(i.mul(uint(2)).add(uint(1))).assign(fadeStart);
    const frame = frames.element(i);
    frames
      .element(i)
      .assign(vec4(frame.xyz, select(fading, elapsed.div(uniforms.fadeMs), float(1))));

    If(inside.equal(uint(1)), () => {
      const hashes = appearanceHashes(records.element(i.mul(uint(RECORD_WORDS)).add(uint(5))));
      const packed = hashes[0]
        .mod(uint(PALETTES.top.length))
        .bitOr(hashes[1].mod(uint(PALETTES.bottoms.length)).shiftLeft(uint(8)))
        .bitOr(hashes[2].mod(uint(PALETTES.skin.length)).shiftLeft(uint(16)))
        .bitOr(hashes[3].mod(uint(PALETTES.hair.length)).shiftLeft(uint(24)));
      looks.element(i.mul(uint(2))).assign(packed);
      looks.element(i.mul(uint(2)).add(uint(1))).assign(asUint(scale));
      const firstBucket = family.mul(uint(BUCKETS_PER_FAMILY));
      atomicAdd(counters.element(uint(visibleCounter)), uint(1));
      // Instance caps (§17), a safety valve: an agent whose band is full is drawn as an impostor
      // (uncapped). A thread that overshoots gives its increment back, so a band never holds more
      // than its cap.
      const familyBase = family.mul(uint(FAMILY_VEC4S));
      const capsLow = familyData.element(familyBase.add(uint(2)));
      const capsHigh = familyData.element(familyBase.add(uint(3)));
      const cap = uint(
        select(
          current.lessThan(uint(4)),
          select(
            current.lessThan(uint(2)),
            select(current.equal(uint(0)), capsLow.x, capsLow.y),
            select(current.equal(uint(2)), capsLow.z, capsLow.w),
          ),
          select(current.equal(uint(4)), capsHigh.x, capsHigh.y),
        ),
      );
      const bucket = firstBucket.add(current);
      const slot = atomicAdd(counters.element(bucket), uint(1)).toVar();
      If(slot.lessThan(cap), () => {
        visible.element(bucket.mul(uint(capacity)).add(slot)).assign(i);
      }).Else(() => {
        atomicSub(counters.element(bucket), uint(1));
        const impostor = firstBucket.add(uint(IMPOSTOR_BUCKET));
        const impostorSlot = atomicAdd(counters.element(impostor), uint(1)).toVar();
        visible.element(impostor.mul(uint(capacity)).add(impostorSlot)).assign(i);
      });
      If(fading, () => {
        const outBucket = firstBucket.add(previous);
        const outSlot = atomicAdd(counters.element(outBucket), uint(1));
        visible
          .element(outBucket.mul(uint(capacity)).add(outSlot))
          .assign(i.bitOr(uint(OUTGOING_BIT)));
      });
    });
  })().compute(capacity);

  const writeArgs = Fn(() => {
    const bucket = instanceIndex;
    const count = atomicLoad(counters.element(bucket));
    drawsOf.forEach((draws, b) => {
      If(bucket.equal(uint(b)), () => {
        for (const draw of draws) {
          args.element(uint(draw * INDIRECT_WORDS + 1)).assign(count);
        }
      });
    });
    stats.element(bucket).assign(count);
    atomicStore(counters.element(bucket), uint(0));
    If(bucket.equal(uint(0)), () => {
      stats
        .element(uint(visibleCounter))
        .assign(atomicLoad(counters.element(uint(visibleCounter))));
      atomicStore(counters.element(uint(visibleCounter)), uint(0));
    });
  })().compute(buckets);

  // Vertex-stage views (vertex shaders may only read storage buffers).
  const visibleRead = storage(visible.value, 'uint', capacity * buckets).toReadOnly();
  const poseRead = storage(poses.value, 'vec4', capacity).toReadOnly();
  const frameRead = storage(frames.value, 'vec4', capacity).toReadOnly();
  const lodFade = varyingProperty('vec2', 'vLodFade');

  const looksRead = storage(looks.value, 'uint', capacity * 2).toReadOnly();
  /** Region mask and the agent's four palette indices, for the fragment-stage tint. */
  const maskVarying = varyingProperty('vec4', 'vTintMask');
  const paletteVarying = varyingProperty('vec4', 'vPalette');
  const palette = (colours: readonly (readonly [number, number, number])[]) =>
    uniformArray(
      colours.map(([r, g, b]) => new Vector3(r, g, b)),
      'vec3' as const,
    );
  const palettes = [
    palette(PALETTES.top),
    palette(PALETTES.bottoms),
    palette(PALETTES.skin),
    palette(PALETTES.hair),
  ] as const;

  /**
   * Per-agent palette entries weighted by the region mask (§4 ID-mask channels), keeping the
   * albedo's shading detail (tint × relative luminance). Shared by meshes and impostors.
   */
  const tintColour = (
    albedo: Node<'vec3'>,
    mask: Node<'vec4'>,
    reference: number,
  ): Node<'vec3'> => {
    const index = (component: 'x' | 'y' | 'z' | 'w') => uint(paletteVarying[component].add(0.5));
    const tint = palettes[0]
      .element(index('x'))
      .mul(mask.x)
      .add(palettes[1].element(index('y')).mul(mask.y))
      .add(palettes[2].element(index('z')).mul(mask.z))
      .add(palettes[3].element(index('w')).mul(mask.w));
    const strength = mask.x.add(mask.y).add(mask.z).add(mask.w);
    const shaded = tint.div(max(strength, 0.0001)).mul(luminance(albedo).div(reference));
    return mix(albedo, shaded, strength.min(1));
  };
  const paletteIndicesOf = (packed: Node<'uint'>) =>
    vec4(
      float(packed.bitAnd(uint(0xff))),
      float(packed.shiftRight(uint(8)).bitAnd(uint(0xff))),
      float(packed.shiftRight(uint(16)).bitAnd(uint(0xff))),
      float(packed.shiftRight(uint(24))),
    );

  const skinFor = (bucket: number, influences: 1 | 4, tinted: boolean) =>
    Fn(() => {
      const entry = visibleRead.element(uint(bucket * capacity).add(instanceIndex));
      const agent = entry.bitAnd(uint(~OUTGOING_BIT >>> 0));
      const outgoing = float(entry.shiftRight(uint(31)));
      const pose = poseRead.element(agent);
      const paletteIndices = looksRead.element(agent.mul(uint(2)));
      const scale = asFloat(looksRead.element(agent.mul(uint(2)).add(uint(1))));
      const frame = frameRead.element(agent);
      const base0 = uint(frame.x);
      const base1 = uint(frame.y);
      const alpha = frame.z;
      const joints = attribute('skinIndex', 'uvec4');
      const weights = attribute('skinWeight', 'vec4');

      // Linear blend skinning with the two stored frames blended per bone: influences × 2
      // frames × 3 rows vec4 fetches per vertex (§8) — 24 for 4-influence meshes, 6 for rigid.
      const rows = [vec4(0).toVar(), vec4(0).toVar(), vec4(0).toVar()] as const;
      const components = influences === 1 ? (['x'] as const) : (['x', 'y', 'z', 'w'] as const);
      for (const component of components) {
        const joint = joints[component];
        const weight = weights[component];
        const row0 = base0.add(joint).mul(uint(3));
        const row1 = base1.add(joint).mul(uint(3));
        rows.forEach((row, r) => {
          row.addAssign(
            mix(
              matrices.element(row0.add(uint(r))),
              matrices.element(row1.add(uint(r))),
              alpha,
            ).mul(weight),
          );
        });
      }

      const p = vec4(positionLocal, 1);
      const local = vec3(rows[0].dot(p), rows[1].dot(p), rows[2].dot(p)).mul(scale);
      const n = normalLocal;
      const skinnedNormal = vec3(rows[0].xyz.dot(n), rows[1].xyz.dot(n), rows[2].xyz.dot(n));

      const c = cos(headingOf(pose.w));
      const s = sin(headingOf(pose.w));
      const rotate = (v: typeof local) =>
        vec3(c.mul(v.x).add(s.mul(v.z)), v.y, s.negate().mul(v.x).add(c.mul(v.z)));
      positionLocal.assign(rotate(local).add(pose.xyz));
      normalLocal.assign(rotate(skinnedNormal).normalize());
      lodFade.assign(vec2(frame.w, outgoing));

      if (tinted) {
        // Palette lookups happen per fragment (far fewer than vertices at crowd triangle
        // counts); the vertex stage only forwards the mask and the agent's palette indices,
        // which are identical on all three vertices of a triangle.
        maskVarying.assign(attribute(TINT_MASK_ATTRIBUTE, 'vec4'));
        paletteVarying.assign(paletteIndicesOf(paletteIndices));
      }
    }, 'void'); // 'void': calling it inside setupPosition() appends it to the vertex stack

  // Screen-door crossfade, mirrors keepsPixel(): interleaved gradient noise per pixel, incoming
  // LOD keeps noise < fade, outgoing keeps the complement.
  const noise = fract(
    float(52.9829189).mul(
      fract(screenCoordinate.x.mul(0.06711056).add(screenCoordinate.y.mul(0.00583715))),
    ),
  );
  const keep = select(
    lodFade.y.greaterThan(0.5),
    noise.greaterThanEqual(lodFade.x),
    noise.lessThan(lodFade.x),
  );

  const meshes: Mesh<BufferGeometry, CrowdMaterial>[] = [];
  families.forEach((family, f) => {
    family.lods.forEach((level, lod) => {
      const bucket = f * BUCKETS_PER_FAMILY + lod;
      const debug = RENDER_LOD_DEBUG_COLOURS[lod] ?? [1, 1, 1];
      level.forEach((geometry, sub) => {
        const tinted = geometry.hasAttribute(TINT_MASK_ATTRIBUTE);
        const influences = family.influences[sub] ?? 4;
        const material = new CrowdMaterial(
          skinFor(bucket, influences, tinted),
          `mesh-${bucket}-${influences}-${tinted ? 1 : 0}`,
        );
        const source = firstMaterial(family.materials[sub]);
        copyAppearance(source, material);
        const albedo = albedoNode(source);
        let colour: Node<'vec3'> = albedo;
        if (tinted) {
          const reference = source?.map != null ? 0.45 : Math.max(0.05, luminanceOf(source));
          colour = tintColour(albedo, maskVarying, reference);
        }
        material.colorNode = select(
          uniforms.debugColours.equal(uint(1)),
          vec3(debug[0], debug[1], debug[2]),
          colour,
        );
        material.maskNode = keep;
        const draw = drawsOf[bucket]?.[sub] ?? 0;
        geometry.setIndirect(argsAttribute, draw * INDIRECT_WORDS * 4);
        const mesh = new Mesh(geometry, material);
        mesh.name = `crowd_f${f}_lod${lod}_${sub}`;
        mesh.frustumCulled = false;
        options.scene.add(mesh);
        meshes.push(mesh);
      });
    });
  });

  // Impostors: one instanced camera-facing quad per family (§9 step 6).
  const atlasUv = varyingProperty('vec2', 'vAtlasUv');
  const impostorYaw = varyingProperty('float', 'vImpostorYaw');
  const impostorMeshes: Mesh<BufferGeometry, CrowdMaterial>[] = [];
  families.forEach((family, f) => {
    const atlas = family.impostor;
    if (atlas === null) return;
    const bucket = f * BUCKETS_PER_FAMILY + IMPOSTOR_BUCKET;
    const yaws = IMPOSTOR_YAWS;
    const pitchSplit = ((IMPOSTOR_PITCHES[0] + IMPOSTOR_PITCHES[1]) / 2) * (Math.PI / 180);

    const place = Fn(() => {
      const entry = visibleRead.element(uint(bucket * capacity).add(instanceIndex));
      const agent = entry.bitAnd(uint(~OUTGOING_BIT >>> 0));
      const outgoing = float(entry.shiftRight(uint(31)));
      const pose = poseRead.element(agent);
      const frame = frameRead.element(agent);
      const scale = asFloat(looksRead.element(agent.mul(uint(2)).add(uint(1))));
      const foot = pose.xyz;
      const toCamera = uniforms.cameraPosition.sub(foot.add(vec3(0, family.height * 0.5, 0)));
      const flat = vec2(toCamera.x, toCamera.z);
      const facing = flat.normalize();
      const right = vec3(facing.y, 0, facing.x.negate());
      // Snapshot the quad corner: positionLocal is reassigned below, and later reads would see
      // the world position instead.
      const corner = positionLocal.toVar();
      positionLocal.assign(
        foot
          .add(right.mul(corner.x.mul(atlas.quad.width).mul(scale)))
          .add(
            vec3(0, float(atlas.quad.bottom).add(corner.y.mul(atlas.quad.height)).mul(scale), 0),
          ),
      );
      normalLocal.assign(vec3(facing.x, 0, facing.y));

      // Tile: camera azimuth in the character's own frame, elevation, and walk phase.
      const azimuth = atan(toCamera.x, toCamera.z).sub(headingOf(pose.w));
      const yaw = uint(floor(fract(azimuth.div(Math.PI * 2).add(0.5 / yaws)).mul(yaws)));
      const pitch = select(
        atan(toCamera.y, length(flat)).greaterThan(pitchSplit),
        uint(1),
        uint(0),
      );
      const phaseFrame = uint(floor(fract(pose.w).mul(IMPOSTOR_FRAMES)));
      const tile = phaseFrame
        .mul(uint(IMPOSTOR_PITCHES.length))
        .add(pitch)
        .mul(uint(yaws))
        .add(select(yaw.lessThan(uint(yaws)), yaw, uint(yaws - 1)));
      const column = float(tile.mod(uint(atlas.columns)));
      const row = float(tile.div(uint(atlas.columns)));
      atlasUv.assign(
        vec2(
          column.add(corner.x.add(0.5)).div(atlas.columns),
          row.add(float(1).sub(corner.y)).div(atlas.rows),
        ),
      );
      impostorYaw.assign(headingOf(pose.w));
      lodFade.assign(vec2(frame.w, outgoing));
      paletteVarying.assign(paletteIndicesOf(looksRead.element(agent.mul(uint(2)))));
    }, 'void');

    const material = new CrowdMaterial(place, `impostor-${bucket}`);
    const albedo = texture(atlas.albedo, atlasUv);
    const mask = texture(atlas.mask, atlasUv);
    const raw = texture(atlas.normal, atlasUv).xyz.mul(2).sub(1);
    const c = cos(impostorYaw);
    const sn = sin(impostorYaw);
    const worldNormal = vec3(
      c.mul(raw.x).add(sn.mul(raw.z)),
      raw.y,
      sn.negate().mul(raw.x).add(c.mul(raw.z)),
    );
    material.normalNode = cameraViewMatrix.mul(vec4(worldNormal, 0)).xyz.normalize();
    const debug = RENDER_LOD_DEBUG_COLOURS[IMPOSTOR_BUCKET] ?? [1, 0, 1];
    material.colorNode = select(
      uniforms.debugColours.equal(uint(1)),
      vec3(debug[0], debug[1], debug[2]),
      tintColour(albedo.rgb, mask, atlas.referenceLuminance),
    );
    material.maskNode = albedo.a.greaterThan(0.5).and(keep);
    material.roughness = 0.7;
    const geometry = impostorQuad.clone();
    const draw = drawsOf[bucket]?.[0] ?? 0;
    geometry.setIndirect(argsAttribute, draw * INDIRECT_WORDS * 4);
    const mesh = new Mesh(geometry, material);
    mesh.name = `crowd_f${f}_impostor`;
    mesh.frustumCulled = false;
    options.scene.add(mesh);
    impostorMeshes.push(mesh);
  });
  meshes.push(...impostorMeshes);

  return {
    capacity,
    uniforms,
    passes:
      occlusion === null
        ? [scatter, integrate, cullLod, writeArgs]
        : [scatter, integrate, occlusion, cullLod, writeArgs],
    stats: statsAttribute,
    setActive(recordView, edgeData, active) {
      (records.value.array as Uint32Array).set(new Uint32Array(recordView.buffer));
      records.value.clearUpdateRanges();
      records.value.needsUpdate = true;
      eventCount.value = 0;
      (edges.value.array as Float32Array).set(edgeData);
      edges.value.needsUpdate = true;
      // Fresh agents choose their LOD from scratch.
      (lodState.value.array as Uint32Array).fill(0);
      lodState.value.needsUpdate = true;
      integrate.count = Math.max(1, active);
      if (occlusion !== null) occlusion.count = Math.max(1, active);
      cullLod.count = Math.max(1, active);
      for (const mesh of meshes) mesh.visible = active > 0;
    },
    setEdges(edgeData, heights) {
      if (edgeData.length > edgeCapacity * EDGE_FLOATS)
        throw new RangeError(
          `${edgeData.length / EDGE_FLOATS} edges exceed edgeCapacity ${edgeCapacity}`,
        );
      (edges.value.array as Float32Array).set(edgeData);
      edges.value.needsUpdate = true;
      if (heights !== undefined) {
        (edgeHeights.value.array as Float32Array).set(heights);
        edgeHeights.value.needsUpdate = true;
      }
    },
    writeRecords(source, ids, count) {
      const mirror = records.value.array as Uint32Array;
      const words = new Uint32Array(source.buffer, source.byteOffset, source.byteLength >>> 2);
      if (count > maxEvents) {
        // A burst (start-up, a lapped ring): one full upload.
        for (let i = 0; i < count; i++) {
          const at = (ids[i] ?? 0) * RECORD_WORDS;
          mirror.set(words.subarray(at, at + RECORD_WORDS), at);
        }
        records.value.clearUpdateRanges();
        records.value.needsUpdate = true;
        eventCount.value = 0;
        return;
      }
      const packed = events.value.array as Uint32Array;
      for (let i = 0; i < count; i++) {
        const id = ids[i] ?? 0;
        const at = id * RECORD_WORDS;
        const record = words.subarray(at, at + RECORD_WORDS);
        // The CPU mirror stays complete for the full-upload fallback.
        mirror.set(record, at);
        packed[i * EVENT_WORDS] = id;
        packed.set(record, i * EVENT_WORDS + 1);
      }
      eventCount.value = count;
      if (count === 0) return;
      events.value.clearUpdateRanges();
      events.value.addUpdateRange(0, count * EVENT_WORDS);
      events.value.needsUpdate = true;
    },
    setCount(active) {
      integrate.count = Math.max(1, active);
      if (occlusion !== null) occlusion.count = Math.max(1, active);
      cullLod.count = Math.max(1, active);
      for (const mesh of meshes) mesh.visible = active > 0;
    },
    dispose() {
      for (const mesh of meshes) {
        options.scene.remove(mesh);
        mesh.geometry.setIndirect(null);
        mesh.material.dispose();
      }
      for (const pass of [scatter, integrate, cullLod, writeArgs]) pass.dispose();
      occlusion?.dispose();
    },
  };
}

/** Heading (radians) from a pose's packed w: integer part in milliradians. */
function headingOf(w: Node<'float'>): Node<'float'> {
  return floor(w).mul(0.001);
}

/** f32 → its u32 bits, for storing floats in uint buffers. */
function asUint(value: Node<'float'>): Node<'uint'> {
  return bitcast(value, 'uint') as unknown as Node<'uint'>;
}

/** @types/three types bitcast() as an untyped node; the WGSL it emits is bitcast<f32>(u32). */
function asFloat(word: Node<'uint'>): Node<'float'> {
  return bitcast(word, 'float') as unknown as Node<'float'>;
}

/**
 * Standard PBR material whose vertex position and normal come from the crowd skinning function
 * instead of Three's per-object skinning. Hooks the same place Three's own instancing does.
 */
class CrowdMaterial extends MeshStandardNodeMaterial {
  private readonly crowdSkin: () => unknown;
  private readonly variant: string;

  constructor(crowdSkin: () => unknown, variant: string) {
    super();
    this.crowdSkin = crowdSkin;
    this.variant = variant;
  }

  /**
   * The vertex stage differs between buckets only inside `crowdSkin` (the list it reads, the skin
   * influences), which the program cache cannot see; materials that otherwise look alike would
   * share one program and read another bucket's list.
   */
  override customProgramCacheKey(): string {
    return `${super.customProgramCacheKey()}|crowd-${this.variant}`;
  }

  override setupPosition(): Node {
    this.crowdSkin();
    return positionLocal;
  }
}

/** Unit quad, x ∈ [−0.5, 0.5], y ∈ [0, 1], facing +Z; the impostor vertex stage places it. */
function createImpostorQuad(): BufferGeometry {
  const quad = new PlaneGeometry(1, 1);
  quad.translate(0, 0.5, 0);
  return quad;
}

/** lowbias32 in u32 arithmetic; mirrors hash32() in appearance/appearance.ts. */
function lowbias32(value: Node<'uint'>): Node<'uint'> {
  let x = value.bitXor(value.shiftRight(uint(16)));
  x = x.mul(uint(0x7feb352d));
  x = x.bitXor(x.shiftRight(uint(15)));
  x = x.mul(uint(0x846ca68b));
  return x.bitXor(x.shiftRight(uint(16)));
}

function firstMaterial(
  source: Material | Material[] | undefined,
): MeshStandardMaterial | undefined {
  const first = Array.isArray(source) ? source[0] : source;
  return first instanceof MeshStandardMaterial ? first : undefined;
}

/** The source material's base colour, times its albedo texture when it has one. */
function albedoNode(source: MeshStandardMaterial | undefined): Node<'vec3'> {
  const colour = source?.color ?? new Color(0x8fa3bf);
  const constant = vec3(colour.r, colour.g, colour.b);
  const map = source?.map ?? null;
  return map === null ? constant : texture(map, uv()).rgb.mul(constant);
}

function luminanceOf(source: MeshStandardMaterial | undefined): number {
  const c = source?.color ?? new Color(0x8fa3bf);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

function copyAppearance(
  source: MeshStandardMaterial | undefined,
  target: MeshStandardNodeMaterial,
): void {
  if (source !== undefined) {
    target.roughness = source.roughness;
    target.metalness = source.metalness;
  }
}
