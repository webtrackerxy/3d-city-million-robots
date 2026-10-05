import {
  bakeAnimations,
  type BakedAnimation,
  ClipFlag,
  estimateLocomotion,
  findFootBones,
  measureFootSlide,
  totalFrames,
  verifyBake,
} from '@city/assets-runtime';
import type { MetricsBus } from '@city/metrics';
import type { CharacterSource } from './load-character.ts';

export interface BakedCharacter {
  baked: BakedAnimation;
  /** Direction the character walks in its own root space (XZ), +Z when unknown. */
  forward: [number, number];
  /** Natural speed of the scenario's clip in m/s; 0 for clips that do not travel. */
  clipSpeed: number;
  /** Median planted-foot speed while walking at clip speed, m/s. Null without locomotion. */
  footSlide: number | null;
}

const EQUAL_EPSILON = 1e-6;

/**
 * Bakes every clip of a character (step 0.2) and derives stride lengths from its feet so
 * distance-driven phase plants them (step 0.4). Publishes the numbers to the debug panel.
 */
export function bakeCharacter(
  source: CharacterSource,
  bus: MetricsBus,
  key: string,
): BakedCharacter {
  const [mesh, ...others] = source.meshes;
  if (mesh === undefined) throw new Error(`${source.model} contains no skinned mesh`);
  for (const other of others) {
    const sameBones =
      other.skeleton.bones.length === mesh.skeleton.bones.length &&
      other.skeleton.bones.every((bone, i) => bone === mesh.skeleton.bones[i]);
    if (!sameBones || !matricesClose(other.bindMatrix.elements, mesh.bindMatrix.elements)) {
      throw new Error(
        `${source.model}: mesh "${other.name}" uses a different skeleton or bind pose than ` +
          `"${mesh.name}"; one bake per character requires a shared skin`,
      );
    }
  }

  const bakeStart = performance.now();
  const baked = bakeAnimations(source.template, mesh, source.clips);
  const bakeMs = performance.now() - bakeStart;
  // Every sub-mesh is skinned from the same bake; check them all (rigid robot parts included).
  const check = {
    maxError: Math.max(
      ...source.meshes.map(
        (m) => verifyBake(source.template, m, source.clips, baked, { poses: 16, seed: 1 }).maxError,
      ),
    ),
  };

  const feet = findFootBones(baked.boneNames);
  let forward: [number, number] = [0, 1];
  let clipSpeed = 0;
  let footSlide: number | null = null;
  for (const [index, clip] of baked.clips.entries()) {
    if ((clip.flags & ClipFlag.Loop) === 0) continue;
    const estimate = estimateLocomotion(baked, index, feet);
    if (estimate === null) continue;
    clip.strideLength = estimate.strideLength;
    if (index === source.clipIndex) {
      forward = estimate.forward;
      clipSpeed = estimate.speed;
      footSlide = measureFootSlide(baked, index, feet, estimate.strideLength, estimate.forward);
    }
  }

  bus.setGauge(`anim.${key}.boneCount`, baked.boneCount);
  bus.setGauge(`anim.${key}.clipCount`, baked.clips.length);
  bus.setGauge(`anim.${key}.frameCount`, totalFrames(baked.clips));
  bus.setGauge(`anim.${key}.matrixBytes`, baked.matrices.byteLength);
  bus.setGauge(`anim.${key}.bakeMs`, bakeMs);
  bus.setGauge(`anim.${key}.maxErrorM`, check.maxError);
  bus.setGauge(`anim.${key}.clipSpeed`, clipSpeed);
  bus.setGauge(`anim.${key}.strideM`, baked.clips[source.clipIndex]?.strideLength ?? 0);
  if (footSlide !== null) bus.setGauge(`anim.${key}.footSlide`, footSlide);

  return { baked, forward, clipSpeed, footSlide };
}

function matricesClose(a: readonly number[], b: readonly number[]): boolean {
  return a.every((value, i) => Math.abs(value - (b[i] ?? 0)) < EQUAL_EPSILON);
}
