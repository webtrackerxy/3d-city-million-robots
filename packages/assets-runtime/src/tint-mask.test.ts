import {
  Bone,
  CylinderGeometry,
  Float32BufferAttribute,
  MeshStandardMaterial,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
} from 'three';
import { describe, expect, it } from 'vitest';
import { computeTintMask, regionOfBone, TINT_MASK_ATTRIBUTE } from './tint-mask.ts';

describe('regionOfBone', () => {
  it('classifies Mixamo and generic humanoid bones', () => {
    expect(regionOfBone('LeftHandIndex2')).toBe(2); // skin, not arm
    expect(regionOfBone('LeftForeArm')).toBe(0);
    expect(regionOfBone('Spine2')).toBe(0);
    expect(regionOfBone('LeftUpLeg')).toBe(1);
    expect(regionOfBone('RightToeBase')).toBe(-1); // shoes keep the base colour
    expect(regionOfBone('Head')).toBe(2);
    expect(regionOfBone('PoleTargetL')).toBe(-1);
  });
});

describe('computeTintMask', () => {
  it('sums skin weights per region and marks the top of the head as hair', () => {
    // A column: legs (0–1 m), spine (1–1.6 m), head (1.6–1.9 m).
    const geometry = new CylinderGeometry(0.2, 0.2, 1.9, 6, 19);
    geometry.translate(0, 0.95, 0);
    const position = geometry.getAttribute('position');
    const indices: number[] = [];
    const weights: number[] = [];
    for (let i = 0; i < position.count; i++) {
      const y = position.getY(i);
      const bone = y < 1 ? 0 : y < 1.6 ? 1 : 2;
      indices.push(bone, 0, 0, 0);
      weights.push(1, 0, 0, 0);
    }
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(indices, 4));
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(weights, 4));
    const names = ['mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:Head', 'mixamorig:HeadTop_End'];
    const bones = names.map((name) => {
      const bone = new Bone();
      bone.name = name;
      return bone;
    });
    const [hips, spine, head, top] = bones as [Bone, Bone, Bone, Bone];
    spine.position.y = 1;
    head.position.y = 0.6;
    top.position.y = 0.3;
    hips.add(spine);
    spine.add(head);
    head.add(top);
    const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial());
    mesh.add(hips);
    mesh.updateMatrixWorld(true);
    mesh.bind(new Skeleton(bones));

    expect(computeTintMask(mesh)).toBe(1);
    const mask = geometry.getAttribute(TINT_MASK_ATTRIBUTE);
    const at = (y: number) => {
      for (let i = 0; i < position.count; i++) {
        if (Math.abs(position.getY(i) - y) < 1e-3) {
          return [0, 1, 2, 3].map((k) => Math.round(mask.getComponent(i, k) * 100) / 100);
        }
      }
      throw new Error(`no vertex at ${y}`);
    };
    expect(at(0.5)).toEqual([0, 1, 0, 0]); // bottoms
    expect(at(1.3)).toEqual([1, 0, 0, 0]); // top
    expect(at(1.7)).toEqual([0, 0, 1, 0]); // face: skin
    expect(at(1.9)).toEqual([0, 0, 0, 1]); // crown: hair
  });
});
