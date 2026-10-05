import { type AnimationClip, Matrix4, type Object3D, type SkinnedMesh, Vector3 } from 'three';
import { type BakedAnimation, ClipFlag } from './baked-animation.ts';
import { ClipPoser } from './clip-poser.ts';
import { framePairAt, skinVertex } from './cpu-skinning.ts';

export interface VerifyOptions {
  /** Number of (clip, frame) poses to check. */
  poses?: number;
  /** Vertices checked per pose. */
  verticesPerPose?: number;
  seed?: number;
}

export interface VerifyResult {
  /** Largest root-space distance between Three's skinning and the baked skinning, in metres. */
  maxError: number;
  checkedVertices: number;
}

/**
 * Compares vertices skinned from the bake against Three's own SkinnedMesh skinning at randomly
 * chosen stored frames. Deterministic for a given seed.
 */
export function verifyBake(
  root: Object3D,
  mesh: SkinnedMesh,
  clips: readonly AnimationClip[],
  baked: BakedAnimation,
  options: VerifyOptions = {},
): VerifyResult {
  const random = mulberry32(options.seed ?? 1);
  const poses = options.poses ?? 16;
  const verticesPerPose = options.verticesPerPose ?? 32;
  const geometry = mesh.geometry;
  const skinIndex = geometry.getAttribute('skinIndex');
  const skinWeight = geometry.getAttribute('skinWeight');
  const position = geometry.getAttribute('position');

  const poser = new ClipPoser(root);
  const toRoot = new Matrix4();
  const expected = new Vector3();
  const actual: [number, number, number] = [0, 0, 0];
  const joints = [0, 0, 0, 0];
  const weights = [0, 0, 0, 0];
  let maxError = 0;
  let checkedVertices = 0;

  try {
    for (let p = 0; p < poses; p++) {
      const clipIndex = Math.floor(random() * clips.length);
      const clip = clips[clipIndex];
      const bakedClip = baked.clips[clipIndex];
      if (clip === undefined || bakedClip === undefined) continue;
      const frame = Math.floor(random() * bakedClip.frameCount);
      const time = Math.min(frame / bakedClip.fps, clip.duration);

      poser.pose(clip, time, (bakedClip.flags & ClipFlag.Loop) !== 0);
      toRoot.copy(root.matrixWorld).invert().multiply(mesh.matrixWorld);
      const pair = framePairAt(baked, clipIndex, time);

      for (let v = 0; v < verticesPerPose; v++) {
        const vertex = Math.floor(random() * position.count);
        mesh.getVertexPosition(vertex, expected).applyMatrix4(toRoot);
        for (let i = 0; i < 4; i++) {
          joints[i] = skinIndex.getComponent(vertex, i);
          weights[i] = skinWeight.getComponent(vertex, i);
        }
        skinVertex(
          baked,
          pair,
          position.getX(vertex),
          position.getY(vertex),
          position.getZ(vertex),
          joints,
          weights,
          actual,
        );
        maxError = Math.max(
          maxError,
          Math.hypot(actual[0] - expected.x, actual[1] - expected.y, actual[2] - expected.z),
        );
        checkedVertices++;
      }
    }
  } finally {
    poser.dispose();
  }

  return { maxError, checkedVertices };
}

/** Small seedable PRNG; Math.random would make failures unreproducible. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
