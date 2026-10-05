import { ClipPoser, TINT_MASK_ATTRIBUTE } from '@city/assets-runtime';
import {
  type AnimationClip,
  Box3,
  type BufferGeometry,
  Color,
  LinearFilter,
  type Material,
  MeshStandardMaterial,
  NoBlending,
  type Object3D,
  OrthographicCamera,
  RGBAFormat,
  Scene,
  SkinnedMesh,
  type Texture,
  UnsignedByteType,
  Vector3,
} from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { attribute, float, normalWorld, texture, uv, vec3, vec4 } from 'three/tsl';
import { MeshBasicNodeMaterial, RenderTarget, type WebGPURenderer } from 'three/webgpu';

/**
 * Impostor atlas layout (implementation plan §9 step 6, §17). Tile index
 *   ((frame × pitches) + pitch) × yaws + yaw
 * laid out row-major, `columns` tiles per row. Yaw 0 looks at the character's +Z side; yaw steps
 * go counter-clockwise seen from above. Frames sample one cycle of the clip uniformly.
 */
export const IMPOSTOR_YAWS = 16;
export const IMPOSTOR_PITCHES = [5, 30] as const;
export const IMPOSTOR_FRAMES = 8;
export const IMPOSTOR_TILE = { width: 64, height: 128 } as const;
const COLUMNS = 32;

export interface ImpostorAtlas {
  /** Unlit base colour (albedo × map), alpha = coverage. */
  albedo: Texture;
  /** Object-space normal × 0.5 + 0.5. */
  normal: Texture;
  /** §4 tint mask (top, bottoms, skin, hair); zero for untinted families. */
  mask: Texture;
  columns: number;
  rows: number;
  /** World size of a tile's view volume, metres: width, height, and the bottom edge's y. */
  quad: { width: number; height: number; bottom: number };
  /** Mean luminance of the baked albedo, the reference for relative-luminance tinting. */
  referenceLuminance: number;
  bakeMs: number;
  bytes: number;
}

export interface ImpostorSource {
  template: Object3D;
  clip: AnimationClip;
  /** LOD2 geometry per sub-mesh, in the order of `meshes` below (§17: bake from LOD2). */
  geometries: BufferGeometry[];
  meshes: SkinnedMesh[];
  height: number;
}

/**
 * Renders the atlas on the GPU at load time: three passes (albedo, normal, mask) over every
 * (frame, pitch, yaw) tile, each into its own viewport of one render target per channel.
 */
