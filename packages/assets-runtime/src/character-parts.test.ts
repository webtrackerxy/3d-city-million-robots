import {
  AnimationClip,
  Bone,
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  NumberKeyframeTrack,
  Quaternion,
  QuaternionKeyframeTrack,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Float32BufferAttribute,
  Vector3,
} from 'three';
import { describe, expect, it } from 'vitest';
import { bakeAnimations } from './bake-animations.ts';
import { ClipPoser } from './clip-poser.ts';
import {
  isMesh,
  makeRigidSkin,
  maxInfluences,
  mergeCharacterParts,
  pruneClipTracks,
} from './character-parts.ts';
import { verifyBake } from './verify-bake.ts';

const metal = new MeshStandardMaterial({ name: 'metal' });
const paint = new MeshStandardMaterial({ name: 'paint' });

/**
 * A two-bone arm like RobotExpressive: a rigid box parented (through an offset group) to the
 * forearm bone, a rigid box on the upper arm, and one genuinely skinned "hand".
 */
function rigidRobot() {
  const root = new Group();
  root.position.set(1, 0, -2);
  const upper = new Bone();
  upper.name = 'upper';
  const lower = new Bone();
  lower.name = 'lower';
  lower.position.set(0, 1, 0);
  upper.add(lower);
  root.add(upper);

  const upperPart = new Mesh(new BoxGeometry(0.2, 1, 0.2), paint);
  upperPart.position.set(0, 0.5, 0);
  upper.add(upperPart);
  const offset = new Group();
  offset.position.set(0.1, 0.3, 0);
  offset.rotation.z = 0.4;
  lower.add(offset);
  const lowerPart = new Mesh(new BoxGeometry(0.15, 0.6, 0.15), metal);
  offset.add(lowerPart);

  const handGeometry = new BoxGeometry(0.1, 0.1, 0.1, 1, 2, 1);
  handGeometry.translate(0, 1.8, 0);
  const count = handGeometry.getAttribute('position').count;
  handGeometry.setAttribute(
    'skinIndex',
    new Uint16BufferAttribute(
      new Array(count * 4).fill(0).map((_, i) => (i % 4 === 1 ? 1 : 0)),
      4,
    ),
  );
  handGeometry.setAttribute(
    'skinWeight',
    new Float32BufferAttribute(
      new Array(count * 4).fill(0).map((_, i) => (i % 4 === 0 ? 0.3 : i % 4 === 1 ? 0.7 : 0)),
      4,
    ),
  );
  const hand = new SkinnedMesh(handGeometry, metal);
  root.add(hand);
  root.updateMatrixWorld(true);
  hand.bind(new Skeleton([upper, lower]));

  const q = (axis: Vector3, angle: number) =>
    new Quaternion().setFromAxisAngle(axis, angle).toArray();
  const clip = new AnimationClip('wave', 1, [
    new QuaternionKeyframeTrack(
      'upper.quaternion',
      [0, 0.5, 1],
      [
        ...q(new Vector3(0, 0, 1), 0),
        ...q(new Vector3(0, 0, 1), 0.6),
        ...q(new Vector3(0, 0, 1), 0),
      ],
    ),
    new QuaternionKeyframeTrack(
      'lower.quaternion',
      [0, 0.5, 1],
      [
        ...q(new Vector3(1, 0, 0), 0),
        ...q(new Vector3(1, 0, 0), -0.9),
        ...q(new Vector3(1, 0, 0), 0),
      ],
    ),
  ]);
  return { root, clip, lowerPart, upperPart };
}

