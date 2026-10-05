import { type BakedAnimation, BONE_MATRIX_FLOATS, ClipFlag } from './baked-animation.ts';
import { framePairAt, sampleSkinMatrix } from './cpu-skinning.ts';

/**
 * Stride analysis for in-place locomotion clips (implementation plan §6).
 *
 * An in-place walk keeps the hips still and slides the planted foot backwards at exactly the
 * speed the character would travel. Measuring that slide gives the ground speed, and
 * `strideLength = speed × duration` makes `phase = distance / strideLength` plant the feet: a
 * foot moving backwards at v in root space while the agent moves forwards at v stays put.
 */

/** Side-prefixed names (Mixamo "LeftToeBase", "left_foot"). */
const FOOT_PREFIX = /(left|right)[_ .]?(toe_?base|toe|foot|ankle)$/i;
/** Side-suffixed names (Blender "Foot.L", "FootL", "toe_r"). */
const FOOT_SUFFIX = /(toe_?base|toe|foot|ankle)[_ .]?(l|r|left|right)$/i;

export interface LocomotionEstimate {
  /** Metres per second the clip implies. */
  speed: number;
  /** Metres per cycle. */
  strideLength: number;
  /** Unit direction of travel in the root's XZ plane. */
  forward: [number, number];
  /** Frames whose planted foot contributed to the estimate. */
  samples: number;
}

/** Picks one foot bone per side, preferring toes (they stay planted longest). */
export function findFootBones(boneNames: readonly string[]): number[] {
  const bySide = new Map<string, { index: number; rank: number }>();
  boneNames.forEach((name, index) => {
    const prefixed = FOOT_PREFIX.exec(name);
    const suffixed = prefixed === null ? FOOT_SUFFIX.exec(name) : null;
    const side = prefixed?.[1] ?? suffixed?.[2];
    const part = prefixed?.[2] ?? suffixed?.[1];
    if (side === undefined || part === undefined) return;
    const key = side[0]?.toLowerCase() ?? '';
    const candidate = { index, rank: /toe/i.test(part) ? 0 : 1 };
    const current = bySide.get(key);
    if (current === undefined || candidate.rank < current.rank) bySide.set(key, candidate);
  });
  return [...bySide.values()].map((entry) => entry.index).sort((a, b) => a - b);
}

/** Root-space position of `bone` at clip time `time`, interpolated like the GPU does. */
export function bonePositionAt(
  baked: BakedAnimation,
  clipIndex: number,
  bone: number,
  time: number,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const m = new Float32Array(BONE_MATRIX_FLOATS);
  sampleSkinMatrix(baked, framePairAt(baked, clipIndex, time), bone, m);
  const x = baked.bonePivots[bone * 3] ?? 0;
  const y = baked.bonePivots[bone * 3 + 1] ?? 0;
  const z = baked.bonePivots[bone * 3 + 2] ?? 0;
  for (let row = 0; row < 3; row++) {
    const r = row * 4;
    out[row] = (m[r] ?? 0) * x + (m[r + 1] ?? 0) * y + (m[r + 2] ?? 0) * z + (m[r + 3] ?? 0);
  }
  return out;
}

/**
 * Estimates ground speed from the planted (lowest) foot's backward slide, as net displacement
 * over whole stance segments (instantaneous toe speed varies as the foot rolls). Returns null for
 * one-shot clips and clips that do not travel (idles, poses).
 */
export function estimateLocomotion(
  baked: BakedAnimation,
  clipIndex: number,
  footBones: readonly number[],
  samplesPerFrame = 4,
): LocomotionEstimate | null {
  const clip = baked.clips[clipIndex];
  if (clip === undefined || footBones.length < 2) return null;
  if ((clip.flags & ClipFlag.Loop) === 0 || clip.frameCount < 4 || clip.duration <= 0) return null;

  const steps = clip.frameCount * samplesPerFrame;
  const dt = clip.duration / steps;
  const track = sampleFeet(steps, footBones.length, (step, foot, out) =>
    bonePositionAt(baked, clipIndex, footBones[foot] ?? 0, step * dt, out),
  );
  const drift = plantedDrift(track);
  if (drift === null || drift.steps < steps / 4) return null;

  const speed = Math.hypot(drift.x, drift.z) / (drift.steps * dt);
  if (speed < 0.05) return null;
  const length = Math.hypot(drift.x, drift.z);
  return {
    speed,
    strideLength: speed * clip.duration,
    // The planted foot slides against the direction of travel.
    forward: [-drift.x / length, -drift.z / length],
    samples: drift.steps,
  };
}