export function bakeImpostors(renderer: WebGPURenderer, source: ImpostorSource): ImpostorAtlas {
  const started = performance.now();
  const tiles = IMPOSTOR_FRAMES * IMPOSTOR_PITCHES.length * IMPOSTOR_YAWS;
  const rows = Math.ceil(tiles / COLUMNS);
  const width = COLUMNS * IMPOSTOR_TILE.width;
  const heightPx = rows * IMPOSTOR_TILE.height;

  // A private copy of the character with LOD2 geometry, posed by one mixer.
  const character = cloneSkinned(source.template);
  character.position.set(0, 0, 0);
  character.rotation.set(0, 0, 0);
  const meshes: SkinnedMesh[] = [];
  character.traverse((node) => {
    if (node instanceof SkinnedMesh) meshes.push(node as SkinnedMesh);
  });
  meshes.forEach((mesh, index) => {
    const lod2 = source.geometries[index];
    if (lod2 !== undefined) mesh.geometry = lod2;
    mesh.frustumCulled = false;
  });
  const scene = new Scene();
  scene.add(character);

  // View volume: a little taller than the character, half as wide as tall (tile aspect 1:2).
  const bounds = new Box3().setFromObject(character, true);
  const quadHeight = source.height * 1.12;
  const quad = {
    width: quadHeight / 2,
    height: quadHeight,
    bottom: bounds.min.y - source.height * 0.04,
  };
  const camera = new OrthographicCamera(
    -quad.width / 2,
    quad.width / 2,
    quad.height / 2,
    -quad.height / 2,
    0.01,
    source.height * 10,
  );
  const centreY = quad.bottom + quad.height / 2;

  const passes = {
    albedo: meshes.map((mesh) => albedoMaterial(mesh.material)),
    normal: meshes.map(() => {
      const material = new MeshBasicNodeMaterial();
      material.colorNode = normalWorld.mul(0.5).add(0.5);
      return material;
    }),
    mask: meshes.map((mesh) => {
      const material = new MeshBasicNodeMaterial();
      material.colorNode = mesh.geometry.hasAttribute(TINT_MASK_ATTRIBUTE)
        ? attribute(TINT_MASK_ATTRIBUTE, 'vec4').xyz
        : vec3(0, 0, 0);
      // Hair (w) rides in alpha; coverage comes from the albedo pass.
      material.opacityNode = mesh.geometry.hasAttribute(TINT_MASK_ATTRIBUTE)
        ? attribute(TINT_MASK_ATTRIBUTE, 'vec4').w
        : float(0);
      // Write alpha as computed: opaque materials would force it to 1, blending would mix it.
      material.transparent = true;
      material.blending = NoBlending;
      material.depthWrite = true;
      return material;
    }),
  };
  const originals = meshes.map((mesh) => mesh.material);

  const targets = {
    albedo: atlasTarget(width, heightPx),
    normal: atlasTarget(width, heightPx),
    mask: atlasTarget(width, heightPx),
  };

  const poser = new ClipPoser(character);
  const previousTarget = renderer.getRenderTarget();
  const previousClear = renderer.getClearColor(new Color());
  const previousAlpha = renderer.getClearAlpha();
  const previousAutoClear = renderer.autoClear;
  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 0);
  try {
    for (const target of Object.values(targets)) {
      target.viewport.set(0, 0, width, heightPx);
      target.scissorTest = false;
      renderer.setRenderTarget(target);
      renderer.clear();
    }
    for (let frame = 0; frame < IMPOSTOR_FRAMES; frame++) {
      poser.pose(source.clip, (frame / IMPOSTOR_FRAMES) * source.clip.duration, true);
      for (let pitch = 0; pitch < IMPOSTOR_PITCHES.length; pitch++) {
        const elevation = ((IMPOSTOR_PITCHES[pitch] ?? 0) * Math.PI) / 180;
        for (let yaw = 0; yaw < IMPOSTOR_YAWS; yaw++) {
          const azimuth = (yaw / IMPOSTOR_YAWS) * Math.PI * 2;
          const distance = source.height * 4;
          camera.position.set(
            Math.sin(azimuth) * Math.cos(elevation) * distance,
            centreY + Math.sin(elevation) * distance,
            Math.cos(azimuth) * Math.cos(elevation) * distance,
          );
          camera.lookAt(new Vector3(0, centreY, 0));
          camera.updateMatrixWorld();

          const tile = (frame * IMPOSTOR_PITCHES.length + pitch) * IMPOSTOR_YAWS + yaw;
          const x = (tile % COLUMNS) * IMPOSTOR_TILE.width;
          // Render-target viewports count from the top in WebGPU.
          const y = Math.floor(tile / COLUMNS) * IMPOSTOR_TILE.height;
          for (const [name, materials] of Object.entries(passes)) {
            const target = targets[name as keyof typeof targets];
            meshes.forEach((mesh, index) => {
              mesh.material = materials[index] ?? mesh.material;
            });
            target.viewport.set(x, y, IMPOSTOR_TILE.width, IMPOSTOR_TILE.height);
            target.scissor.set(x, y, IMPOSTOR_TILE.width, IMPOSTOR_TILE.height);
            target.scissorTest = true;
            renderer.setRenderTarget(target);
            renderer.render(scene, camera);
          }
        }
      }
    }
  } finally {
    poser.dispose();
    meshes.forEach((mesh, index) => {
      mesh.material = originals[index] ?? mesh.material;
    });
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousClear, previousAlpha);
    renderer.autoClear = previousAutoClear;
    for (const materials of Object.values(passes)) {
      for (const material of materials) material.dispose();
    }
  }

  return {
    albedo: targets.albedo.texture,
    normal: targets.normal.texture,
    mask: targets.mask.texture,
    columns: COLUMNS,
    rows,
    quad,
    referenceLuminance: meanLuminance(meshes.map((mesh) => mesh.material)),
    bakeMs: performance.now() - started,
    bytes: width * heightPx * 4 * 3,
  };
}

function atlasTarget(width: number, height: number): RenderTarget {
  const target = new RenderTarget(width, height, {
    format: RGBAFormat,
    type: UnsignedByteType,
    depthBuffer: true,
    generateMipmaps: false,
  });
  target.texture.minFilter = LinearFilter;
  target.texture.magFilter = LinearFilter;
  return target;
}

function albedoMaterial(source: Material | Material[]): MeshBasicNodeMaterial {
  const first = Array.isArray(source) ? source[0] : source;
  const material = new MeshBasicNodeMaterial();
  const colour = first instanceof MeshStandardMaterial ? first.color : new Color(0x8fa3bf);
  const base = vec3(colour.r, colour.g, colour.b);
  const map = first instanceof MeshStandardMaterial ? first.map : null;
  material.colorNode = map === null ? vec4(base, 1) : vec4(texture(map, uv()).rgb.mul(base), 1);
  return material;
}

function meanLuminance(materials: (Material | Material[])[]): number {
  const values = materials.map((source) => {
    const first = Array.isArray(source) ? source[0] : source;
    if (!(first instanceof MeshStandardMaterial)) return 0.5;
    if (first.map !== null) return 0.45;
    const c = first.color;
    return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  });
  return Math.max(0.05, values.reduce((a, b) => a + b, 0) / Math.max(1, values.length));
}
