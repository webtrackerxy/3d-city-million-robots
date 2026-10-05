import { type AnimationClip, Matrix4, type Object3D, type SkinnedMesh, Vector3 } from 'three';
import {
  BONE_MATRIX_FLOATS,
  type BakedAnimation,
  type BakedClip,
  ClipFlag,
  totalFrames,
} from './baked-animation.ts';
import { ClipPoser } from './clip-poser.ts';

export const DEFAULT_BAKE_FPS = 30;

export interface BakeOptions {
  /** Nominal sample rate; each clip's exact rate is adjusted so its frames span its duration. */
  fps?: number;
  /** Metres per cycle for locomotion clips, by clip name. Missing clips get 0. */
  strideLengths?: Readonly<Record<string, number>>;
  /** Clips that play once and hold their last frame. Every other clip is a loop. */
  oneShotClips?: readonly string[];
}

/**
 * Samples every clip at a fixed rate and stores the skinning matrix of every bone in the
 * character root's space:
 *
 *   M = rootWorld⁻¹ · meshWorld · bindMatrixInverse · boneWorld · boneInverse · bindMatrix
 *
 * so the agent's instance transform replaces the asset's own scene transform (e.g. the 0.01
 * armature scale of Mixamo exports). Valid for both `attached` and `detached` bind modes.
 */
export function bakeAnimations(
  root: Object3D,
  mesh: SkinnedMesh,
  clips: readonly AnimationClip[],
  options: BakeOptions = {},
): BakedAnimation {
  const nominalFps = options.fps ?? DEFAULT_BAKE_FPS;
  const oneShot = new Set(options.oneShotClips ?? []);
  const { bones, boneInverses } = mesh.skeleton;
  const boneCount = bones.length;

  let firstFrame = 0;
  const bakedClips: BakedClip[] = clips.map((clip) => {
    const loop = !oneShot.has(clip.name);
    const { frameCount, fps } = frameLayout(clip.duration, nominalFps, loop);
    const baked: BakedClip = {
      name: clip.name,
      firstFrame,
      frameCount,
      fps,
      strideLength: options.strideLengths?.[clip.name] ?? 0,
      duration: clip.duration,
      flags: loop ? ClipFlag.Loop : 0,
    };
    firstFrame += frameCount;
    return baked;
  });

  const matrices = new Float32Array(totalFrames(bakedClips) * boneCount * BONE_MATRIX_FLOATS);
  const poser = new ClipPoser(root);
  const prefix = new Matrix4();
  const skin = new Matrix4();

  try {
    clips.forEach((clip, clipIndex) => {
      const baked = bakedClips[clipIndex];
      if (baked === undefined) throw new Error('unreachable: clip without a bake record');
      const loop = (baked.flags & ClipFlag.Loop) !== 0;

      for (let frame = 0; frame < baked.frameCount; frame++) {
        poser.pose(clip, Math.min(frame / baked.fps, clip.duration), loop);

        prefix
          .copy(root.matrixWorld)
          .invert()
          .multiply(mesh.matrixWorld)
          .multiply(mesh.bindMatrixInverse);

        for (let bone = 0; bone < boneCount; bone++) {
          const boneObject = bones[bone];
          const boneInverse = boneInverses[bone];
          if (boneObject === undefined || boneInverse === undefined) {
            throw new Error(`Skeleton is missing bone or inverse ${bone}`);
          }
          skin
            .copy(prefix)
            .multiply(boneObject.matrixWorld)
            .multiply(boneInverse)
            .multiply(mesh.bindMatrix);
          writeRows(
            skin,
            matrices,
            ((baked.firstFrame + frame) * boneCount + bone) * BONE_MATRIX_FLOATS,
          );
        }
      }
    });
  } finally {
    poser.dispose();
  }

  // Bone origins in the mesh's bind space: M[f][b] × pivot[b] is bone b's position in root space.
  // Uses bindMatrix⁻¹, not mesh.bindMatrixInverse: in attached mode Three overwrites the latter
  // with the current matrixWorld⁻¹, which differs from the bind-time matrix once the mesh moves.
  const pivots = new Float32Array(boneCount * 3);
  const pivot = new Vector3();
  const toBind = new Matrix4();
  const bindInverse = mesh.bindMatrix.clone().invert();
  boneInverses.forEach((boneInverse, bone) => {
    toBind.copy(boneInverse).invert().premultiply(bindInverse);
    pivot.setFromMatrixPosition(toBind).toArray(pivots, bone * 3);
  });

  return {
    boneCount,
    boneNames: bones.map((bone) => bone.name),
    bonePivots: pivots,
    clips: bakedClips,
    matrices,
  };
}

/**
 * Loops store `round(duration × fps)` frames and wrap back to frame 0, so the seam pose is not
 * stored twice. One-shot clips store both end frames. Either way the per-clip rate is adjusted so
 * the frames span the clip's duration exactly.
 */
export function frameLayout(
  duration: number,
  nominalFps: number,
  loop: boolean,
): { frameCount: number; fps: number } {
  if (duration <= 0) return { frameCount: 1, fps: nominalFps };
  if (loop) {
    const frameCount = Math.max(1, Math.round(duration * nominalFps));
    return { frameCount, fps: frameCount / duration };
  }
  const intervals = Math.max(1, Math.ceil(duration * nominalFps - 1e-6));
  return { frameCount: intervals + 1, fps: intervals / duration };
}

/** Three stores matrices column-major; the bake stores rows. */
function writeRows(matrix: Matrix4, out: Float32Array, offset: number): void {
  const e = matrix.elements;
  for (let row = 0; row < 3; row++) {
    out[offset + row * 4 + 0] = e[row] ?? 0;
    out[offset + row * 4 + 1] = e[row + 4] ?? 0;
    out[offset + row * 4 + 2] = e[row + 8] ?? 0;
    out[offset + row * 4 + 3] = e[row + 12] ?? 0;
  }
}
