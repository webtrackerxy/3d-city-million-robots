import { Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { bakeAnimations } from './bake-animations.ts';
import { type BakedAnimation, BONE_MATRIX_FLOATS, ClipFlag } from './baked-animation.ts';
import { ClipPoser } from './clip-poser.ts';
import {
  bonePositionAt,
  estimateLocomotion,
  findFootBones,
  measureFootSlide,
} from './locomotion.ts';
import { createTestRig, TEST_RIG_ONE_SHOT_CLIP } from './test-rig.ts';
import { verifyBake } from './verify-bake.ts';

const SPEED = 1.5;
const DURATION = 1;
const FRAMES = 60;

/**
 * Two feet, as translation-only bone matrices, walking in place along +Z at SPEED: each foot is
 * planted (y = 0) for half the cycle, sliding back by half a stride, then swings forward raised.
 */
function syntheticWalk(): BakedAnimation {
  const stride = SPEED * DURATION;
  const matrices = new Float32Array(FRAMES * 2 * BONE_MATRIX_FLOATS);
  for (let frame = 0; frame < FRAMES; frame++) {
    for (let foot = 0; foot < 2; foot++) {
      const phase = (frame / FRAMES + foot * 0.5) % 1;
      let z: number;
      let y: number;
      if (phase < 0.5) {
        z = stride / 4 - (phase / 0.5) * (stride / 2);
        y = 0;
      } else {
        const u = (phase - 0.5) / 0.5;
        z = -stride / 4 + u * (stride / 2);
        y = 0.12 * Math.sin(Math.PI * u) + 0.001;
      }
      const o = (frame * 2 + foot) * BONE_MATRIX_FLOATS;
      matrices.set([1, 0, 0, foot === 0 ? -0.1 : 0.1, 0, 1, 0, y, 0, 0, 1, z], o);
    }
  }
  return {
    boneCount: 2,
    boneNames: ['mixamorig:LeftToeBase', 'mixamorig:RightToeBase'],
    bonePivots: new Float32Array(6),
    clips: [
      {
        name: 'walk',
        firstFrame: 0,
        frameCount: FRAMES,
        fps: FRAMES / DURATION,
        strideLength: 0,
        duration: DURATION,
        flags: ClipFlag.Loop,
      },
    ],
    matrices,
  };
}

describe('findFootBones', () => {
  it('prefers toes over feet, one per side', () => {
    const names = [
      'mixamorig:Hips',
      'mixamorig:LeftFoot',
      'mixamorig:LeftToeBase',
      'mixamorig:RightFoot',
      'mixamorig:RightToeBase',
      'mixamorig:LeftToe_End',
    ];
    expect(findFootBones(names)).toEqual([2, 4]);
  });

  it('understands side suffixes', () => {
    expect(findFootBones(['Bone', 'FootL', 'Body', 'FootR'])).toEqual([1, 3]);
    expect(findFootBones(['foot.l', 'toe.l', 'foot.r'])).toEqual([1, 2]);
  });

  it('falls back to feet and finds nothing on a rig without them', () => {
    expect(findFootBones(['Hips', 'LeftFoot', 'RightFoot'])).toEqual([1, 2]);
    expect(findFootBones(['base', 'middle', 'top'])).toEqual([]);
  });
});

describe('estimateLocomotion', () => {
  it('recovers speed, stride and direction from the planted foot', () => {
    const baked = syntheticWalk();
    const estimate = estimateLocomotion(baked, 0, findFootBones(baked.boneNames));
    expect(estimate).not.toBeNull();
    expect(estimate?.speed).toBeCloseTo(SPEED, 2);
    expect(estimate?.strideLength).toBeCloseTo(SPEED * DURATION, 2);
    expect(estimate?.forward[0]).toBeCloseTo(0, 3);
    expect(estimate?.forward[1]).toBeCloseTo(1, 3);
  });

  it('ignores clips that do not travel or do not loop', () => {
    const { rig, baked } = (() => {
      const rig = createTestRig();
      return {
        rig,
        baked: bakeAnimations(rig.root, rig.mesh, rig.clips, {
          oneShotClips: [TEST_RIG_ONE_SHOT_CLIP],
        }),
      };
    })();
    expect(rig.clips).toHaveLength(2);
    expect(estimateLocomotion(baked, 0, [])).toBeNull();
    expect(estimateLocomotion(baked, 1, [0, 2])).toBeNull();
  });
});

describe('measureFootSlide', () => {
  it('is zero when phase advances by the estimated stride', () => {
    const baked = syntheticWalk();
    const feet = findFootBones(baked.boneNames);
    const estimate = estimateLocomotion(baked, 0, feet);
    if (estimate === null) throw new Error('expected an estimate');
    expect(measureFootSlide(baked, 0, feet, estimate.strideLength, estimate.forward)).toBeLessThan(
      0.01,
    );
  });

  it('detects sliding when the stride is wrong', () => {
    const baked = syntheticWalk();
    const feet = findFootBones(baked.boneNames);
    // Stride too long: the body outruns the planted foot by a third.
    expect(measureFootSlide(baked, 0, feet, SPEED * 1.5, [0, 1])).toBeCloseTo(SPEED * 0.5, 1);
  });
});

describe('bonePositionAt', () => {
  it('matches the bone world position from Three, in root space', () => {
    const rig = createTestRig();
    // Move the rig after binding, as GLTFLoader effectively does: bindMatrix then no longer equals
    // the mesh's world matrix, which is what broke pivots on the X Bot.
    rig.root.position.x += 3;
    rig.root.scale.setScalar(0.01);
    rig.root.updateMatrixWorld(true);
    const baked = bakeAnimations(rig.root, rig.mesh, rig.clips);
    const poser = new ClipPoser(rig.root);
    const clip = rig.clips[0];
    const bakedClip = baked.clips[0];
    if (clip === undefined || bakedClip === undefined) throw new Error('missing clip');
    const time = 7 / bakedClip.fps;
    poser.pose(clip, time, true);
    const toRoot = new Matrix4().copy(rig.root.matrixWorld).invert();
    rig.mesh.skeleton.bones.forEach((bone, index) => {
      const expected = new Vector3().setFromMatrixPosition(bone.matrixWorld).applyMatrix4(toRoot);
      const [x, y, z] = bonePositionAt(baked, 0, index, time);
      expect(new Vector3(x, y, z).distanceTo(expected)).toBeLessThan(1e-5);
    });
    poser.dispose();
    const check = verifyBake(rig.root, rig.mesh, rig.clips, baked, { poses: 8, seed: 3 });
    expect(check.maxError).toBeLessThan(1e-4);
  });
});
