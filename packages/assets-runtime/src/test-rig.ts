import {
  AnimationClip,
  Bone,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  MeshStandardMaterial,
  Quaternion,
  QuaternionKeyframeTrack,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Vector3,
  VectorKeyframeTrack,
} from 'three';

export const TEST_RIG_HEIGHT = 3;
export const TEST_RIG_LOOP_CLIP = 'sway';
export const TEST_RIG_ONE_SHOT_CLIP = 'bow';

export interface TestRig {
  root: Group;
  mesh: SkinnedMesh;
  clips: AnimationClip[];
}

/**
 * A procedural stand-in for a character GLB: a 3-bone skinned column with two influences per
 * vertex, one looping and one one-shot clip. The armature carries a non-uniform scale and rotation
 * and the root a world offset, so tests exercise the full root-space matrix composition the way a
 * Mixamo export (0.01 armature scale, Y-up rotation) would.
 */
export function createTestRig(): TestRig {
  const segment = TEST_RIG_HEIGHT / 3;
  const geometry = new CylinderGeometry(0.3, 0.3, TEST_RIG_HEIGHT, 8, 12);
  geometry.translate(0, TEST_RIG_HEIGHT / 2, 0);

  const position = geometry.getAttribute('position');
  const skinIndex: number[] = [];
  const skinWeight: number[] = [];
  for (let i = 0; i < position.count; i++) {
    // Blend between the two nearest bones along the column.
    const u = Math.min(position.getY(i) / segment, 2 - 1e-6);
    const lower = Math.floor(u);
    const t = u - lower;
    const upper = Math.min(lower + 1, 2);
    skinIndex.push(lower, upper, 0, 0);
    skinWeight.push(1 - t, t, 0, 0);
  }
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(skinWeight, 4));

  const bones = ['base', 'middle', 'top'].map((name, index) => {
    const bone = new Bone();
    bone.name = name;
    if (index > 0) bone.position.y = segment;
    return bone;
  });
  const [base, middle, top] = bones as [Bone, Bone, Bone];
  base.add(middle);
  middle.add(top);

  const mesh = new SkinnedMesh(
    geometry,
    new MeshStandardMaterial({ color: 0x8fa3bf, roughness: 0.6 }),
  );
  mesh.name = 'column';
  mesh.add(base);

  const armature = new Group();
  armature.name = 'armature';
  armature.scale.set(0.5, 0.8, 0.5);
  armature.rotation.set(0.2, 0.7, -0.1);
  armature.add(mesh);

  const root = new Group();
  root.name = 'test-rig';
  root.position.set(4, -1, 2.5);
  root.rotation.y = 1.1;
  root.add(armature);

  root.updateMatrixWorld(true);
  mesh.bind(new Skeleton(bones));

  return { root, mesh, clips: [swayClip(), bowClip()] };
}

function swayClip(): AnimationClip {
  const duration = 1.2;
  const times = [0, 0.3, 0.6, 0.9, 1.2];
  const angles = [0, 0.5, 0, -0.5, 0];
  return new AnimationClip(TEST_RIG_LOOP_CLIP, duration, [
    rotationTrack('middle', times, new Vector3(0, 0, 1), angles),
    rotationTrack(
      'top',
      times,
      new Vector3(1, 0, 1).normalize(),
      angles.map((a) => -0.8 * a),
    ),
    new VectorKeyframeTrack('base.position', [0, 0.6, 1.2], [0, 0, 0, 0.1, 0.15, 0, 0, 0, 0]),
  ]);
}

function bowClip(): AnimationClip {
  const times = [0, 0.4, 0.8];
  return new AnimationClip(TEST_RIG_ONE_SHOT_CLIP, 0.8, [
    rotationTrack('middle', times, new Vector3(1, 0, 0), [0, 0.6, 0.9]),
    rotationTrack('top', times, new Vector3(1, 0, 0), [0, 0.3, 0.7]),
  ]);
}

function rotationTrack(
  bone: string,
  times: number[],
  axis: Vector3,
  angles: number[],
): QuaternionKeyframeTrack {
  const q = new Quaternion();
  const values = angles.flatMap((angle) => q.setFromAxisAngle(axis, angle).toArray());
  return new QuaternionKeyframeTrack(`${bone}.quaternion`, times, values);
}
