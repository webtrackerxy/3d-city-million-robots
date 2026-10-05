import {
  AnimationClip,
  BufferAttribute,
  BufferGeometry,
  type Material,
  Matrix4,
  type Mesh,
  type Object3D,
  PropertyBinding,
  SkinnedMesh,
} from 'three';

/**
 * Brings every visible part of a character onto one skeleton and bind pose, so the crowd
 * pipeline can bake it once and instance it:
 *
 * - rigid robot rigs (§7): meshes parented to a bone become skinned to that bone, weight 1.0;
 * - foreign skins (e.g. a visor with its own 2-joint skin over the same bones) are re-indexed onto
 *   the reference skeleton;
 * - already-matching skinned meshes keep their weights;
 * - all parts are merged into one skinned mesh per material (§4: one mesh, one material).
 *
 * The reference skin is the one with the most bones. Positions are moved into its bind space, so
 * skinning reproduces each part's original transform under any animation.
 */
export function mergeCharacterParts(root: Object3D): SkinnedMesh[] {
  root.updateMatrixWorld(true);

  let reference: SkinnedMesh | undefined;
  root.traverse((node) => {
    if (!(node instanceof SkinnedMesh)) return;
    const candidate = node as SkinnedMesh;
    if (
      reference === undefined ||
      candidate.skeleton.bones.length > reference.skeleton.bones.length
    ) {
      reference = candidate;
    }
  });
  if (reference === undefined) throw new Error('mergeCharacterParts needs a skinned mesh');
  const skin = reference;
  const bones = skin.skeleton.bones;
  const boneIndex = new Map<Object3D, number>(bones.map((bone, index) => [bone, index]));

  type Part =
    | { mesh: Mesh; kind: 'skinned' }
    | { mesh: SkinnedMesh; kind: 'foreign'; remap: number[] }
    | { mesh: Mesh; kind: 'rigid'; bone: number };
  const parts: Part[] = [];
  root.traverse((node) => {
    if (!isMesh(node)) return;
    if (node instanceof SkinnedMesh) {
      const skinned = node as SkinnedMesh;
      if (sameSkin(skinned, skin)) parts.push({ mesh: skinned, kind: 'skinned' });
      else
        parts.push({ mesh: skinned, kind: 'foreign', remap: remapBones(skinned, skin, boneIndex) });
      return;
    }
    const bone = owningBone(node, boneIndex);
    if (bone !== undefined) parts.push({ mesh: node, kind: 'rigid', bone });
  });

  const bindInverse = skin.bindMatrix.clone().invert();
  const byMaterial = new Map<Material, BufferGeometry[]>();
  const toBind = new Matrix4();
  for (const part of parts) {
    const { mesh } = part;
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (material === undefined) continue;
    let geometry: BufferGeometry;
    if (part.kind === 'skinned') {
      geometry = pickAttributes(mesh.geometry);
    } else if (part.kind === 'foreign') {
      // Same bind pose per bone (checked), so only the mesh bind matrices differ.
      geometry = pickAttributes(mesh.geometry, part.remap);
      geometry.applyMatrix4(bindInverse.clone().multiply(part.mesh.bindMatrix));
    } else {
      const bone = part.bone;
      // v_bind = bindMatrix⁻¹ · boneInverse⁻¹ · boneWorld⁻¹ · partWorld · v
      const boneObject = bones[bone];
      const boneInverse = skin.skeleton.boneInverses[bone];
      if (boneObject === undefined || boneInverse === undefined) continue;
      toBind
        .copy(boneObject.matrixWorld)
        .invert()
        .premultiply(boneInverse.clone().invert())
        .premultiply(bindInverse)
        .multiply(mesh.matrixWorld);
      geometry = rigidlySkinned(mesh.geometry, toBind, bone);
    }
    const list = byMaterial.get(material) ?? [];
    list.push(geometry);
    byMaterial.set(material, list);
  }

  // Replace every original part with one merged skinned mesh per material.
  for (const { mesh } of parts) mesh.removeFromParent();
  const parent = skin.parent ?? root;
  const merged: SkinnedMesh[] = [];
  for (const [material, geometries] of byMaterial) {
    const mesh = new SkinnedMesh(mergeGeometries(geometries), material);
    mesh.name = `${material.name || 'part'}_merged`;
    mesh.bindMode = skin.bindMode;
    mesh.position.copy(skin.position);
    mesh.quaternion.copy(skin.quaternion);
    mesh.scale.copy(skin.scale);
    parent.add(mesh);
    mesh.updateMatrixWorld(true);
    mesh.bind(skin.skeleton, skin.bindMatrix);
    merged.push(mesh);
  }
  root.updateMatrixWorld(true);
  return merged;
}

