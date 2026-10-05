import { BONE_MATRIX_FLOATS, type BakedAnimation, ClipFlag } from './baked-animation.ts';

/**
 * CPU reference for the GPU vertex stage. The WGSL skinning code must produce the same result as
 * these functions; step 0.4 adds a CPU-vs-GPU equivalence test against them.
 */

export interface FramePair {
  /** Matrix index of the earlier frame's bone 0. */
  base0: number;
  /** Matrix index of the later frame's bone 0. */
  base1: number;
  /** Blend weight of the later frame, 0..1. */
  alpha: number;
}

/** Resolves a clip time to the two stored frames around it. Loops wrap, one-shots clamp. */
export function framePairAt(baked: BakedAnimation, clipIndex: number, time: number): FramePair {
  const clip = baked.clips[clipIndex];
  if (clip === undefined) throw new Error(`Clip index ${clipIndex} out of range`);

  let f0: number;
  let f1: number;
  let alpha: number;
  if ((clip.flags & ClipFlag.Loop) !== 0) {
    const u = positiveModulo(time * clip.fps, clip.frameCount);
    f0 = Math.floor(u);
    alpha = u - f0;
    f0 %= clip.frameCount;
    f1 = (f0 + 1) % clip.frameCount;
  } else {
    const u = Math.min(Math.max(time * clip.fps, 0), clip.frameCount - 1);
    f0 = Math.floor(u);
    alpha = u - f0;
    f1 = Math.min(f0 + 1, clip.frameCount - 1);
  }

  return {
    base0: (clip.firstFrame + f0) * baked.boneCount,
    base1: (clip.firstFrame + f1) * baked.boneCount,
    alpha,
  };
}

/** Linear blend of one bone's matrix between the two frames of `pair`, written to `out[0..12)`. */
export function sampleSkinMatrix(
  baked: BakedAnimation,
  pair: FramePair,
  bone: number,
  out: Float32Array,
): void {
  const m = baked.matrices;
  const a = (pair.base0 + bone) * BONE_MATRIX_FLOATS;
  const b = (pair.base1 + bone) * BONE_MATRIX_FLOATS;
  const t = pair.alpha;
  for (let i = 0; i < BONE_MATRIX_FLOATS; i++) {
    const v0 = m[a + i] ?? 0;
    out[i] = v0 + ((m[b + i] ?? 0) - v0) * t;
  }
}

const scratch = new Float32Array(BONE_MATRIX_FLOATS);

/**
 * Linear blend skinning with up to four influences. Returns the vertex position in character-root
 * space. `joints` and `weights` are the vertex's skinIndex / skinWeight attributes.
 */
export function skinVertex(
  baked: BakedAnimation,
  pair: FramePair,
  x: number,
  y: number,
  z: number,
  joints: ArrayLike<number>,
  weights: ArrayLike<number>,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  let ox = 0;
  let oy = 0;
  let oz = 0;
  for (let i = 0; i < 4; i++) {
    const w = weights[i] ?? 0;
    if (w === 0) continue;
    sampleSkinMatrix(baked, pair, joints[i] ?? 0, scratch);
    ox += w * dotRow(scratch, 0, x, y, z);
    oy += w * dotRow(scratch, 4, x, y, z);
    oz += w * dotRow(scratch, 8, x, y, z);
  }
  out[0] = ox;
  out[1] = oy;
  out[2] = oz;
  return out;
}

function dotRow(m: Float32Array, r: number, x: number, y: number, z: number): number {
  return (m[r] ?? 0) * x + (m[r + 1] ?? 0) * y + (m[r + 2] ?? 0) * z + (m[r + 3] ?? 0);
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}
