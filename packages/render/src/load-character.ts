import {
  computeTintMask,
  createTestRig,
  isMesh,
  makeRigidSkin,
  maxInfluences,
  mergeCharacterParts,
  pruneClipTracks,
  simplifyGeometry,
  TEST_RIG_LOOP_CLIP,
} from '@city/assets-runtime';
import {
  type AnimationClip,
  Box3,
  type BufferGeometry,
  Group,
  type Object3D,
  SkinnedMesh,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export interface CharacterSource {
  model: string;
  /** Scene root to clone per character. Its own position/rotation are reset to identity. */
  template: Object3D;
  /** Every clip in the asset; `clipIndex` is the one the scenario plays. */
  clips: AnimationClip[];
  clip: AnimationClip;
  clipIndex: number;
  /** Skinned meshes in traversal order. All share one skeleton (checked when baking). */
  meshes: SkinnedMesh[];
  /** Rest-pose height in metres, for grid spacing and camera framing. */
  height: number;
  /** Triangles drawn per character, after simplification. */
  triangles: number;
  /** Triangles as authored. */
  sourceTriangles: number;
  bones: number;
  /** Skin influences the vertex stage must fetch, per mesh: 1 for rigid parts, else 4. */
  influences: (1 | 4)[];
  /** True when rigid bone-parented parts (§7) or foreign skins were merged onto one skeleton. */
  mergedParts: boolean;
}

export interface LoadOptions {
  /** Simplify to about this many triangles (meshoptimizer). */
  targetTriangles?: number | undefined;
  /** Scale the character to this rest height in metres. */
  targetHeight?: number | undefined;
  /** Collapse skinning to one bone per vertex (the rigid robot variant). */
  rigid?: boolean | undefined;
  /** Derive the §4 tint mask (top / bottoms / skin / hair) from the skin weights. */
  tintMask?: boolean | undefined;
}

/** Model name that selects the built-in procedural test rig instead of a glTF file. */
export const TEST_RIG_MODEL = 'test-rig';

/**
 * Loads the character a scenario asks for: the procedural test rig, or any rigged GLB whose
 * animations target its own skeleton (e.g. three.js's Mixamo X Bot). `clipName` picks a clip;
 * without it a walk-like clip is preferred, then the first one.
 */
export async function loadCharacter(
  model: string,
  clipName: string | undefined,
  options: LoadOptions = {},
): Promise<CharacterSource> {
  const { targetTriangles } = options;
  let template: Object3D;
  let clips: AnimationClip[];
  let preferred: string | undefined = clipName;

  if (model === TEST_RIG_MODEL) {
    const rig = createTestRig();
    template = rig.root;
    clips = rig.clips;
    preferred ??= TEST_RIG_LOOP_CLIP;
  } else {
    const gltf = await new GLTFLoader().loadAsync(model);
    template = gltf.scene;
    clips = gltf.animations;
  }

  let clip = pickClip(clips, preferred);
  if (clip === undefined) {
    throw new Error(
      clipName === undefined
        ? `${model} has no animation clips`
        : `${model} has no clip named "${clipName}" (available: ${clips.map((c) => c.name).join(', ')})`,
    );
  }

  template.position.set(0, 0, 0);
  template.rotation.set(0, 0, 0);
  template.updateMatrixWorld(true);

  // Rigid bone-parented parts (robots) or parts with their own skins (Soldier's visor) are merged
  // onto one skeleton so the character bakes once.
  const mergedParts = hasRigidParts(template) || hasSeveralSkins(template);
  if (mergedParts) {
    mergeCharacterParts(template);
    // Face morph tracks target meshes the merge removed.
    const pruned = pruneClipTracks(template, clips);
    clip = pruned[clips.indexOf(clip)] ?? clip;
    clips = pruned;
  }

  if (options.targetHeight !== undefined) {
    // Scale inside a wrapper: the bake works in the wrapper's space, so strides, bounds and
    // heights all come out in metres without any per-instance scale.
    const rest = new Box3().setFromObject(template, true);
    template.scale.multiplyScalar(options.targetHeight / Math.max(1e-6, rest.max.y - rest.min.y));
    const wrapper = new Group();
    wrapper.name = `${template.name || 'character'}_scaled`;
    wrapper.add(template);
    template = wrapper;
    template.updateMatrixWorld(true);
  }

  let bones = 0;
  const meshes: SkinnedMesh[] = [];
  template.traverse((node) => {
    if (!(node instanceof SkinnedMesh)) return;
    meshes.push(node as SkinnedMesh);
    bones = Math.max(bones, (node as SkinnedMesh).skeleton.bones.length);
  });
  if (options.rigid === true) {
    for (const mesh of meshes) mesh.geometry = makeRigidSkin(mesh.geometry);
  }
  const influences = meshes.map((mesh) => (maxInfluences(mesh.geometry) <= 1 ? 1 : 4));
  if (options.tintMask === true) {
    for (const mesh of meshes) computeTintMask(mesh);
  }

  const sourceTriangles = meshes.reduce((sum, mesh) => sum + triangleCount(mesh.geometry), 0);
  let triangles = sourceTriangles;
  if (targetTriangles !== undefined && targetTriangles < sourceTriangles) {
    // Every sub-mesh keeps its share of the budget. Geometry is replaced on the template, so
    // Path A's clones and Path B's instanced meshes draw the same reduced mesh.
    triangles = 0;
    for (const mesh of meshes) {
      const share = (triangleCount(mesh.geometry) / sourceTriangles) * targetTriangles;
      const simplified = await simplifyGeometry(mesh.geometry, share);
      mesh.geometry = simplified.geometry;
      triangles += simplified.triangles;
    }
  }
  if (bones === 0) throw new Error(`${model} contains no skinned mesh`);

  const bounds = new Box3().setFromObject(template, true);
  return {
    model,
    template,
    clips,
    clip,
    clipIndex: clips.indexOf(clip),
    meshes,
    height: Math.max(0.1, bounds.max.y - bounds.min.y),
    triangles,
    sourceTriangles,
    bones,
    influences,
    mergedParts,
  };
}

function hasSeveralSkins(root: Object3D): boolean {
  const skeletons = new Set<unknown>();
  root.traverse((node) => {
    if (node instanceof SkinnedMesh) {
      const bones = (node as SkinnedMesh).skeleton.bones;
      skeletons.add(bones.map((bone) => bone.uuid).join());
    }
  });
  return skeletons.size > 1;
}

/** Plain meshes hanging under bones: a rigid rig, as in most mechanical robots. */
function hasRigidParts(root: Object3D): boolean {
  let found = false;
  root.traverse((node) => {
    if (found || !isMesh(node) || node instanceof SkinnedMesh) return;
    for (let parent = node.parent; parent !== null; parent = parent.parent) {
      if ((parent as { isBone?: boolean }).isBone === true) {
        found = true;
        return;
      }
    }
  });
  return found;
}

function triangleCount(geometry: BufferGeometry): number {
  return (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;
}

function pickClip(
  clips: readonly AnimationClip[],
  name: string | undefined,
): AnimationClip | undefined {
  if (name !== undefined) return clips.find((clip) => clip.name === name);
  return clips.find((clip) => /walk/i.test(clip.name)) ?? clips[0];
}