describe('mergeCharacterParts', () => {
  it('merges parts into one skinned mesh per material', () => {
    const { root } = rigidRobot();
    const merged = mergeCharacterParts(root);
    expect(new Set(merged.map((m) => m.material))).toEqual(new Set([paint, metal]));
    let meshes = 0;
    root.traverse((node) => {
      if (isMesh(node)) meshes++;
    });
    expect(meshes).toBe(2);
    const metalMesh = merged.find((m) => m.material === metal);
    expect(metalMesh?.geometry.getAttribute('position').count).toBe(24 + 32);
  });

  it('reproduces the rigid parts under animation', () => {
    const { root, clip, lowerPart } = rigidRobot();
    const poser = new ClipPoser(root);
    // Where the forearm part's first vertex goes at t = 0.5, before conversion.
    poser.pose(clip, 0.5, true);
    const vertex = new Vector3().fromBufferAttribute(
      lowerPart.geometry.getAttribute('position'),
      0,
    );
    const expected = vertex.clone().applyMatrix4(lowerPart.matrixWorld);
    poser.dispose();

    const merged = mergeCharacterParts(root);
    const metalMesh = merged.find((m) => m.material === metal);
    if (metalMesh === undefined) throw new Error('missing merged mesh');
    const after = new ClipPoser(root);
    after.pose(clip, 0.5, true);
    // The forearm part's vertices come first in the metal mesh (traversal order).
    const actual = metalMesh
      .getVertexPosition(0, new Vector3())
      .applyMatrix4(metalMesh.matrixWorld);
    expect(actual.distanceTo(expected)).toBeLessThan(1e-5);
    after.dispose();

    const baked = bakeAnimations(root, metalMesh, [clip]);
    const check = verifyBake(root, metalMesh, [clip], baked, { poses: 8, seed: 2 });
    expect(check.maxError).toBeLessThan(1e-4);
  });
});

describe('foreign skins', () => {
  it('re-indexes a mesh skinned to its own skeleton over the same bones', () => {
    const { root, clip } = rigidRobot();
    let lower: Bone | undefined;
    root.traverse((node) => {
      if (node.name === 'lower') lower = node as Bone;
    });
    if (lower === undefined) throw new Error('missing bone');
    // A "visor": its own one-joint skin on the forearm, bound in the same pose.
    const visorGeometry = new BoxGeometry(0.05, 0.05, 0.05);
    visorGeometry.translate(0.2, 1.4, 0);
    const n = visorGeometry.getAttribute('position').count;
    visorGeometry.setAttribute('skinIndex', new Uint16BufferAttribute(new Array(n * 4).fill(0), 4));
    visorGeometry.setAttribute(
      'skinWeight',
      new Float32BufferAttribute(
        new Array(n * 4).fill(0).map((_, i) => (i % 4 === 0 ? 1 : 0)),
        4,
      ),
    );
    const visorMaterial = new MeshStandardMaterial({ name: 'visor' });
    const visor = new SkinnedMesh(visorGeometry, visorMaterial);
    root.add(visor);
    root.updateMatrixWorld(true);
    visor.bind(new Skeleton([lower]));

    const poser = new ClipPoser(root);
    poser.pose(clip, 0.5, true);
    const expected = visor.getVertexPosition(0, new Vector3()).applyMatrix4(visor.matrixWorld);
    poser.dispose();

    const merged = mergeCharacterParts(root).find((m) => m.material === visorMaterial);
    if (merged === undefined) throw new Error('visor not merged');
    expect(merged.skeleton.bones).toHaveLength(2);
    expect(merged.geometry.getAttribute('skinIndex').getX(0)).toBe(1);
    const after = new ClipPoser(root);
    after.pose(clip, 0.5, true);
    const actual = merged.getVertexPosition(0, new Vector3()).applyMatrix4(merged.matrixWorld);
    expect(actual.distanceTo(expected)).toBeLessThan(1e-5);
    after.dispose();
  });
});

describe('pruneClipTracks', () => {
  it('drops tracks for nodes that no longer exist and keeps the rest', () => {
    const { root, clip } = rigidRobot();
    const withMorph = new AnimationClip('wave', 1, [
      ...clip.tracks,
      new NumberKeyframeTrack('Head_2.morphTargetInfluences[0]', [0, 1], [0, 1]),
    ]);
    const [pruned] = pruneClipTracks(root, [withMorph]);
    expect(pruned?.tracks.map((t) => t.name)).toEqual(['upper.quaternion', 'lower.quaternion']);
    expect(withMorph.tracks).toHaveLength(3);
  });
});

describe('makeRigidSkin', () => {
  it('keeps only the strongest bone at weight 1', () => {
    const { root } = rigidRobot();
    const metalMesh = mergeCharacterParts(root).find((m) => m.material === metal);
    if (metalMesh === undefined) throw new Error('missing merged mesh');
    expect(maxInfluences(metalMesh.geometry)).toBe(2);
    const rigid = makeRigidSkin(metalMesh.geometry);
    expect(maxInfluences(rigid)).toBe(1);
    const last = rigid.getAttribute('position').count - 1; // a hand vertex: 0.3 upper / 0.7 lower
    expect(rigid.getAttribute('skinIndex').getX(last)).toBe(1);
    expect(rigid.getAttribute('skinWeight').getX(last)).toBe(1);
  });
});