/**
 * Net world-space drift speed of planted feet for an agent walking along `forward` with
 * distance-driven phase, in m/s. Zero means no foot sliding.
 */
export function measureFootSlide(
  baked: BakedAnimation,
  clipIndex: number,
  footBones: readonly number[],
  strideLength: number,
  forward: readonly [number, number],
  samplesPerFrame = 4,
): number {
  const clip = baked.clips[clipIndex];
  if (clip === undefined || footBones.length === 0 || strideLength <= 0) return 0;

  const steps = clip.frameCount * samplesPerFrame;
  const distanceStep = strideLength / steps;
  const dt = clip.duration / steps;
  const track = sampleFeet(steps, footBones.length, (step, foot, out) => {
    const distance = step * distanceStep;
    const time = (distance / strideLength) * clip.duration;
    bonePositionAt(baked, clipIndex, footBones[foot] ?? 0, time, out);
    out[0] += forward[0] * distance;
    out[2] += forward[1] * distance;
    return out;
  });
  const drift = plantedDrift(track);
  return drift === null || drift.steps === 0 ? 0 : drift.distance / (drift.steps * dt);
}

type Sampler = (
  step: number,
  foot: number,
  out: [number, number, number],
) => [number, number, number];

/** positions[step][foot], for steps 0..steps inclusive (the last closes the cycle). */
function sampleFeet(steps: number, feet: number, sample: Sampler): [number, number, number][][] {
  const positions: [number, number, number][][] = [];
  for (let step = 0; step <= steps; step++) {
    const row: [number, number, number][] = [];
    for (let foot = 0; foot < feet; foot++) row.push(sample(step, foot, [0, 0, 0]));
    positions.push(row);
  }
  return positions;
}

interface Drift {
  /** Summed horizontal displacement of the planted foot over all stance segments. */
  x: number;
  z: number;
  /** Summed per-segment displacement lengths. */
  distance: number;
  steps: number;
}

/** A foot counts as planted within this height of its lowest point in the cycle. */
const CONTACT_HEIGHT_M = 0.03;

/**
 * Splits the cycle into segments where one foot stays planted (lowest, and within
 * CONTACT_HEIGHT_M of the ground), and sums each segment's start-to-end displacement. Flight
 * phases (running) have no planted foot and end a segment. Segments shorter than `minSteps`
 * (contact hand-overs) are skipped.
 */
function plantedDrift(
  positions: readonly (readonly (readonly number[])[])[],
  minSteps = 3,
): Drift | null {
  let ground = Infinity;
  for (const row of positions) for (const p of row) ground = Math.min(ground, p[1] ?? 0);
  const plantedFoot = (row: readonly (readonly number[])[]): number => {
    const foot = lowestFoot(row);
    return (row[foot]?.[1] ?? 0) <= ground + CONTACT_HEIGHT_M ? foot : -1;
  };

  const drift: Drift = { x: 0, z: 0, distance: 0, steps: 0 };
  let segmentStart = 0;
  let segmentFoot = plantedFoot(positions[0] ?? []);
  const close = (end: number): void => {
    const length = end - segmentStart;
    if (segmentFoot < 0 || length < minSteps) return;
    const a = positions[segmentStart]?.[segmentFoot];
    const b = positions[end]?.[segmentFoot];
    if (a === undefined || b === undefined) return;
    const dx = (b[0] ?? 0) - (a[0] ?? 0);
    const dz = (b[2] ?? 0) - (a[2] ?? 0);
    drift.x += dx;
    drift.z += dz;
    drift.distance += Math.hypot(dx, dz);
    drift.steps += length;
  };
  for (let step = 1; step < positions.length; step++) {
    const foot = plantedFoot(positions[step] ?? []);
    if (foot === segmentFoot) continue;
    close(step - 1);
    segmentStart = step;
    segmentFoot = foot;
  }
  close(positions.length - 1);
  return drift.steps === 0 ? null : drift;
}

function lowestFoot(positions: readonly (readonly number[])[]): number {
  let best = 0;
  positions.forEach((p, i) => {
    if ((p[1] ?? 0) < (positions[best]?.[1] ?? 0)) best = i;
  });
  return best;
}
