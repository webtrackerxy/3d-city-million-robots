import { BufferAttribute, Matrix4, type SkinnedMesh, Vector3 } from 'three';

/**
 * Tint regions of the §4 ID-mask convention: x top, y bottoms, z skin, w hair.
 *
 * Authored characters carry these in a mask texture. Placeholders without one get this
 * approximation derived from their skin weights: every bone belongs to a body region, and each
 * vertex's mask is its weights summed per region, so region borders blend across joints exactly
 * as the mesh deforms. Hair is the upper part of the head.
 */
export const TINT_MASK_ATTRIBUTE = 'tintMask';

const Region = { None: -1, Top: 0, Bottoms: 1, Skin: 2, Hair: 3 } as const;

/** First match wins; order matters (hands before arms, feet before legs). */
const REGION_RULES: readonly [RegExp, number][] = [
  [/hand|thumb|index|middle|ring|pinky|finger|palm/i, Region.Skin],
  [/foot|toe|ankle/i, Region.None],
  [/head|neck|jaw|eye/i, Region.Skin],
  [/spine|chest|shoulder|clavicle|arm|torso|abdomen/i, Region.Top],
  [/hips|pelvis|upleg|thigh|leg|knee/i, Region.Bottoms],
];

/** Head vertices this far from the head bone towards the head top count as hair (0–1). */
const HAIR_LINE = 0.55;

export function regionOfBone(name: string): number {
  for (const [pattern, region] of REGION_RULES) if (pattern.test(name)) return region;
  return Region.None;
}

/**
 * Writes the `tintMask` attribute (vec4, sums to ≤ 1) onto the mesh's geometry. Returns the
 * fraction of vertices that received any tint, as a sanity check.
 */
export function computeTintMask(mesh: SkinnedMesh): number {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  const skinIndex = geometry.getAttribute('skinIndex');
  const skinWeight = geometry.getAttribute('skinWeight');
  const bones = mesh.skeleton.bones;
  const regions = bones.map((bone) => regionOfBone(bone.name.replace(/^mixamorig:?/i, '')));

  // Head axis in the mesh's bind space, for the hair line.
  const bindInverse = mesh.bindMatrix.clone().invert();
  const pivot = (index: number): Vector3 | undefined => {
    const inverse = mesh.skeleton.boneInverses[index];
    if (inverse === undefined) return undefined;
    return new Vector3().setFromMatrixPosition(
      new Matrix4().copy(inverse).invert().premultiply(bindInverse),
    );
  };
  const headIndex = bones.findIndex((bone) => /head$/i.test(bone.name));
  const topIndex = bones.findIndex((bone) => /head_?top/i.test(bone.name));
  const head = headIndex >= 0 ? pivot(headIndex) : undefined;
  let headTop = topIndex >= 0 ? pivot(topIndex) : undefined;
  if (head !== undefined && headTop === undefined)
    headTop = head.clone().add(new Vector3(0, 0.2, 0));
  const axis = head !== undefined && headTop !== undefined ? headTop.clone().sub(head) : undefined;
  const axisLengthSq = axis?.lengthSq() ?? 1;

  const mask = new Float32Array(position.count * 4);
  const vertex = new Vector3();
  let tinted = 0;
  for (let i = 0; i < position.count; i++) {
    vertex.fromBufferAttribute(position, i);
    let any = false;
    for (let k = 0; k < 4; k++) {
      const weight = skinWeight.getComponent(i, k);
      if (weight === 0) continue;
      let region = regions[skinIndex.getComponent(i, k)] ?? Region.None;
      if (region === Region.Skin && head !== undefined && axis !== undefined) {
        const isHeadBone = /head|eye/i.test(bones[skinIndex.getComponent(i, k)]?.name ?? '');
        const along = vertex.clone().sub(head).dot(axis) / axisLengthSq;
        if (isHeadBone && along > HAIR_LINE) region = Region.Hair;
      }
      if (region === Region.None) continue;
      mask[i * 4 + region] = (mask[i * 4 + region] ?? 0) + weight;
      any = true;
    }
    if (any) tinted++;
  }
  // unorm8 × 4: 4 bytes per vertex instead of 16, read as vec4 in the shader.
  const packed = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) packed[i] = Math.round(Math.min(1, mask[i] ?? 0) * 255);
  geometry.setAttribute(TINT_MASK_ATTRIBUTE, new BufferAttribute(packed, 4, true));
  return position.count === 0 ? 0 : tinted / position.count;
}
