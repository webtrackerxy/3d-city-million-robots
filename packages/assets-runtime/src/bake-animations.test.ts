import { Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { bakeAnimations, frameLayout } from './bake-animations.ts';
import {
  BONE_MATRIX_FLOATS,
  CLIP_RECORD_BYTES,
  ClipFlag,
  findClipIndex,
  packClipTable,
  totalFrames,
  unpackClipTable,
} from './baked-animation.ts';
import { ClipPoser } from './clip-poser.ts';
import { framePairAt, skinVertex } from './cpu-skinning.ts';
import { createTestRig, TEST_RIG_LOOP_CLIP, TEST_RIG_ONE_SHOT_CLIP } from './test-rig.ts';
import { mulberry32, verifyBake } from './verify-bake.ts';

const TOLERANCE_M = 1e-4;

function bakeTestRig() {
  const rig = createTestRig();
  const baked = bakeAnimations(rig.root, rig.mesh, rig.clips, {
    oneShotClips: [TEST_RIG_ONE_SHOT_CLIP],
    strideLengths: { [TEST_RIG_LOOP_CLIP]: 1.4 },
  });
  return { rig, baked };
}

/** Three's skinning of one vertex at `time`, in character-root space. */
function threeVertex(
  rig: ReturnType<typeof createTestRig>,
  poser: ClipPoser,
  clipIndex: number,
  time: number,
  loop: boolean,
  vertex: number,
): Vector3 {
  const clip = rig.clips[clipIndex];
  if (clip === undefined) throw new Error('bad clip');
  poser.pose(clip, time, loop);
  const toRoot = new Matrix4().copy(rig.root.matrixWorld).invert().multiply(rig.mesh.matrixWorld);
  return rig.mesh.getVertexPosition(vertex, new Vector3()).applyMatrix4(toRoot);
}

function bakedVertex(
  rig: ReturnType<typeof createTestRig>,
  baked: ReturnType<typeof bakeTestRig>['baked'],
  clipIndex: number,
  time: number,
  vertex: number,
): Vector3 {
  const geometry = rig.mesh.geometry;
  const position = geometry.getAttribute('position');
  const joints = [0, 1, 2, 3].map((i) =>
    geometry.getAttribute('skinIndex').getComponent(vertex, i),
  );
  const weights = [0, 1, 2, 3].map((i) =>
    geometry.getAttribute('skinWeight').getComponent(vertex, i),
  );
  const [x, y, z] = skinVertex(
    baked,
    framePairAt(baked, clipIndex, time),
    position.getX(vertex),
    position.getY(vertex),
    position.getZ(vertex),
    joints,
    weights,
  );
  return new Vector3(x, y, z);
}

/** The highest vertex of the column, which moves the most. */
function topVertex(rig: ReturnType<typeof createTestRig>): number {
  const position = rig.mesh.geometry.getAttribute('position');
  let best = 0;
  for (let i = 1; i < position.count; i++) if (position.getY(i) > position.getY(best)) best = i;
  return best;
}

describe('frameLayout', () => {
  it('stores the loop seam once and spans the duration exactly', () => {
    expect(frameLayout(1.2, 30, true)).toEqual({ frameCount: 36, fps: 30 });
    const odd = frameLayout(1.01, 30, true);
    expect(odd.frameCount).toBe(30);
    expect(odd.frameCount / odd.fps).toBeCloseTo(1.01, 12);
  });

  it('stores both end frames of one-shot clips', () => {
    expect(frameLayout(0.8, 30, false)).toEqual({ frameCount: 25, fps: 30 });
    const odd = frameLayout(0.81, 30, false);
    expect(odd.frameCount).toBe(26);
    expect((odd.frameCount - 1) / odd.fps).toBeCloseTo(0.81, 12);
  });

  it('bakes zero-length clips as a single pose', () => {
    expect(frameLayout(0, 30, true).frameCount).toBe(1);
    expect(frameLayout(0, 30, false).frameCount).toBe(1);
  });
});

describe('bakeAnimations', () => {
  it('lays clips back to back with the requested metadata', () => {
    const { baked } = bakeTestRig();
    expect(baked.boneCount).toBe(3);
    expect(baked.boneNames).toEqual(['base', 'middle', 'top']);

    const [sway, bow] = baked.clips;
    expect(sway).toMatchObject({ name: TEST_RIG_LOOP_CLIP, firstFrame: 0, frameCount: 36 });
    expect(sway?.flags).toBe(ClipFlag.Loop);
    expect(sway?.strideLength).toBe(1.4);
    expect(bow).toMatchObject({ name: TEST_RIG_ONE_SHOT_CLIP, firstFrame: 36, frameCount: 25 });
    expect(bow?.flags).toBe(0);
    expect(bow?.strideLength).toBe(0);

    expect(baked.matrices.length).toBe(totalFrames(baked.clips) * 3 * BONE_MATRIX_FLOATS);
  });

  it('matches Three skinning within 1e-4 at random stored frames', () => {
    const { rig, baked } = bakeTestRig();
    const result = verifyBake(rig.root, rig.mesh, rig.clips, baked, {
      poses: 64,
      verticesPerPose: 64,
      seed: 42,
    });
    expect(result.checkedVertices).toBe(64 * 64);
    expect(result.maxError).toBeLessThan(TOLERANCE_M);
  });

  it('actually animates: the checked poses differ from the rest pose', () => {
    const { rig, baked } = bakeTestRig();
    const top = topVertex(rig);
    const rest = bakedVertex(rig, baked, 0, 0, top);
    const swayed = bakedVertex(rig, baked, 0, 0.3, top);
    expect(rest.distanceTo(swayed)).toBeGreaterThan(0.1);
  });

  it('wraps loops smoothly from the last frame back to frame 0', () => {
    const { rig, baked } = bakeTestRig();
    const poser = new ClipPoser(rig.root);
    const sway = findClipIndex(baked, TEST_RIG_LOOP_CLIP);
    const duration = baked.clips[sway]?.duration ?? 0;
    const count = rig.mesh.geometry.getAttribute('position').count;
    for (let vertex = 0; vertex < count; vertex += 7) {
      const expected = threeVertex(rig, poser, sway, duration - 1e-5, true, vertex);
      expect(
        bakedVertex(rig, baked, sway, duration - 1e-5, vertex).distanceTo(expected),
      ).toBeLessThan(TOLERANCE_M);
      // One full cycle later is the same pose.
      expect(
        bakedVertex(rig, baked, sway, 0.25, vertex).distanceTo(
          bakedVertex(rig, baked, sway, 0.25 + duration, vertex),
        ),
      ).toBeLessThan(1e-6);
    }
    poser.dispose();
  });

  it('holds the final pose of one-shot clips', () => {
    const { rig, baked } = bakeTestRig();
    const poser = new ClipPoser(rig.root);
    const bow = findClipIndex(baked, TEST_RIG_ONE_SHOT_CLIP);
    const duration = baked.clips[bow]?.duration ?? 0;
    const vertex = topVertex(rig);
    const end = threeVertex(rig, poser, bow, duration, false, vertex);
    expect(bakedVertex(rig, baked, bow, duration, vertex).distanceTo(end)).toBeLessThan(
      TOLERANCE_M,
    );
    expect(bakedVertex(rig, baked, bow, duration + 5, vertex).distanceTo(end)).toBeLessThan(
      TOLERANCE_M,
    );
    poser.dispose();
  });

  it('interpolates between frames close to Three at random off-frame times', () => {
    const { rig, baked } = bakeTestRig();
    const poser = new ClipPoser(rig.root);
    const random = mulberry32(7);
    const count = rig.mesh.geometry.getAttribute('position').count;
    let maxError = 0;
    for (let i = 0; i < 200; i++) {
      const clipIndex = random() < 0.5 ? 0 : 1;
      const clip = baked.clips[clipIndex];
      if (clip === undefined) continue;
      const time = random() * clip.duration;
      const vertex = Math.floor(random() * count);
      const loop = (clip.flags & ClipFlag.Loop) !== 0;
      const expected = threeVertex(rig, poser, clipIndex, time, loop, vertex);
      maxError = Math.max(
        maxError,
        bakedVertex(rig, baked, clipIndex, time, vertex).distanceTo(expected),
      );
    }
    poser.dispose();
    // Matrix lerp vs quaternion slerp between 30 Hz samples: millimetres, not metres.
    expect(maxError).toBeLessThan(5e-3);
  });

  it('leaves the skeleton in its bind pose', () => {
    const { rig } = bakeTestRig();
    rig.root.updateMatrixWorld(true);
    const top = topVertex(rig);
    const posed = rig.mesh.getVertexPosition(top, new Vector3());
    const rest = new Vector3().fromBufferAttribute(rig.mesh.geometry.getAttribute('position'), top);
    expect(posed.distanceTo(rest)).toBeLessThan(1e-5);
  });
});

describe('clip table', () => {
  it('packs 24-byte records that round-trip', () => {
    const { baked } = bakeTestRig();
    const buffer = packClipTable(baked.clips);
    expect(CLIP_RECORD_BYTES % 4).toBe(0);
    expect(buffer.byteLength).toBe(baked.clips.length * CLIP_RECORD_BYTES);
    const unpacked = unpackClipTable(buffer);
    baked.clips.forEach((clip, index) => {
      const row = unpacked[index];
      expect(row?.firstFrame).toBe(clip.firstFrame);
      expect(row?.frameCount).toBe(clip.frameCount);
      expect(row?.flags).toBe(clip.flags);
      expect(row?.fps).toBeCloseTo(clip.fps, 4);
      expect(row?.strideLength).toBeCloseTo(clip.strideLength, 6);
      expect(row?.duration).toBeCloseTo(clip.duration, 6);
    });
  });

  it('never produces a zero-sized buffer', () => {
    expect(packClipTable([]).byteLength).toBe(CLIP_RECORD_BYTES);
  });
});