/**
 * Drops animation tracks whose target node no longer exists (e.g. morph-target tracks for face
 * meshes that mergeCharacterParts removed). Returns new clips; the originals are untouched.
 */
export function pruneClipTracks(root: Object3D, clips: readonly AnimationClip[]): AnimationClip[] {
  return clips.map((clip) => {
    const tracks = clip.tracks.filter((track) => {
      const { nodeName } = PropertyBinding.parseTrackName(track.name);
      return PropertyBinding.findNode(root, nodeName) != null;
    });
    return new AnimationClip(clip.name, clip.duration, tracks, clip.blendMode);
  });
}

/**
 * Collapses skinning to one influence per vertex (the strongest bone, weight 1). The "rigid"
 * variant of §7: exact for mechanical parts, and it lets the vertex stage fetch one bone instead
 * of four.
 */
export function makeRigidSkin(geometry: BufferGeometry): BufferGeometry {
  const skinIndex = geometry.getAttribute('skinIndex');
  const skinWeight = geometry.getAttribute('skinWeight');
  const indices = new Uint16Array(skinIndex.count * 4);
  const weights = new Float32Array(skinIndex.count * 4);
  for (let i = 0; i < skinIndex.count; i++) {
    let best = 0;
    for (let k = 1; k < 4; k++) {
      if (skinWeight.getComponent(i, k) > skinWeight.getComponent(i, best)) best = k;
    }
    indices[i * 4] = skinIndex.getComponent(i, best);
    weights[i * 4] = 1;
  }
  const rigid = geometry.clone();
  rigid.setAttribute('skinIndex', new BufferAttribute(indices, 4));
  rigid.setAttribute('skinWeight', new BufferAttribute(weights, 4));
  return rigid;
}

/** Largest number of non-zero weights on any vertex. */
export function maxInfluences(geometry: BufferGeometry): number {
  const skinWeight = geometry.getAttribute('skinWeight');
  let max = 0;
  for (let i = 0; i < skinWeight.count; i++) {
    let used = 0;
    for (let k = 0; k < 4; k++) if (skinWeight.getComponent(i, k) > 0) used++;
    max = Math.max(max, used);
  }
  return max;
}

/** Runtime check: Three marks meshes with `isMesh`, which Object3D's type does not declare. */
export function isMesh(node: Object3D): node is Mesh {
  return (node as Partial<Mesh>).isMesh === true;
}

function owningBone(node: Object3D, boneIndex: Map<Object3D, number>): number | undefined {
  for (let current = node.parent; current !== null; current = current.parent) {
    const index = boneIndex.get(current);
    if (index !== undefined) return index;
  }
  return undefined;
}

/**
 * Maps a foreign skin's joint indices onto the reference skeleton. Every joint must be one of the
 * reference bones, bound in the same pose.
 */
function remapBones(
  mesh: SkinnedMesh,
  reference: SkinnedMesh,
  boneIndex: Map<Object3D, number>,
): number[] {
  return mesh.skeleton.bones.map((bone, joint) => {
    const index = boneIndex.get(bone);
    const ours = mesh.skeleton.boneInverses[joint];
    const theirs = index === undefined ? undefined : reference.skeleton.boneInverses[index];
    if (index === undefined || ours === undefined || theirs === undefined) {
      throw new Error(`"${mesh.name}" is skinned to bone "${bone.name}" outside the main skeleton`);
    }
    if (!ours.elements.every((v, i) => Math.abs(v - (theirs.elements[i] ?? 0)) < 1e-4)) {
      throw new Error(`"${mesh.name}" binds bone "${bone.name}" in a different pose`);
    }
    return index;
  });
}

function sameSkin(a: SkinnedMesh, b: SkinnedMesh): boolean {
  return (
    a.skeleton.bones.length === b.skeleton.bones.length &&
    a.skeleton.bones.every((bone, i) => bone === b.skeleton.bones[i]) &&
    a.bindMatrix.elements.every((v, i) => Math.abs(v - (b.bindMatrix.elements[i] ?? 0)) < 1e-6)
  );
}

/**
 * position, normal, uv, skinIndex, skinWeight and index only; morph targets and extra UV sets are
 * dropped. `remap` translates skin indices onto the reference skeleton.
 */
function pickAttributes(source: BufferGeometry, remap?: readonly number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  const skinIndex = source.getAttribute('skinIndex');
  const skinWeight = source.getAttribute('skinWeight');
  const indices = new Uint16Array(skinIndex.count * 4);
  const weights = new Float32Array(skinIndex.count * 4);
  for (let i = 0; i < skinIndex.count; i++) {
    for (let k = 0; k < 4; k++) {
      const joint = skinIndex.getComponent(i, k);
      indices[i * 4 + k] = remap === undefined ? joint : (remap[joint] ?? 0);
      weights[i * 4 + k] = skinWeight.getComponent(i, k);
    }
  }
  geometry.setAttribute(
    'position',
    copyFloat(source.getAttribute('position') as BufferAttribute, 3),
  );
  geometry.setAttribute('normal', copyFloat(source.getAttribute('normal') as BufferAttribute, 3));
  const uv = source.getAttribute('uv') as BufferAttribute | undefined;
  if (uv !== undefined) geometry.setAttribute('uv', copyFloat(uv, 2));
  geometry.setAttribute('skinIndex', new BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new BufferAttribute(weights, 4));
  geometry.setIndex(indexOf(source));
  return geometry;
}

function rigidlySkinned(source: BufferGeometry, toBind: Matrix4, bone: number): BufferGeometry {
  const geometry = pickAttributesRigid(source);
  geometry.applyMatrix4(toBind);
  const count = geometry.getAttribute('position').count;
  const indices = new Uint16Array(count * 4);
  const weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    indices[i * 4] = bone;
    weights[i * 4] = 1;
  }
  geometry.setAttribute('skinIndex', new BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new BufferAttribute(weights, 4));
  return geometry;
}

function pickAttributesRigid(source: BufferGeometry): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    copyFloat(source.getAttribute('position') as BufferAttribute, 3),
  );
  const normal = source.getAttribute('normal') as BufferAttribute | undefined;
  if (normal !== undefined) geometry.setAttribute('normal', copyFloat(normal, 3));
  const uv = source.getAttribute('uv') as BufferAttribute | undefined;
  if (uv !== undefined) geometry.setAttribute('uv', copyFloat(uv, 2));
  geometry.setIndex(indexOf(source));
  return geometry;
}

function copyFloat(attribute: BufferAttribute, itemSize: number): BufferAttribute {
  const out = new Float32Array(attribute.count * itemSize);
  for (let i = 0; i < attribute.count; i++) {
    for (let k = 0; k < itemSize; k++) out[i * itemSize + k] = attribute.getComponent(i, k);
  }
  return new BufferAttribute(out, itemSize);
}

function indexOf(source: BufferGeometry): BufferAttribute {
  const count = source.getAttribute('position').count;
  const index = source.index;
  return new BufferAttribute(
    index === null
      ? Uint32Array.from({ length: count }, (_, i) => i)
      : Uint32Array.from(index.array),
    1,
  );
}

function mergeGeometries(geometries: BufferGeometry[]): BufferGeometry {
  const names = ['position', 'normal', 'uv', 'skinIndex', 'skinWeight'] as const;
  const sizes = { position: 3, normal: 3, uv: 2, skinIndex: 4, skinWeight: 4 } as const;
  const vertexCount = geometries.reduce((n, g) => n + g.getAttribute('position').count, 0);
  const indexCount = geometries.reduce((n, g) => n + (g.index?.count ?? 0), 0);
  const merged = new BufferGeometry();
  const arrays = {
    position: new Float32Array(vertexCount * 3),
    normal: new Float32Array(vertexCount * 3),
    uv: new Float32Array(vertexCount * 2),
    skinIndex: new Uint16Array(vertexCount * 4),
    skinWeight: new Float32Array(vertexCount * 4),
  };
  const index = new Uint32Array(indexCount);
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const geometry of geometries) {
    const count = geometry.getAttribute('position').count;
    for (const name of names) {
      const attribute = geometry.getAttribute(name) as BufferAttribute | undefined;
      const target = arrays[name];
      const size = sizes[name];
      if (attribute === undefined) continue;
      for (let i = 0; i < count; i++) {
        for (let k = 0; k < size; k++) {
          target[(vertexOffset + i) * size + k] = attribute.getComponent(i, k);
        }
      }
    }
    const sourceIndex = geometry.index;
    if (sourceIndex !== null) {
      for (let i = 0; i < sourceIndex.count; i++) {
        index[indexOffset + i] = sourceIndex.getX(i) + vertexOffset;
      }
      indexOffset += sourceIndex.count;
    }
    vertexOffset += count;
  }
  merged.setAttribute('position', new BufferAttribute(arrays.position, 3));
  merged.setAttribute('normal', new BufferAttribute(arrays.normal, 3));
  if (geometries.some((g) => g.hasAttribute('uv'))) {
    merged.setAttribute('uv', new BufferAttribute(arrays.uv, 2));
  }
  merged.setAttribute('skinIndex', new BufferAttribute(arrays.skinIndex, 4));
  merged.setAttribute('skinWeight', new BufferAttribute(arrays.skinWeight, 4));
  merged.setIndex(new BufferAttribute(index, 1));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}
